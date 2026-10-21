/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdvertisingSyncStatus, LeadStage, UserRole } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  CorrectLeadStageDto,
  LeadStageCorrectionReasonCode,
} from './dto/correct-lead-stage.dto';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

const request = {
  expectedCurrentStage: LeadStage.QUALIFIED,
  targetStage: LeadStage.CONTACTED,
  reasonCode: LeadStageCorrectionReasonCode.TEST_CORRECTION,
  reason: 'Calificación de prueba errónea',
  requestKey: '795fe121-4fef-435c-b24a-af7d9fb62b44',
};

function harness(
  jobStatus: AdvertisingSyncStatus | null = AdvertisingSyncStatus.PENDING,
) {
  const state = {
    stage: LeadStage.QUALIFIED,
    stored: null as Record<string, unknown> | null,
  };
  const job = jobStatus
    ? {
        id: 'job-1',
        status: jobStatus,
        attempts: 0,
        googleRequestId: null,
        submittedAt: null,
        validateOnly: false,
      }
    : null;
  const conversion = { id: 'conversion-1', syncJob: job, invalidatedAt: null };
  const tx = {
    $executeRaw: jest.fn(),
    lead: {
      findUnique: jest
        .fn()
        .mockImplementation(({ select }: { select?: unknown }) =>
          Promise.resolve(
            select
              ? { contactId: 'contact-1' }
              : { id: 'lead-1', contactId: 'contact-1', stage: state.stage },
          ),
        ),
      updateMany: jest
        .fn()
        .mockImplementation(
          ({
            where,
            data,
          }: {
            where: { stage: LeadStage };
            data: { stage: LeadStage };
          }) => {
            if (state.stage !== where.stage) return { count: 0 };
            state.stage = data.stage;
            return { count: 1 };
          },
        ),
    },
    leadStageCorrection: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(state.stored)),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          state.stored = data;
          return Promise.resolve(data);
        }),
    },
    advertisingConversion: {
      findFirst: jest.fn().mockResolvedValue(conversion),
      update: jest.fn().mockResolvedValue(conversion),
    },
    advertisingSyncJob: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    leadStageCorrection: {
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(state.stored)),
    },
  };
  const service = new LeadsService(
    prisma as unknown as PrismaService,
    { emit: jest.fn() } as unknown as EventEmitter2,
    { isActive: jest.fn().mockReturnValue(false) } as unknown as ClsService,
    { get: jest.fn() } as unknown as ConfigService,
  );
  return { service, prisma, tx, state, job, conversion };
}

describe('ADMIN lead stage correction', () => {
  it('reserves the separate endpoint to ADMIN and validates its payload', async () => {
    const guard = new RolesGuard(new Reflector());
    const context = (role: UserRole) =>
      ({
        // eslint-disable-next-line @typescript-eslint/unbound-method
        getHandler: () => LeadsController.prototype.correctStage,
        getClass: () => LeadsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
    expect(guard.canActivate(context(UserRole.SALES_AGENT))).toBe(false);
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    await expect(
      pipe.transform(
        { ...request, reason: 'short' },
        { type: 'body', metatype: CorrectLeadStageDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { ...request, requestKey: 'not-a-uuid' },
        { type: 'body', metatype: CorrectLeadStageDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cancels a never-attempted job and records the actor, reason and immutable outcome', async () => {
    const { service, tx, state } = harness();
    const result = await service.correctStage('lead-1', request, 'admin-1');
    expect(result).toMatchObject({
      lead: { stage: LeadStage.CONTACTED },
      advertisingReconciliation: 'PENDING_CANCELLED',
    });
    expect(state.stage).toBe(LeadStage.CONTACTED);
    expect(tx.advertisingSyncJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AdvertisingSyncStatus.CANCELLED,
        }),
      }),
    );
    expect(tx.advertisingConversion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ invalidatedAt: expect.any(Date) }),
      }),
    );
    expect(tx.leadStageCorrection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          reason: request.reason,
          requestKey: request.requestKey,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'LEAD_STAGE_CORRECTED',
          changes: expect.objectContaining({ requestKey: request.requestKey }),
        }),
      }),
    );
    await expect(
      service.correctStage('lead-1', request, 'admin-1'),
    ).resolves.toEqual(result);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    await expect(
      service.correctStage(
        'lead-1',
        { ...request, reason: 'Otro motivo distinto' },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolves a concurrent request-key collision from the durable ledger', async () => {
    const { service, prisma, state } = harness(null);
    state.stored = {
      leadId: 'lead-1',
      actorUserId: 'admin-1',
      previousStage: request.expectedCurrentStage,
      targetStage: request.targetStage,
      reasonCode: request.reasonCode,
      reason: request.reason,
      result: { advertisingReconciliation: 'NO_EXTERNAL_EFFECT' },
    };
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.correctStage('lead-1', request, 'admin-1'),
    ).resolves.toEqual(state.stored.result);
    await expect(
      service.correctStage('another-lead', request, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires a fresh stage and rejects forward or no-op corrections', async () => {
    const { service, tx, state } = harness(null);
    state.stage = LeadStage.CONTACTED;
    await expect(
      service.correctStage('lead-1', request, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.correctStage(
        'lead-1',
        { ...request, targetStage: LeadStage.PROPOSAL },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.correctStage(
        'lead-1',
        { ...request, targetStage: LeadStage.QUALIFIED },
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses an in-flight worker without mutating the lead', async () => {
    const { service, tx, state } = harness(AdvertisingSyncStatus.RETRYING);
    await expect(
      service.correctStage('lead-1', request, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.stage).toBe(LeadStage.QUALIFIED);
    expect(tx.advertisingConversion.update).not.toHaveBeenCalled();
  });

  it('rejects the same backward move through the normal commercial endpoint', async () => {
    const { service, tx } = harness(null);
    await expect(
      service.update('lead-1', { stage: LeadStage.CONTACTED }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
  });

  it('does not update the stage or audit when pending-job cancellation fails', async () => {
    const { service, tx, state } = harness();
    tx.advertisingSyncJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.correctStage('lead-1', request, 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.stage).toBe(LeadStage.QUALIFIED);
    expect(tx.leadStageCorrection.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('marks a failed export ambiguous without retrying it', async () => {
    const { service, tx } = harness(AdvertisingSyncStatus.FAILED);
    const result = await service.correctStage('lead-1', request, 'admin-1');
    expect(result).toMatchObject({ advertisingReconciliation: 'AMBIGUOUS' });
    expect(tx.advertisingSyncJob.updateMany).not.toHaveBeenCalled();
  });

  it('preserves an accepted export and requires external reconciliation', async () => {
    const { service, tx } = harness(AdvertisingSyncStatus.ACCEPTED);
    const result = await service.correctStage('lead-1', request, 'admin-1');
    expect(result).toMatchObject({
      advertisingReconciliation: 'EXTERNAL_RECONCILIATION_REQUIRED',
    });
    expect(tx.advertisingSyncJob.updateMany).not.toHaveBeenCalled();
  });
});
