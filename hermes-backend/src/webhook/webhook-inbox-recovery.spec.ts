/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method -- Prisma doubles model conditional claims. */
import { ConfigService } from '@nestjs/config';
import { MetaWebhookInboxStatus } from '@prisma/client';
import { AdvertisingService } from '../advertising/advertising.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { ConversationEventsService } from '../conversations/conversation-events.service';
import { HandoffService } from '../handoff/handoff.service';
import { HermesService } from '../hermes/hermes.service';
import { LeadsService } from '../leads/leads.service';
import { MetaService } from '../meta/meta.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetaWebhookDto } from './dto/meta-webhook.dto';
import { WebhookService } from './webhook.service';

type Row = {
  id: string;
  eventKey: string;
  eventType: string;
  payload: unknown;
  status: MetaWebhookInboxStatus;
  outcome: string | null;
  attempts: number;
  claimToken: string | null;
  leaseUntil: Date | null;
};

function inboxHarness() {
  const rows: Row[] = [];
  const matches = (row: Row, where: any): boolean => {
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.status !== undefined && where.status !== row.status) return false;
    if (where.claimToken !== undefined && where.claimToken !== row.claimToken)
      return false;
    if (where.outcome?.in && !where.outcome.in.includes(row.outcome))
      return false;
    if (
      where.leaseUntil?.lte &&
      (!row.leaseUntil || row.leaseUntil > where.leaseUntil.lte)
    )
      return false;
    return true;
  };
  const inbox = {
    createMany: jest.fn(({ data }: any) => {
      let count = 0;
      for (const event of data) {
        if (rows.some((row) => row.eventKey === event.eventKey)) continue;
        count++;
        rows.push({
          id: `inbox-${rows.length + 1}`,
          eventKey: event.eventKey,
          eventType: event.eventType,
          payload: event.payload,
          status: MetaWebhookInboxStatus.PENDING,
          outcome: null,
          attempts: 0,
          claimToken: null,
          leaseUntil: null,
        });
      }
      return Promise.resolve({ count });
    }),
    findMany: jest.fn(({ where }: any) =>
      Promise.resolve(
        rows
          .filter((row) =>
            where.eventKey?.in
              ? where.eventKey.in.includes(row.eventKey)
              : where.OR.some((clause: any) => matches(row, clause)),
          )
          .map((row) => ({ ...row })),
      ),
    ),
    updateMany: jest.fn(({ where, data }: any) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) return Promise.resolve({ count: 0 });
      if (data.attempts?.increment) row.attempts += data.attempts.increment;
      Object.assign(row, { ...data, attempts: row.attempts });
      return Promise.resolve({ count: 1 });
    }),
  };
  const prisma = {
    metaWebhookInbox: inbox,
    contact: { upsert: jest.fn() },
    message: { findUnique: jest.fn(), create: jest.fn() },
  } as unknown as PrismaService;
  const campaigns = {
    markRecipientStatus: jest.fn().mockResolvedValue(undefined),
  };
  const service = new WebhookService(
    {
      get: jest.fn((key: string) =>
        key === 'META_PHONE_NUMBER_ID' ? 'allowed' : undefined,
      ),
    } as unknown as ConfigService,
    prisma,
    {} as MetaService,
    {} as HermesService,
    {} as HandoffService,
    {} as LeadsService,
    campaigns as unknown as CampaignsService,
    {} as AutoReplyService,
    {} as ConversationGuardService,
    {} as AdvertisingService,
    {} as ConversationEventsService,
    {} as AutomatedDeliveryService,
    {} as PaymentsService,
  );
  return { rows, inbox, prisma, campaigns, service };
}

function signedBody(
  messageOverride: Record<string, unknown> = {},
  contactOverride: Record<string, unknown> = {},
) {
  const message = {
    id: 'wamid.synthetic',
    from: '593990000001',
    type: 'text',
    timestamp: '1',
    text: { body: 'mensaje de prueba' },
    ...messageOverride,
  };
  const contact = {
    wa_id: '593990000001',
    profile: { name: 'Sintético' },
    ...contactOverride,
  };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'allowed' },
              messages: [message],
              contacts: [contact],
            },
          },
        ],
      },
    ],
  } as unknown as MetaWebhookDto;
}

describe('durable webhook quarantine and recovery', () => {
  it.each([
    ['missing from', { from: undefined }, {}, 'MESSAGE_FROM_MISSING'],
    ['null from', { from: null }, {}, 'MESSAGE_FROM_MISSING'],
    ['numeric from', { from: 593990000001 }, {}, 'MESSAGE_FROM_MISSING'],
    ['boolean from', { from: true }, {}, 'MESSAGE_FROM_MISSING'],
    [
      'object from',
      { from: { id: '593990000001' } },
      {},
      'MESSAGE_FROM_MISSING',
    ],
    ['empty from', { from: '' }, {}, 'MESSAGE_FROM_MISSING'],
    [
      'both IDs missing',
      { from: undefined },
      { wa_id: undefined },
      'MESSAGE_FROM_MISSING',
    ],
    ['invalid E.164 from', { from: '0990000001' }, {}, 'MESSAGE_FROM_INVALID'],
    ['missing wa_id', {}, { wa_id: undefined }, 'CONTACT_WA_ID_MISSING'],
    ['null wa_id', {}, { wa_id: null }, 'CONTACT_WA_ID_MISSING'],
    ['numeric wa_id', {}, { wa_id: 593990000001 }, 'CONTACT_WA_ID_MISSING'],
    ['empty wa_id', {}, { wa_id: '' }, 'CONTACT_WA_ID_MISSING'],
    ['different wa_id', {}, { wa_id: '593990000002' }, 'CONTACT_WA_ID_INVALID'],
    ['numeric text body', { text: { body: 123 } }, {}, 'MESSAGE_TEXT_INVALID'],
  ] as const)(
    'quarantines %s once with intact evidence',
    async (_name, message, contact, reason) => {
      const { rows, service, prisma } = inboxHarness();
      const body = signedBody(message, contact);
      await service.acceptWebhook(body);
      expect(rows).toHaveLength(1);
      const originalPayload = structuredClone(rows[0].payload);
      await service.scan();
      expect(rows[0]).toMatchObject({
        status: MetaWebhookInboxStatus.FAILED,
        outcome: `PERMANENT_INVALID_PAYLOAD:${reason}`,
        leaseUntil: null,
        claimToken: null,
        attempts: 1,
      });
      expect(rows[0].payload).toEqual(originalPayload);
      await service.scan();
      expect(rows[0].attempts).toBe(1);
      expect(prisma.contact.upsert).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    },
  );

  it('uses a deterministic hash when an actionable message has no usable id', async () => {
    const { rows, service } = inboxHarness();
    const body = signedBody({ id: null });
    await service.acceptWebhook(body);
    await service.acceptWebhook(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventKey).toMatch(/^message:sha256:[a-f0-9]{64}$/);
    await service.scan();
    expect(rows[0].outcome).toBe(
      'PERMANENT_INVALID_PAYLOAD:MESSAGE_ID_INVALID',
    );
  });

  it('does not collapse two identical idless events in one signed callback', async () => {
    const { rows, service } = inboxHarness();
    const body = signedBody({ id: null });
    const value = body.entry[0].changes[0].value;
    value.messages!.push(structuredClone(value.messages![0]));
    await service.acceptWebhook(body);
    expect(rows).toHaveLength(2);
    expect(rows[0].eventKey).not.toBe(rows[1].eventKey);
  });

  it('processes a valid duplicate only once', async () => {
    const { rows, service } = inboxHarness();
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockResolvedValue('missing');
    const body = signedBody();
    await service.acceptWebhook(body);
    await service.acceptWebhook(body);
    expect(rows).toHaveLength(1);
    await service.scan();
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('preserves a corrected redelivery for human review without releasing quarantine', async () => {
    const { rows, service, prisma } = inboxHarness();
    const invalid = signedBody({ from: undefined }, { wa_id: undefined });
    await service.acceptWebhook(invalid);
    await service.scan();
    const originalPayload = structuredClone(rows[0].payload);

    const corrected = signedBody();
    await service.acceptWebhook(corrected);
    await service.acceptWebhook(corrected);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: MetaWebhookInboxStatus.FAILED,
      outcome: 'PERMANENT_INVALID_PAYLOAD:MESSAGE_FROM_MISSING',
      attempts: 1,
      payload: originalPayload,
    });
    expect(rows[1]).toMatchObject({
      eventType: 'REDELIVERY_CONFLICT',
      payload: {
        originalEventKey: 'message:wamid.synthetic',
        receivedEventType: 'MESSAGE',
        receivedPayload: expect.objectContaining({
          message: expect.objectContaining({ from: '593990000001' }),
        }),
      },
    });
    await service.scan();
    expect(rows[1]).toMatchObject({
      status: MetaWebhookInboxStatus.FAILED,
      outcome: 'PERMANENT_INVALID_PAYLOAD:REDELIVERY_CONFLICT',
      leaseUntil: null,
    });
    await service.scan();
    expect(rows[0].attempts).toBe(1);
    expect(rows[1].attempts).toBe(1);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('accepts a valid Meta sender when the optional contacts array is absent', async () => {
    const { rows, service } = inboxHarness();
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockResolvedValue('processed');
    const body = signedBody();
    delete (body.entry[0].changes[0].value as any).contacts;
    await service.acceptWebhook(body);
    expect(rows[0].payload).toMatchObject({
      contact: { wa_id: '593990000001', profile: { name: '' } },
    });
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ from: '593990000001' }),
      expect.objectContaining({ wa_id: '593990000001' }),
      false,
    );
  });

  it.each([
    ['text', { type: 'text', text: { body: 'hola' } }],
    [
      'image',
      { type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } },
    ],
    [
      'audio',
      {
        type: 'audio',
        audio: { id: 'media-2', mime_type: 'audio/ogg', voice: true },
      },
    ],
    [
      'document',
      {
        type: 'document',
        document: { id: 'media-3', mime_type: 'application/pdf' },
      },
    ],
    [
      'video',
      { type: 'video', video: { id: 'media-4', mime_type: 'video/mp4' } },
    ],
    [
      'location',
      { type: 'location', location: { latitude: -0.18, longitude: -78.47 } },
    ],
    [
      'reaction',
      {
        type: 'reaction',
        reaction: { message_id: 'wamid.target', emoji: 'ok' },
      },
    ],
    [
      'button reply',
      {
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'yes', title: 'Sí' },
        },
      },
    ],
    [
      'list reply',
      {
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'one', title: 'Opción 1' },
        },
      },
    ],
  ] as const)('accepts a valid %s payload', async (_name, valid) => {
    const { rows, service } = inboxHarness();
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockResolvedValue('processed');
    await service.acceptWebhook(signedBody({ text: undefined, ...valid }));
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image without media', { type: 'image', image: undefined }],
    [
      'document without id',
      { type: 'document', document: { mime_type: 'application/pdf' } },
    ],
    [
      'audio with numeric voice',
      { type: 'audio', audio: { id: 'm', mime_type: 'audio/ogg', voice: 1 } },
    ],
    [
      'location without coordinates',
      { type: 'location', location: { name: 'Fixture' } },
    ],
    [
      'interactive without content',
      { type: 'interactive', interactive: undefined },
    ],
    [
      'interactive without selected reply',
      { type: 'interactive', interactive: { type: 'button_reply' } },
    ],
    [
      'reaction without target',
      { type: 'reaction', reaction: { emoji: '👍' } },
    ],
  ] as const)('quarantines %s before effects', async (_name, malformed) => {
    const { rows, service, prisma } = inboxHarness();
    await service.acceptWebhook(signedBody(malformed));
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.FAILED);
    expect(rows[0].outcome).toMatch(/^PERMANENT_INVALID_PAYLOAD:/);
    expect(prisma.contact.upsert).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'read', 'failed'] as const)(
    'processes a valid %s STATUS event through the unchanged route',
    async (status) => {
      const { rows, service, campaigns } = inboxHarness();
      const body = signedBody();
      const value = body.entry[0].changes[0].value;
      delete (value as any).messages;
      value.statuses = [
        {
          id: 'wamid.status',
          status,
          timestamp: '1',
          recipient_id: '593990000001',
        },
      ];
      await service.acceptWebhook(body);
      await service.scan();
      expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
      expect(campaigns.markRecipientStatus).toHaveBeenCalledWith(
        'wamid.status',
        status,
        '1',
        undefined,
      );
    },
  );

  it('converts a legacy retry loop to permanent quarantine on its next claim', async () => {
    const { rows, service } = inboxHarness();
    await service.acceptWebhook(
      signedBody({ from: undefined }, { wa_id: undefined }),
    );
    Object.assign(rows[0], {
      status: MetaWebhookInboxStatus.FAILED,
      outcome: 'processing_error',
      attempts: 5276,
      leaseUntil: new Date(0),
    });
    await service.scan();
    expect(rows[0].attempts).toBe(5277);
    expect(rows[0].outcome).toBe(
      'PERMANENT_INVALID_PAYLOAD:MESSAGE_FROM_MISSING',
    );
    expect(rows[0].leaseUntil).toBeNull();
    await service.scan();
    expect(rows[0].attempts).toBe(5277);
  });

  it('keeps a transient failure retryable with backoff, then completes', async () => {
    const { rows, service } = inboxHarness();
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockRejectedValueOnce(new Error('synthetic outage'))
      .mockResolvedValueOnce('missing');
    await service.acceptWebhook(signedBody());
    await service.scan();
    expect(rows[0].outcome).toBe('RETRYABLE_PROCESSING_ERROR');
    expect(rows[0].leaseUntil!.getTime()).toBeGreaterThan(Date.now());
    await service.scan();
    expect(process).toHaveBeenCalledTimes(1);
    rows[0].leaseUntil = new Date(0);
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(rows[0].attempts).toBe(2);
    expect(process).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'wamid.synthetic' }),
      expect.objectContaining({ wa_id: '593990000001' }),
      true,
    );
  });

  it('retries attribution separately and never reclaims a permanent FAILED row', async () => {
    const { rows, service, inbox } = inboxHarness();
    const process = jest
      .spyOn(service as any, 'processIncomingMessage')
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('confirmed');
    await service.acceptWebhook(signedBody());
    await service.scan();
    expect(rows[0].outcome).toBe('RETRYABLE_ATTRIBUTION_ERROR');
    rows[0].leaseUntil = new Date(0);
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.COMPLETED);
    expect(process).toHaveBeenCalledTimes(2);
    const query = inbox.findMany.mock.calls[0][0].where.OR;
    expect(query).toContainEqual(
      expect.objectContaining({
        status: MetaWebhookInboxStatus.FAILED,
        outcome: {
          in: expect.arrayContaining(['RETRYABLE_ATTRIBUTION_ERROR']),
        },
      }),
    );
  });

  it('quarantines malformed signed envelopes instead of acknowledging and dropping them', async () => {
    const { rows, service } = inboxHarness();
    const body = signedBody();
    (body.entry[0] as unknown as Record<string, unknown>).changes = null;
    await service.acceptWebhook(body);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('INVALID_ENVELOPE');
    await service.scan();
    expect(rows[0].status).toBe(MetaWebhookInboxStatus.FAILED);
    expect(rows[0].outcome).toBe(
      'PERMANENT_INVALID_PAYLOAD:EVENT_TYPE_INVALID',
    );
  });
});
