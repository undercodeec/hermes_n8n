/* eslint-disable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
  -- The local lifecycle test uses stateful Prisma transaction doubles. */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createCipheriv, createHmac } from 'node:crypto';
import {
  AdvertisingConsentChoice,
  AdvertisingEventType,
  ConversationStatus,
  LeadStage,
  MessageDirection,
  MessageSender,
  MessageType,
  TransferPaymentStatus,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AdvertisingService } from '../advertising/advertising.service';
import { WebhookService } from '../webhook/webhook.service';
import { MetaService } from '../meta/meta.service';
import { HermesService } from '../hermes/hermes.service';
import { HandoffService } from '../handoff/handoff.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { ConversationEventsService } from '../conversations/conversation-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { PaymentsService } from './payments.service';
import { TransferIntentPolicy } from './transfer-intent.policy';

describe('PaymentsService', () => {
  const message = {
    id: 'proof-1',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    type: MessageType.IMAGE,
    direction: MessageDirection.INBOUND,
    sender: MessageSender.CONTACT,
    rawPayload: { image: { id: 'media-1', mime_type: 'image/jpeg' } },
  };
  const transfer = {
    id: 'transfer-1',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    leadId: 'lead-1',
    status: TransferPaymentStatus.INSTRUCTIONS_SENT,
    amountExpected: 1200,
    currency: 'USD',
    sourceMessageId: 'request-1',
  };
  const tx = {
    $executeRaw: jest.fn(),
    transferPayment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    transferPaymentProofMessage: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
    lead: { findUnique: jest.fn(), update: jest.fn() },
    task: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    message: { findUnique: jest.fn() },
    transferPayment: { findUnique: jest.fn() },
    automatedDelivery: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((key: string) =>
      key === 'PAYMENTS_TRANSFER_ENABLED' ? 'true' : '',
    ),
  } as unknown as ConfigService;
  const deliveries = {
    prepareBatch: jest.fn(),
    deliverPreparedBatch: jest.fn().mockResolvedValue({ confirmed: 1 }),
  } as unknown as AutomatedDeliveryService;
  const leads = { recordWonMilestone: jest.fn() } as unknown as LeadsService;
  const service = new PaymentsService(
    prisma,
    config,
    new TransferIntentPolicy(),
    deliveries,
    leads,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(message);
    tx.transferPayment.findFirst.mockResolvedValue(transfer);
    tx.transferPaymentProofMessage.findUnique.mockResolvedValue(null);
    tx.task.findFirst.mockResolvedValue(null);
    tx.transferPaymentProofMessage.upsert.mockResolvedValue({
      messageId: message.id,
    });
  });

  it('asocia una imagen de la conversación y crea una sola tarea sin acceder a media', async () => {
    expect(await service.detectProof(message.id)).toBe(true);
    expect(tx.transferPaymentProofMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: message.id },
        create: { messageId: message.id, transferPaymentId: transfer.id },
      }),
    );
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: transfer.leadId },
      data: { stage: LeadStage.PAYMENT_REVIEW },
    });
    expect(deliveries.prepareBatch).toHaveBeenCalledTimes(1);
  });

  it('no duplica tarea ni auditoría al repetir el webhook', async () => {
    tx.transferPaymentProofMessage.findUnique.mockResolvedValue({
      messageId: message.id,
    });
    expect(await service.detectProof(message.id)).toBe(true);
    expect(tx.transferPaymentProofMessage.upsert).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('no asocia documentos que no sean PDF', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({
      ...message,
      type: MessageType.DOCUMENT,
      rawPayload: { document: { mime_type: 'application/msword' } },
    });
    expect(await service.detectProof(message.id)).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('confirma instrucciones recuperadas sin retroceder un pago ya en revisión', async () => {
    (prisma.transferPayment.findUnique as jest.Mock).mockResolvedValue({
      ...transfer,
      status: TransferPaymentStatus.PROOF_RECEIVED,
      instructionsMessageId: null,
    });
    (prisma.automatedDelivery.findFirst as jest.Mock).mockResolvedValue({
      outboundMessageId: 'outbound-1',
    });
    tx.transferPayment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await service.reconcileInstruction(transfer.sourceMessageId);
    expect(tx.transferPayment.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: { instructionsMessageId: 'outbound-1' },
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza aprobación con comprobante de otra conversación', async () => {
    tx.transferPayment.findUnique.mockResolvedValue({
      ...transfer,
      status: TransferPaymentStatus.PROOF_RECEIVED,
    });
    tx.transferPaymentProofMessage.findFirst.mockResolvedValue({
      message: { conversationId: 'other-conversation' },
    });
    await expect(
      service.approve(
        transfer.id,
        {
          expectedStatus: TransferPaymentStatus.PROOF_RECEIVED,
          reviewedProofMessageId: message.id,
          contractReference: 'contract-1',
        },
        'admin-1',
      ),
    ).rejects.toThrow('Comprobante ajeno');
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
});

describe('transfer approval with attributed CONTRACT_WON', () => {
  it('keeps one correlated touch, proof, task, conversion and sync job through human approval', async () => {
    const reference = 'UC-AAAAAAAAAAAAAAAAAAAAAA';
    const pepper = 'synthetic-reference-pepper-at-least-32-characters';
    const key = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 8);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const accountNumber = Buffer.concat([
      cipher.update('1234567890', 'utf8'),
      cipher.final(),
    ]);
    const accountNumberEncrypted = `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${accountNumber.toString('base64')}`;
    const lead: Record<string, any> = {
      id: 'lead-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      stage: LeadStage.QUALIFIED,
      proposalValue: 1200,
      commercialCurrency: 'USD',
      serviceRequested: 'Software a medida',
    };
    const touch: Record<string, any> = {
      id: 'touch-1',
      referenceHash: createHmac('sha256', pepper)
        .update(reference)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      useCount: 0,
      maxUses: 1,
      gclid: 'Exact_Gclid-123',
      adUserData: AdvertisingConsentChoice.GRANTED,
    };
    const attributions = new Map<string, Record<string, any>>();
    const proofs = new Map<string, Record<string, any>>();
    const conversions = new Map<string, Record<string, any>>();
    const jobs = new Map<string, Record<string, any>>();
    const messages = new Map<string, Record<string, any>>();
    const tasks: Record<string, any>[] = [];
    let transfer: Record<string, any> | null = null;
    const proofMessage = {
      id: 'wamid.proof',
      from: '593990000001',
      timestamp: '1',
      type: 'image',
      image: {
        id: 'media-1',
        mime_type: 'image/jpeg',
        sha256: 'synthetic',
        caption: `Comprobante. Referencia: ${reference}`,
      },
    };
    const config = {
      get: jest.fn(
        (name: string) =>
          ({
            PAYMENTS_TRANSFER_ENABLED: 'true',
            PAYMENTS_ACCOUNT_ENCRYPTION_KEY: key.toString('hex'),
            AD_ATTRIBUTION_REFERENCE_PEPPER: pepper,
            ADVERTISING_GOOGLE_SEND_ENABLED: 'false',
            ADVERTISING_GOOGLE_SYNC_ENABLED: 'false',
          })[name] || '',
      ),
    } as unknown as ConfigService;
    const db: any = {
      $executeRaw: jest.fn(),
      $transaction: jest.fn((callback: (tx: any) => Promise<unknown>) =>
        callback(db),
      ),
      lead: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(lead)),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(lead)),
        update: jest.fn(({ data }) => {
          Object.assign(lead, data);
          return Promise.resolve({ ...lead });
        }),
      },
      bankAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'account-1',
          bankName: 'Banco de prueba',
          accountHolder: 'Empresa de prueba',
          accountType: 'CHECKING',
          accountNumberEncrypted,
          currency: 'USD',
        }),
      },
      message: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(messages.get(where.wamid || where.id) || null),
        ),
        create: jest.fn(({ data }) => {
          const row = {
            ...data,
            id: data.wamid === proofMessage.id ? 'proof-1' : 'text-1',
            createdAt: new Date(),
          };
          messages.set(data.wamid, row);
          messages.set(row.id, row);
          return Promise.resolve(row);
        }),
      },
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: proofMessage.from,
          name: 'Prueba',
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          contactId: 'contact-1',
          status: ConversationStatus.ACTIVE,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      transferPayment: {
        count: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              transfer?.status === TransferPaymentStatus.APPROVED ? 1 : 0,
            ),
          ),
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              transfer &&
                ![
                  TransferPaymentStatus.APPROVED,
                  TransferPaymentStatus.REJECTED,
                ].includes(transfer.status)
                ? transfer
                : null,
            ),
          ),
        findUnique: jest
          .fn()
          .mockImplementation(() => Promise.resolve(transfer)),
        create: jest.fn(({ data }) => {
          transfer = {
            id: 'transfer-1',
            ...data,
            status: TransferPaymentStatus.INSTRUCTIONS_PREPARED,
          };
          return Promise.resolve(transfer);
        }),
        update: jest.fn(({ data }) => {
          Object.assign(transfer!, data);
          return Promise.resolve({ ...transfer! });
        }),
        updateMany: jest.fn(({ where, data }) => {
          if (
            !transfer ||
            transfer.status !== where.status ||
            transfer.instructionsMessageId !== where.instructionsMessageId
          )
            return Promise.resolve({ count: 0 });
          Object.assign(transfer, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      automatedDelivery: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ outboundMessageId: 'instructions-1' }),
      },
      transferPaymentProofMessage: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(proofs.get(where.messageId) || null),
        ),
        findFirst: jest.fn(({ where }) => {
          const proof = where.messageId
            ? proofs.get(where.messageId)
            : [...proofs.values()].at(-1);
          return Promise.resolve(
            proof
              ? {
                  ...proof,
                  message: { conversationId: 'conversation-1' },
                }
              : null,
          );
        }),
        upsert: jest.fn(({ create }) => {
          const proof = { ...create, receivedAt: new Date() };
          proofs.set(create.messageId, proof);
          return Promise.resolve(proof);
        }),
      },
      task: {
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              tasks.find((task) => task.status === 'PENDING') || null,
            ),
          ),
        create: jest.fn(({ data }) => {
          const task = {
            id: `task-${tasks.length + 1}`,
            status: 'PENDING',
            ...data,
          };
          tasks.push(task);
          return Promise.resolve(task);
        }),
        update: jest.fn(({ data }) => {
          Object.assign(tasks[0], data);
          return Promise.resolve(tasks[0]);
        }),
        updateMany: jest.fn(({ data }) => {
          tasks.forEach((task) => Object.assign(task, data));
          return Promise.resolve({ count: tasks.length });
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      advertisingTouch: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            where.referenceHash === touch.referenceHash ? touch : null,
          ),
        ),
        update: jest.fn(({ data }) => {
          touch.useCount += data.useCount.increment;
          touch.consumedAt = data.consumedAt;
          return Promise.resolve(touch);
        }),
      },
      advertisingAttribution: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(attributions.get(where.inboundMessageId) || null),
        ),
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve([...attributions.values()][0] || null),
          ),
        create: jest.fn(({ data }) => {
          const attribution = { id: 'attribution-1', ...data };
          attributions.set(data.inboundMessageId, attribution);
          return Promise.resolve(attribution);
        }),
      },
      advertisingConversion: {
        findUnique: jest.fn(({ where }) => {
          const conversion = where.id
            ? [...conversions.values()].find((item) => item.id === where.id)
            : conversions.get(
                `${where.leadId_eventType.leadId}:${where.leadId_eventType.eventType}`,
              );
          return Promise.resolve(
            conversion
              ? { ...conversion, touch: conversion.touchId ? touch : null }
              : null,
          );
        }),
        create: jest.fn(({ data }) => {
          const conversion = {
            id: `conversion-${conversions.size + 1}`,
            ...data,
          };
          conversions.set(`${data.leadId}:${data.eventType}`, conversion);
          return Promise.resolve(conversion);
        }),
        upsert: jest.fn(({ where, create }) => {
          const key = `${where.leadId_eventType.leadId}:${where.leadId_eventType.eventType}`;
          const existing = conversions.get(key);
          if (existing) return Promise.resolve(existing);
          const conversion = {
            id: `conversion-${conversions.size + 1}`,
            ...create,
          };
          conversions.set(key, conversion);
          return Promise.resolve(conversion);
        }),
        updateMany: jest.fn(({ where, data }) => {
          const conversion = [...conversions.values()].find(
            (item) => item.id === where.id,
          );
          if (!conversion || conversion.touchId)
            return Promise.resolve({ count: 0 });
          Object.assign(conversion, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      advertisingSyncJob: {
        create: jest.fn(({ data }) => {
          const job = { id: `job-${jobs.size + 1}`, ...data };
          jobs.set(data.conversionId, job);
          return Promise.resolve(job);
        }),
        upsert: jest.fn(({ where, create }) => {
          const existing = jobs.get(where.conversionId);
          if (existing) return Promise.resolve(existing);
          const job = { id: `job-${jobs.size + 1}`, ...create };
          jobs.set(where.conversionId, job);
          return Promise.resolve(job);
        }),
      },
      advertisingConversionMapping: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = db as PrismaService;
    const advertising = new AdvertisingService(prisma, config, {} as never);
    const leads = new LeadsService(
      prisma,
      {} as EventEmitter2,
      { isActive: jest.fn().mockReturnValue(false) } as unknown as ClsService,
      config,
    );
    const deliveries = {
      prepareBatch: jest.fn().mockResolvedValue(undefined),
      deliverPreparedBatch: jest.fn().mockResolvedValue({ confirmed: 1 }),
    } as unknown as AutomatedDeliveryService;
    const payments = new PaymentsService(
      prisma,
      config,
      new TransferIntentPolicy(),
      deliveries,
      leads,
    );
    const webhook = new WebhookService(
      config,
      prisma,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {
        findOrCreateForConversation: jest.fn().mockResolvedValue(lead),
      } as unknown as LeadsService,
      {
        markReplied: jest.fn().mockResolvedValue(undefined),
        findHumanManagedRecipient: jest.fn().mockResolvedValue(null),
      } as unknown as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      advertising,
      {
        publishCustomerMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as ConversationEventsService,
      deliveries,
      payments,
    );
    jest.spyOn(webhook as any, 'routeInbound').mockResolvedValue('routed');
    const metaContact = {
      wa_id: proofMessage.from,
      profile: { name: 'Prueba' },
    };
    await (webhook as any).processIncomingMessage(
      {
        id: 'wamid.text',
        from: proofMessage.from,
        timestamp: '1',
        type: 'text',
        text: { body: `Referencia: ${reference}` },
      },
      metaContact,
    );
    expect(attributions.size).toBe(1);
    expect(touch.useCount).toBe(1);
    expect(
      await payments.maybeSendInstructions({
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        sourceMessageId: 'request-1',
        text: 'Pásame los datos de transferencia para pagar hoy',
      }),
    ).toBe(true);
    expect(lead.stage).toBe(LeadStage.PAYMENT_PENDING);
    expect(conversions.has(`lead-1:${AdvertisingEventType.CONTRACT_WON}`)).toBe(
      false,
    );
    await expect(
      (webhook as any).processIncomingMessage(proofMessage, metaContact),
    ).resolves.toBe('payment_proof');
    await expect(
      (webhook as any).processIncomingMessage(proofMessage, metaContact),
    ).resolves.toBe('payment_proof');
    expect(lead.stage).toBe(LeadStage.PAYMENT_REVIEW);
    expect(proofs.size).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(messages.size).toBe(4);
    expect(conversions.has(`lead-1:${AdvertisingEventType.CONTRACT_WON}`)).toBe(
      false,
    );

    const decision = {
      expectedStatus: TransferPaymentStatus.PROOF_RECEIVED,
      reviewedProofMessageId: 'proof-1',
      contractReference: 'contract-1',
    };
    await payments.approve('transfer-1', decision, 'admin-1');
    expect(lead.stage).toBe(LeadStage.WON);
    expect(transfer?.status).toBe(TransferPaymentStatus.APPROVED);
    const won = conversions.get(`lead-1:${AdvertisingEventType.CONTRACT_WON}`)!;
    expect(won).toMatchObject({
      leadId: lead.id,
      contactId: lead.contactId,
      source: 'TRANSFER_APPROVAL',
      verified: true,
      verifiedByUserId: 'admin-1',
      value: 1200,
      currency: 'USD',
      commercialReference: 'contract-1',
      idempotencyKey: 'lead:lead-1:CONTRACT_WON',
    });
    expect(won.occurredAt).toEqual(lead.wonAt);
    expect(jobs.has(won.id)).toBe(true);
    expect(jobs.get(won.id)?.validateOnly).toBe(true);
    await advertising.prepareSync(won.id);
    expect(won.attributionId).toBe(attributions.get('text-1')?.id);
    expect(won.touchId).toBe(touch.id);
    expect(touch.gclid).toBe('Exact_Gclid-123');
    await expect(
      payments.approve('transfer-1', decision, 'admin-1'),
    ).rejects.toThrow('Estado de transferencia cambió');
    const occurredAt = won.occurredAt;
    await leads.recordWonMilestone(
      db,
      lead as never,
      'admin-1',
      'TRANSFER_APPROVAL',
    );
    expect(conversions.get(`lead-1:${AdvertisingEventType.CONTRACT_WON}`)).toBe(
      won,
    );
    expect(won.occurredAt).toBe(occurredAt);
    expect(
      [...conversions.values()].filter(
        (item) => item.eventType === AdvertisingEventType.CONTRACT_WON,
      ),
    ).toHaveLength(1);
    expect(
      [...jobs.values()].filter((job) => job.conversionId === won.id),
    ).toHaveLength(1);
  });
});
