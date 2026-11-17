import { ConfigService } from '@nestjs/config';
import { AdvertisingEventType, LeadStage } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingService } from './advertising.service';
import { AdvertisingController } from './advertising.controller';
import { GoogleAdsReportingService } from './google-ads-reporting.service';

describe('operator first purchase', () => {
  function setup() {
    const tx = {
      $executeRaw: jest.fn(),
      lead: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'lead',
          contactId: 'contact',
          stage: LeadStage.QUALIFIED,
          contractedAmount: null,
          commercialCurrency: null,
          contractReference: null,
        }),
        update: jest.fn(),
      },
      transferPayment: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisingAttribution: { findFirst: jest.fn().mockResolvedValue(null) },
      advertisingConversion: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'conversion' }),
      },
      advertisingSyncJob: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const service = new AdvertisingService(
      { $transaction: jest.fn((fn) => fn(tx)) } as unknown as PrismaService,
      { get: jest.fn() } as unknown as ConfigService,
      {} as Queue,
    );
    jest.spyOn(service, 'prepareSync').mockResolvedValue(undefined);
    return { tx, service };
  }
  it('persists a valueless event and closes the qualified lead', async () => {
    const { tx, service } = setup();
    const result = await service.recordOperatorEvent(
      'lead',
      { eventType: AdvertisingEventType.CONTRACT_WON },
      'operator',
    );
    expect(result).toEqual({ id: 'conversion' });
    expect(tx.advertisingConversion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        value: undefined,
        currency: undefined,
        commercialReference: undefined,
        eventType: AdvertisingEventType.CONTRACT_WON,
      }),
    });
    expect(tx.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stage: LeadStage.WON }),
      }),
    );
    expect(tx.lead.update.mock.calls[0][0].data).not.toHaveProperty(
      'contractedAmount',
    );
    expect(tx.lead.update.mock.calls[0][0].data).not.toHaveProperty(
      'revenueReceived',
    );
    expect(tx.advertisingSyncJob.create).toHaveBeenCalledTimes(1);
  });
  it('preserves valued sales and rejects partial commercial data', async () => {
    const { tx, service } = setup();
    await service.recordOperatorEvent(
      'lead',
      {
        eventType: AdvertisingEventType.CONTRACT_WON,
        value: 100,
        currency: 'USD',
        commercialReference: 'ref',
      },
      'operator',
    );
    expect(Number(tx.lead.update.mock.calls[0][0].data.contractedAmount)).toBe(
      100,
    );
    await expect(
      service.recordOperatorEvent(
        'lead',
        { eventType: AdvertisingEventType.CONTRACT_WON, value: 100 },
        'operator',
      ),
    ).rejects.toThrow();
  });
  it('does not bypass transfer review', async () => {
    const { tx, service } = setup();
    tx.transferPayment.findFirst.mockResolvedValue({ id: 'transfer' });
    await expect(
      service.recordOperatorEvent(
        'lead',
        { eventType: AdvertisingEventType.CONTRACT_WON },
        'operator',
      ),
    ).rejects.toThrow('transferencia debe aprobarse desde Inbox');
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
  it.each([
    'INSTRUCTIONS_PREPARED',
    'INSTRUCTIONS_SENT',
    'PROOF_RECEIVED',
    'UNDER_REVIEW',
  ])('blocks CONTRACT_LOST for active transfer %s', async (status) => {
    const { tx, service } = setup();
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead',
      contactId: 'contact',
      stage: LeadStage.PAYMENT_PENDING,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
    });
    tx.transferPayment.findFirst.mockResolvedValue({ id: 'transfer', status });
    await expect(
      service.recordOperatorEvent(
        'lead',
        { eventType: AdvertisingEventType.CONTRACT_LOST },
        'operator',
      ),
    ).rejects.toThrow('transferencia debe aprobarse desde Inbox');
    expect(tx.$executeRaw.mock.calls[0][1]).toBe('contact');
    expect(tx.lead.update).not.toHaveBeenCalled();
    expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
    expect(tx.advertisingSyncJob.create).not.toHaveBeenCalled();
  });
  it('blocks CONTRACT_LOST from PAYMENT_REVIEW even if no open payment is found', async () => {
    const { tx, service } = setup();
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead',
      contactId: 'contact',
      stage: LeadStage.PAYMENT_REVIEW,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
    });
    await expect(
      service.recordOperatorEvent(
        'lead',
        { eventType: AdvertisingEventType.CONTRACT_LOST },
        'operator',
      ),
    ).rejects.toThrow('transferencia debe aprobarse desde Inbox');
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
  it('allows CONTRACT_LOST when PAYMENT_PENDING has no active transfer', async () => {
    const { tx, service } = setup();
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead',
      contactId: 'contact',
      stage: LeadStage.PAYMENT_PENDING,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
    });
    await service.recordOperatorEvent(
      'lead',
      { eventType: AdvertisingEventType.CONTRACT_LOST },
      'operator',
    );
    expect(tx.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stage: LeadStage.LOST }),
      }),
    );
    expect(tx.advertisingSyncJob.create).toHaveBeenCalledTimes(1);
  });
  it.each([0, 100])(
    'rejects isolated received revenue %s instead of inventing a contract',
    async (revenueReceived) => {
      const { tx, service } = setup();
      await expect(
        service.recordOperatorEvent(
          'lead',
          { eventType: AdvertisingEventType.CONTRACT_WON, revenueReceived },
          'operator',
        ),
      ).rejects.toThrow('CONTRACT_WON requires');
      expect(tx.lead.update).not.toHaveBeenCalled();
      expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
    },
  );
  it.each([0, 75])(
    'preserves actual received revenue %s when the entire contract is provided',
    async (revenueReceived) => {
      const { tx, service } = setup();
      await service.recordOperatorEvent(
        'lead',
        {
          eventType: AdvertisingEventType.CONTRACT_WON,
          value: 100,
          currency: 'USD',
          commercialReference: 'ref',
          revenueReceived,
        },
        'operator',
      );
      const data = tx.lead.update.mock.calls[0][0].data;
      expect(Number(data.contractedAmount)).toBe(100);
      expect(Number(data.revenueReceived)).toBe(revenueReceived);
    },
  );
  it.each([
    { stored: null, sent: 0, conflict: true },
    { stored: 0, sent: 25, conflict: true },
    { stored: 0, sent: 0, conflict: false },
    { stored: null, sent: undefined, conflict: false },
    { stored: 25, sent: undefined, conflict: false },
  ])(
    'checks received revenue on first-lead replay: $stored -> $sent',
    async ({ stored, sent, conflict }) => {
      const { tx, service } = setup();
      tx.lead.findUnique.mockResolvedValue({
        id: 'lead',
        contactId: 'contact',
        stage: LeadStage.WON,
        contractedAmount: 100,
        commercialCurrency: 'USD',
        contractReference: 'ref',
        revenueReceived: stored,
      });
      const existing = {
        id: 'conversion',
        leadId: 'lead',
        value: 100,
        currency: 'USD',
        commercialReference: 'ref',
        invalidatedAt: null,
        qualificationCycle: 0,
      };
      tx.advertisingConversion.findFirst.mockResolvedValue(existing);
      const dto = {
        eventType: AdvertisingEventType.CONTRACT_WON,
        value: 100,
        currency: 'USD',
        commercialReference: 'ref',
        ...(sent === undefined ? {} : { revenueReceived: sent }),
      };
      const operation = service.recordOperatorEvent('lead', dto, 'operator');
      if (conflict) await expect(operation).rejects.toThrow('immutable');
      else await expect(operation).resolves.toEqual(existing);
      expect(tx.lead.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).not.toHaveBeenCalled();
      expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
      expect(tx.advertisingSyncJob.create).not.toHaveBeenCalled();
      if (conflict) expect(service.prepareSync).not.toHaveBeenCalled();
    },
  );
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid received revenue %s even for a complete contract',
    async (revenueReceived) => {
      const { tx, service } = setup();
      await expect(
        service.recordOperatorEvent(
          'lead',
          {
            eventType: AdvertisingEventType.CONTRACT_WON,
            value: 100,
            currency: 'USD',
            commercialReference: 'ref',
            revenueReceived,
          },
          'operator',
        ),
      ).rejects.toThrow();
      expect(tx.lead.update).not.toHaveBeenCalled();
    },
  );
  it('closes a second lead once, returns explicit result and is idempotent on retry', async () => {
    const { tx, service } = setup();
    const lead = {
      id: 'lead',
      contactId: 'contact',
      stage: LeadStage.QUALIFIED,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
      revenueReceived: null,
    };
    tx.lead.findUnique.mockImplementation(async () => ({ ...lead }));
    tx.lead.update.mockImplementation(async ({ data }) => {
      Object.assign(lead, data);
      return lead;
    });
    tx.advertisingConversion.findFirst.mockResolvedValue({
      id: 'private-other-conversion',
      leadId: 'other-lead',
    });
    const dto = { eventType: AdvertisingEventType.CONTRACT_WON };
    const response = {
      leadId: 'lead',
      eventType: AdvertisingEventType.CONTRACT_WON,
      conversionCreated: false,
      reason: 'FIRST_PURCHASE_ALREADY_RECORDED',
    };
    await expect(
      service.recordOperatorEvent('lead', dto, 'operator'),
    ).resolves.toEqual(response);
    await expect(
      service.recordOperatorEvent('lead', dto, 'operator'),
    ).resolves.toEqual(response);
    expect(tx.lead.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.advertisingConversion.create).not.toHaveBeenCalled();
    expect(tx.advertisingSyncJob.create).not.toHaveBeenCalled();
    expect(service.prepareSync).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('private-other-conversion');
    await expect(
      service.recordOperatorEvent(
        'lead',
        {
          ...dto,
          value: 100,
          currency: 'USD',
          commercialReference: 'different',
        },
        'operator',
      ),
    ).rejects.toThrow('immutable');
  });
  it('passes through the explicit second purchase response at the controller', async () => {
    const response = {
      leadId: 'lead',
      eventType: AdvertisingEventType.CONTRACT_WON,
      conversionCreated: false,
      reason: 'FIRST_PURCHASE_ALREADY_RECORDED',
    };
    const advertising = {
      recordOperatorEvent: jest.fn().mockResolvedValue(response),
    };
    const controller = new AdvertisingController(
      advertising as unknown as AdvertisingService,
      {} as GoogleAdsReportingService,
    );
    const dto = { eventType: AdvertisingEventType.CONTRACT_WON };
    await expect(
      controller.recordEvent('lead', dto, 'operator'),
    ).resolves.toEqual(response);
    expect(advertising.recordOperatorEvent).toHaveBeenCalledWith(
      'lead',
      dto,
      'operator',
    );
  });
});
