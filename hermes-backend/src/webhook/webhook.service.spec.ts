/* eslint-disable
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/unbound-method
  -- This integration-style unit suite uses dynamic Nest and Prisma doubles. */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ConversationStatus,
  HandoffReason,
  MetaWebhookInboxStatus,
} from '@prisma/client';
import { CampaignsService } from '../campaigns/campaigns.service';
import { HandoffService } from '../handoff/handoff.service';
import { HermesService } from '../hermes/hermes.service';
import { LeadsService } from '../leads/leads.service';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { AdvertisingService } from '../advertising/advertising.service';
import { ConversationEventsService } from '../conversations/conversation-events.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { PaymentsService } from '../payments/payments.service';

function webhookWithDoubles(
  prisma: PrismaService,
  advertising = {} as AdvertisingService,
) {
  return new WebhookService(
    { get: jest.fn() } as unknown as ConfigService,
    prisma,
    {} as MetaService,
    {} as HermesService,
    {} as HandoffService,
    {} as LeadsService,
    {} as CampaignsService,
    {} as AutoReplyService,
    {} as ConversationGuardService,
    advertising,
    {} as ConversationEventsService,
    {} as AutomatedDeliveryService,
  );
}

describe('WebhookService durable inbox', () => {
  const message = {
    id: 'wamid.synthetic',
    from: '593990000001',
    timestamp: '1',
    type: 'text',
    text: { body: 'hola' },
  };
  const contact = { wa_id: message.from, profile: { name: 'Prueba' } };
  const dto = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'account',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '', phone_number_id: '' },
              messages: [message],
              contacts: [contact],
            },
          },
        ],
      },
    ],
  };

  it('stores each inbound event with a stable wamid key before processing', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = webhookWithDoubles({
      metaWebhookInbox: { createMany },
    } as unknown as PrismaService);
    await service.acceptWebhook(dto);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          eventKey: 'message:wamid.synthetic',
          eventType: 'MESSAGE',
          payload: { message, contact },
        },
      ],
      skipDuplicates: true,
    });
  });

  it('recovers a failed attribution after restart without processing the message twice', async () => {
    const row = {
      id: 'inbox-1',
      eventKey: 'message:wamid.synthetic',
      eventType: 'MESSAGE',
      payload: { message, contact },
      status: MetaWebhookInboxStatus.PENDING,
      attempts: 0,
      claimToken: null as string | null,
      leaseUntil: null as Date | null,
    };
    const inbox = {
      findMany: jest.fn().mockImplementation(() => Promise.resolve([row])),
      updateMany: jest.fn().mockImplementation(({ where, data }) => {
        if (where.status && row.status !== where.status) return { count: 0 };
        if (where.claimToken && row.claimToken !== where.claimToken)
          return { count: 0 };
        if (
          where.leaseUntil &&
          row.leaseUntil &&
          row.leaseUntil > where.leaseUntil.lte
        )
          return { count: 0 };
        const attempts = row.attempts;
        Object.assign(row, data);
        if (typeof data.attempts === 'object') row.attempts = attempts + 1;
        return { count: 1 };
      }),
    };
    const prisma = { metaWebhookInbox: inbox } as unknown as PrismaService;
    const first = webhookWithDoubles(prisma);
    const second = webhookWithDoubles(prisma);
    const process = jest
      .fn()
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('confirmed');
    jest
      .spyOn(first as any, 'processIncomingMessage')
      .mockImplementation(process);
    jest
      .spyOn(second as any, 'processIncomingMessage')
      .mockImplementation(process);

    await first.scan();
    expect(row.status).toBe(MetaWebhookInboxStatus.FAILED);
    row.leaseUntil = new Date(0);
    await second.scan();
    expect(row.status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(row.attempts).toBe(2);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('claims one inbox row only once across five concurrent workers', async () => {
    const row = {
      id: 'inbox-concurrent',
      eventType: 'MESSAGE',
      payload: { message, contact },
      status: MetaWebhookInboxStatus.PENDING,
      attempts: 0,
      claimToken: null as string | null,
    };
    const process = jest.fn().mockResolvedValue('missing');
    const prisma = {
      metaWebhookInbox: {
        findMany: jest
          .fn()
          .mockImplementation(() => Promise.resolve([{ ...row }])),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          if (where.status && row.status !== where.status) return { count: 0 };
          if (where.claimToken && row.claimToken !== where.claimToken)
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    } as unknown as PrismaService;
    const workers = Array.from({ length: 5 }, () => webhookWithDoubles(prisma));
    for (const worker of workers) {
      jest
        .spyOn(worker as any, 'processIncomingMessage')
        .mockImplementation(process);
    }
    await Promise.all(workers.map((worker) => worker.scan()));
    expect(process).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(MetaWebhookInboxStatus.COMPLETED);
  });

  it('resumes commercial routing when a worker died after persisting the message', async () => {
    const row = {
      id: 'inbox-abandoned',
      eventType: 'MESSAGE',
      payload: { message, contact },
      status: MetaWebhookInboxStatus.PROCESSING,
      outcome: null,
      attempts: 1,
      leaseUntil: new Date(0),
    };
    const inbox = {
      findMany: jest.fn().mockResolvedValue([row]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const service = webhookWithDoubles({
      metaWebhookInbox: inbox,
    } as unknown as PrismaService);
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockResolvedValue('confirmed');
    await service.scan();
    expect(process).toHaveBeenCalledWith(message, contact, true);
  });

  it('retries only the claim when the inbound message already exists', async () => {
    const existing = {
      id: 'message-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      content: 'Referencia: UC-AAAAAAAAAAAAAAAAAAAAAA',
    };
    const advertising = {
      claimReference: jest.fn().mockResolvedValue({ status: 'confirmed' }),
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
      },
    };
    const service = webhookWithDoubles(
      prisma as unknown as PrismaService,
      advertising as unknown as AdvertisingService,
    );
    await expect(
      (service as any).processIncomingMessage(message, contact),
    ).resolves.toBe('confirmed');
    expect(advertising.claimReference).toHaveBeenCalledWith({
      messageContent: existing.content,
      contactId: existing.contactId,
      conversationId: existing.conversationId,
      inboundMessageId: existing.id,
    });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('resumes an interrupted commercial route without recreating its inbound message', async () => {
    const existing = {
      id: 'message-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      content: 'hola',
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(existing),
        findMany: jest.fn().mockResolvedValue([{ content: 'hola' }]),
        create: jest.fn(),
      },
      contact: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'contact-1', waId: message.from }),
      },
      conversation: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          status: ConversationStatus.ACTIVE,
        }),
      },
    };
    const autoReplies = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {
        findHumanManagedRecipient: jest.fn().mockResolvedValue(null),
      } as unknown as CampaignsService,
      autoReplies as unknown as AutoReplyService,
      {
        inspect: jest.fn().mockResolvedValue({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      {
        claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
      } as unknown as AdvertisingService,
      {} as ConversationEventsService,
      {} as AutomatedDeliveryService,
    );
    await expect(
      (service as any).processIncomingMessage(message, contact, true),
    ).resolves.toBe('missing');
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(autoReplies.enqueue).toHaveBeenCalledWith(
      {
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'message-1',
      },
      4,
    );
  });
});

describe('WebhookService attribution with transfer proofs', () => {
  const reference = 'UC-AAAAAAAAAAAAAAAAAAAAAA';
  const contact = { wa_id: '593990000001', profile: { name: 'Prueba' } };

  function harness(
    options: {
      openTransfer?: boolean;
      claimStatus?: 'confirmed' | 'used';
      claimFails?: boolean;
      proofAlreadyRecorded?: boolean;
    } = {},
  ) {
    const messages = new Map<string, Record<string, any>>();
    const attributedMessages = new Set<string>();
    const proofMessages = new Set<string>();
    if (options.proofAlreadyRecorded) proofMessages.add('message-1');
    const calls: string[] = [];
    let tasks = 0;
    let reviewTransitions = 0;
    let claimFailuresLeft = options.claimFails ? 1 : 0;
    const prisma = {
      message: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(messages.get(where.wamid) || null),
        ),
        create: jest.fn(({ data }) => {
          const row = { ...data, id: 'message-1', createdAt: new Date() };
          messages.set(data.wamid, row);
          calls.push('persist');
          return Promise.resolve(row);
        }),
      },
      conversation: { update: jest.fn().mockResolvedValue({}) },
    };
    const advertising = {
      claimReference: jest.fn(({ messageContent, inboundMessageId }) => {
        calls.push('claim');
        if (claimFailuresLeft) {
          claimFailuresLeft -= 1;
          return Promise.reject(new Error('temporary attribution outage'));
        }
        if (!messageContent?.includes(reference))
          return Promise.resolve({ status: 'missing' });
        if (options.claimStatus === 'used')
          return Promise.resolve({ status: 'used' });
        attributedMessages.add(inboundMessageId);
        return Promise.resolve({ status: 'confirmed' });
      }),
    };
    const payments = {
      detectProof: jest.fn((messageId: string) => {
        calls.push('proof');
        if (options.openTransfer === false) return Promise.resolve(false);
        if (!proofMessages.has(messageId)) {
          proofMessages.add(messageId);
          tasks += 1;
          reviewTransitions += 1;
        }
        return Promise.resolve(true);
      }),
    };
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {
        findOrCreateForConversation: jest.fn().mockResolvedValue({}),
      } as unknown as LeadsService,
      {
        markReplied: jest.fn().mockResolvedValue(undefined),
        findHumanManagedRecipient: jest.fn().mockResolvedValue(null),
      } as unknown as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      advertising as unknown as AdvertisingService,
      {
        publishCustomerMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as ConversationEventsService,
      {} as AutomatedDeliveryService,
      payments as unknown as PaymentsService,
    );
    jest.spyOn(service as any, 'upsertContact').mockResolvedValue({
      id: 'contact-1',
      waId: contact.wa_id,
      name: contact.profile.name,
    });
    jest.spyOn(service as any, 'getOrCreateConversation').mockResolvedValue({
      id: 'conversation-1',
      status: ConversationStatus.ACTIVE,
    });
    const routeInbound = jest
      .spyOn(service as any, 'routeInbound')
      .mockResolvedValue('routed');
    const process = (message: Record<string, unknown>) =>
      (service as any).processIncomingMessage(
        message,
        contact,
      ) as Promise<string>;
    return {
      process,
      prisma,
      advertising,
      payments,
      calls,
      routeInbound,
      attributedMessages,
      proofMessages,
      get tasks() {
        return tasks;
      },
      get reviewTransitions() {
        return reviewTransitions;
      },
    };
  }

  function media(type: 'image' | 'document', caption?: string) {
    return {
      id: 'wamid.proof',
      from: contact.wa_id,
      timestamp: '1',
      type,
      [type]: {
        id: 'media-1',
        mime_type: type === 'image' ? 'image/jpeg' : 'application/pdf',
        caption,
      },
    };
  }

  it.each(['image', 'document'] as const)(
    '%s caption claims attribution before associating the proof',
    async (type) => {
      const flow = harness();
      await expect(
        flow.process(media(type, `Comprobante. Referencia: ${reference}`)),
      ).resolves.toBe('payment_proof');
      expect(flow.calls).toEqual(['persist', 'claim', 'proof']);
      expect(flow.advertising.claimReference).toHaveBeenCalledWith({
        messageContent: `Comprobante. Referencia: ${reference}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      });
      expect(flow.attributedMessages.size).toBe(1);
      expect(flow.proofMessages.size).toBe(1);
      expect(flow.tasks).toBe(1);
      expect(flow.reviewTransitions).toBe(1);
      expect(flow.routeInbound).not.toHaveBeenCalled();
    },
  );

  it('keeps image proof handling when the caption has no reference', async () => {
    const flow = harness();
    await expect(
      flow.process(media('image', 'Aquí está el comprobante')),
    ).resolves.toBe('payment_proof');
    expect(flow.advertising.claimReference).toHaveBeenCalledTimes(1);
    expect(flow.attributedMessages.size).toBe(0);
    expect(flow.proofMessages.size).toBe(1);
  });

  it('preserves text reference handling without proof detection', async () => {
    const flow = harness();
    await expect(
      flow.process({
        id: 'wamid.text',
        from: contact.wa_id,
        timestamp: '1',
        type: 'text',
        text: { body: `Referencia: ${reference}` },
      }),
    ).resolves.toBe('routed');
    expect(flow.attributedMessages.size).toBe(1);
    expect(flow.payments.detectProof).not.toHaveBeenCalled();
    expect(flow.routeInbound).toHaveBeenCalledTimes(1);
  });

  it.each(['image', 'document'] as const)(
    'replaying the same %s keeps one message, attribution, proof, task and review transition',
    async (type) => {
      const flow = harness();
      const message = media(type, `Referencia: ${reference}`);
      await flow.process(message);
      await expect(flow.process(message)).resolves.toBe('payment_proof');
      expect(flow.prisma.message.create).toHaveBeenCalledTimes(1);
      expect(flow.attributedMessages.size).toBe(1);
      expect(flow.proofMessages.size).toBe(1);
      expect(flow.tasks).toBe(1);
      expect(flow.reviewTransitions).toBe(1);
      expect(flow.calls).toEqual([
        'persist',
        'claim',
        'proof',
        'claim',
        'proof',
      ]);
    },
  );

  it('keeps a valid proof when the reference is invalid', async () => {
    const flow = harness();
    await expect(
      flow.process(media('image', 'Referencia: UC-BBBBBBBBBBBBBBBBBBBBBB')),
    ).resolves.toBe('payment_proof');
    expect(flow.attributedMessages.size).toBe(0);
    expect(flow.proofMessages.size).toBe(1);
  });

  it('claims attribution when the proof was already associated', async () => {
    const flow = harness({ proofAlreadyRecorded: true });
    await expect(
      flow.process(media('image', `Referencia: ${reference}`)),
    ).resolves.toBe('payment_proof');
    expect(flow.attributedMessages.size).toBe(1);
    expect(flow.proofMessages.size).toBe(1);
    expect(flow.tasks).toBe(0);
    expect(flow.reviewTransitions).toBe(0);
  });

  it('does not block proof handling when the reference is already used', async () => {
    const flow = harness({ claimStatus: 'used' });
    await expect(
      flow.process(media('image', `Referencia: ${reference}`)),
    ).resolves.toBe('payment_proof');
    expect(flow.attributedMessages.size).toBe(0);
    expect(flow.proofMessages.size).toBe(1);
  });

  it('keeps valid attribution when no open transfer accepts the media', async () => {
    const flow = harness({ openTransfer: false });
    await expect(
      flow.process(media('document', `Referencia: ${reference}`)),
    ).resolves.toBe('routed');
    expect(flow.attributedMessages.size).toBe(1);
    expect(flow.proofMessages.size).toBe(0);
    expect(flow.routeInbound).toHaveBeenCalledTimes(1);
  });

  it('retries attribution after a recoverable failure while retaining the proof', async () => {
    const flow = harness({ claimFails: true });
    const message = media('image', `Referencia: ${reference}`);
    await expect(flow.process(message)).resolves.toBe('retry');
    expect(flow.proofMessages.size).toBe(1);
    expect(flow.tasks).toBe(1);
    expect(flow.routeInbound).not.toHaveBeenCalled();
    await expect(flow.process(message)).resolves.toBe('payment_proof');
    expect(flow.attributedMessages.size).toBe(1);
    expect(flow.proofMessages.size).toBe(1);
    expect(flow.tasks).toBe(1);
  });
});

describe('WebhookService campaign replies', () => {
  it('records every accepted Meta webhook before processing its entries', async () => {
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
      {} as ConversationEventsService,
    );
    const log = jest.spyOn(
      (service as unknown as { logger: Logger }).logger,
      'log',
    );

    await service.processWebhook({
      object: 'whatsapp_business_account',
      entry: [],
    });

    const event = JSON.parse(log.mock.calls[0][0] as string);
    expect(event).toEqual({
      event: 'meta_webhook_received',
      entries: 0,
      messages: 0,
      statuses: 0,
      messageIds: [],
    });
  });

  it('accepts only a valid Meta HMAC signature', () => {
    const secret = 'test-meta-secret';
    const payload = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;
    const service = new WebhookService(
      {
        get: jest.fn((key: string) =>
          key === 'META_APP_SECRET' ? secret : undefined,
        ),
      } as unknown as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
      {} as ConversationEventsService,
    );

    expect(service.validateSignature(payload, signature)).toBe(true);
    expect(service.validateSignature(payload, 'sha256=bad')).toBe(false);
    expect(service.validateSignature(payload, signature.slice(7))).toBe(false);
    expect(
      service.validateSignature(
        Buffer.from(`${payload.toString()} `),
        signature,
      ),
    ).toBe(false);
  });

  it('returns the challenge only for the configured verification token', () => {
    const service = new WebhookService(
      {
        get: jest.fn(() => 'synthetic-verify-token'),
      } as unknown as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
      {} as ConversationEventsService,
      {} as AutomatedDeliveryService,
    );
    expect(
      service.verifyWebhook(
        'subscribe',
        'synthetic-verify-token',
        'challenge-1',
      ),
    ).toBe('challenge-1');
    expect(() =>
      service.verifyWebhook('subscribe', 'wrong', 'challenge-1'),
    ).toThrow();
    const missingConfig = webhookWithDoubles({} as PrismaService);
    expect(() =>
      missingConfig.verifyWebhook(
        'subscribe',
        undefined as unknown as string,
        'challenge-1',
      ),
    ).toThrow();
  });

  it('sends a campaign reply to human handoff without invoking Hermes', async () => {
    const prismaMock = {
      $executeRaw: jest.fn(),
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: '593991234567',
          name: 'Contacto de prueba',
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'conversation-1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      humanHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'inbound-1' }),
      },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const prisma = prismaMock as unknown as PrismaService;
    const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const handoff = {
      create: jest.fn().mockResolvedValue({ id: 'handoff-1' }),
    } as unknown as HandoffService;
    const leads = {
      findOrCreateForConversation: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsService;
    const campaigns = {
      markReplied: jest.fn().mockResolvedValue(undefined),
      findHumanManagedRecipient: jest
        .fn()
        .mockResolvedValue({ campaignId: 'campaign-1' }),
    } as unknown as CampaignsService;
    const autoReplies = { enqueue: jest.fn() } as unknown as AutoReplyService;
    const guard = { inspect: jest.fn() } as unknown as ConversationGuardService;
    const advertising = {
      claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
    } as unknown as AdvertisingService;
    const publishCustomerMessage = jest.fn();
    const conversationEvents = {
      publishCustomerMessage,
    } as unknown as ConversationEventsService;
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      handoff,
      leads,
      campaigns,
      autoReplies,
      guard,
      advertising,
      conversationEvents,
    );

    await (service as any).processIncomingMessage(
      {
        id: 'wamid.inbound',
        from: '593991234567',
        type: 'text',
        text: { body: 'Necesito información' },
      },
      { wa_id: '593991234567', profile: { name: 'Contacto de prueba' } },
    );

    expect(handoff.create).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      reason: HandoffReason.CUSTOM,
      reasonDetail:
        'Respuesta a campaña campaign-1; requiere atención humana desde CRM.',
    });
    expect(publishCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'inbound-1',
        conversationId: 'conversation-1',
        contactName: 'Contacto de prueba',
      }),
    );
    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(autoReplies.enqueue).not.toHaveBeenCalled();
    expect(advertising.claimReference).toHaveBeenCalledWith({
      messageContent: 'Necesito información',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
    });
  });

  it('resumes the latest closed conversation without replacing its lead', async () => {
    const closedAt = new Date('2026-09-18T18:00:00Z');
    const closedConversation = {
      id: 'conversation-closed',
      contactId: 'contact-1',
      status: ConversationStatus.CLOSED,
      closedAt,
    };
    const resumedConversation = {
      ...closedConversation,
      status: ConversationStatus.ACTIVE,
      closedAt: null,
    };
    const prismaMock = {
      $executeRaw: jest.fn(),
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: '593991234567',
          name: 'Ana',
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(closedConversation),
        create: jest.fn(),
        update: jest
          .fn()
          .mockResolvedValueOnce(resumedConversation)
          .mockResolvedValue({}),
      },
      humanHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'inbound-1' }),
      },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const leads = {
      findOrCreateForConversation: jest
        .fn()
        .mockResolvedValue({ id: 'lead-existing', stage: 'QUALIFIED' }),
    } as unknown as LeadsService;
    const campaigns = {
      markReplied: jest.fn().mockResolvedValue(undefined),
      findHumanManagedRecipient: jest
        .fn()
        .mockResolvedValue({ campaignId: 'campaign-1' }),
    } as unknown as CampaignsService;
    const autoReplies = { enqueue: jest.fn() } as unknown as AutoReplyService;
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prismaMock as unknown as PrismaService,
      { sendTextMessage: jest.fn() } as unknown as MetaService,
      { generateResponse: jest.fn() } as unknown as HermesService,
      { create: jest.fn().mockResolvedValue({}) } as unknown as HandoffService,
      leads,
      campaigns,
      autoReplies,
      { inspect: jest.fn() } as unknown as ConversationGuardService,
      {
        claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
      } as unknown as AdvertisingService,
      {
        publishCustomerMessage: jest.fn(),
      } as unknown as ConversationEventsService,
    );

    await (service as any).processIncomingMessage(
      {
        id: 'wamid.resumed',
        from: '593991234567',
        type: 'text',
        text: { body: 'Quiero retomar la cotización' },
      },
      { wa_id: '593991234567', profile: { name: 'Ana' } },
    );

    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
    expect(prismaMock.conversation.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'conversation-closed' },
      data: { status: ConversationStatus.ACTIVE, closedAt: null },
    });
    expect(leads.findOrCreateForConversation).toHaveBeenCalledWith({
      contactId: 'contact-1',
      conversationId: 'conversation-closed',
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CONVERSATION_REOPENED',
          entityId: 'conversation-closed',
          changes: expect.objectContaining({ source: 'INBOUND_MESSAGE' }),
        }),
      }),
    );
  });

  it('preserves an open handoff when an inbound message resumes a closed conversation', async () => {
    const closedConversation = {
      id: 'conversation-closed',
      contactId: 'contact-1',
      status: ConversationStatus.CLOSED,
      closedAt: new Date('2026-09-18T18:00:00Z'),
    };
    const prismaMock = {
      $executeRaw: jest.fn(),
      conversation: {
        findFirst: jest.fn().mockResolvedValue(closedConversation),
        update: jest.fn().mockResolvedValue({
          ...closedConversation,
          status: ConversationStatus.HANDED_OFF,
          closedAt: null,
        }),
        create: jest.fn(),
      },
      humanHandoff: {
        findFirst: jest.fn().mockResolvedValue({ id: 'handoff-open' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const service = new WebhookService(
      {} as ConfigService,
      prismaMock as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
      {} as ConversationEventsService,
    );

    const result = await (service as any).getOrCreateConversation('contact-1');

    expect(result.status).toBe(ConversationStatus.HANDED_OFF);
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-closed' },
      data: { status: ConversationStatus.HANDED_OFF, closedAt: null },
    });
    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
  });

  it('persists audio metadata and enqueues it for transcription after debounce', async () => {
    const inboundMessage = {
      id: 'inbound-audio',
      createdAt: new Date('2026-09-20T16:00:00Z'),
    };
    const messageCreate = jest
      .fn()
      .mockResolvedValueOnce(inboundMessage)
      .mockResolvedValueOnce({ id: 'outbound-audio-notice' });
    const prismaMock = {
      $executeRaw: jest.fn(),
      $transaction: jest.fn(),
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: '593991234567',
          name: 'Ana',
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
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: messageCreate,
      },
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const meta = {
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.notice' }] }),
    } as unknown as MetaService;
    const autoReplies = { enqueue: jest.fn() } as unknown as AutoReplyService;
    const guard = {
      inspect: jest.fn().mockResolvedValue({ action: 'ALLOW' }),
    } as unknown as ConversationGuardService;
    const deliveries = {
      prepareBatch: jest.fn().mockResolvedValue(undefined),
      deliverPreparedBatch: jest
        .fn()
        .mockResolvedValue({ handled: true, confirmed: 1, terminal: true }),
    };
    const service = new WebhookService(
      {} as ConfigService,
      prismaMock as unknown as PrismaService,
      meta,
      {} as HermesService,
      {} as HandoffService,
      {
        findOrCreateForConversation: jest.fn().mockResolvedValue({}),
      } as unknown as LeadsService,
      {
        markReplied: jest.fn().mockResolvedValue(undefined),
        findHumanManagedRecipient: jest.fn().mockResolvedValue(null),
        optOut: jest.fn(),
      } as unknown as CampaignsService,
      autoReplies,
      guard,
      {
        claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
      } as unknown as AdvertisingService,
      {
        publishCustomerMessage: jest.fn().mockResolvedValue(undefined),
      } as unknown as ConversationEventsService,
      deliveries as unknown as AutomatedDeliveryService,
    );

    await (service as any).processIncomingMessage(
      {
        id: 'wamid.audio',
        from: '593991234567',
        timestamp: '1790006400',
        type: 'audio',
        audio: { id: 'media-1', mime_type: 'audio/ogg' },
      },
      { wa_id: '593991234567', profile: { name: 'Ana' } },
    );

    expect(messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        wamid: 'wamid.audio',
        metadata: {
          sourceType: 'AUDIO',
          mediaId: 'media-1',
          mimeType: 'audio/ogg',
        },
      }),
    });
    expect(deliveries.prepareBatch).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(autoReplies.enqueue).toHaveBeenCalledWith(
      {
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-audio',
      },
      7,
    );
    expect(guard.inspect).toHaveBeenCalled();
  });

  it('allows only a post-handoff support notice through the handed-off guard', async () => {
    const deliveries = {
      prepareBatch: jest.fn().mockResolvedValue(undefined),
      deliverPreparedBatch: jest
        .fn()
        .mockResolvedValue({ handled: true, confirmed: 1, terminal: true }),
    };
    const service = new WebhookService(
      {} as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
      {} as ConversationEventsService,
      deliveries as unknown as AutomatedDeliveryService,
    );

    await (service as any).sendSystemMessage(
      'conversation-1',
      'contact-1',
      'inbound-support',
      'Un especialista continuará la atención.',
      'SUPPORT_ROUTING',
      true,
    );

    expect(deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: 'inbound-support',
        allowHandedOff: true,
        parts: [
          expect.objectContaining({
            metadata: { action: 'SUPPORT_ROUTING' },
          }),
        ],
      }),
    );
  });
});
