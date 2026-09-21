/* eslint-disable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/require-await
  -- This test uses a deliberately dynamic in-memory Prisma transaction double. */
import { MetaSendError, MetaService } from '../meta/meta.service';
import { AutomatedDeliveryService } from './automated-delivery.service';
import { PrepareAutomatedDeliveryBatch } from './automated-delivery.types';

type Row = Record<string, any>;

class DeliveryStore {
  rows: Row[] = [];
  messages: Row[] = [];
  failNextClaimTransaction = false;
  failConfirmationTransaction = false;
  conversation = { id: 'conversation-1', status: 'ACTIVE' };
  contact = {
    id: 'contact-1',
    waId: '593991234567',
    marketingConsentStatus: 'OPTED_IN',
  };
  handoff: Row | null = null;
  source = inbound('inbound-1', new Date());
  latestInbound = this.source;

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && 'lt' in expected) {
        return row[key] && row[key] < expected.lt;
      }
      if (expected && typeof expected === 'object' && 'in' in expected) {
        return expected.in.includes(row[key]);
      }
      return row[key] === expected;
    });
  }

  private apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? (row[key] || 0) + value.increment
          : value;
    }
    row.updatedAt = new Date();
  }

  readonly prisma = {
    automatedDelivery: {
      upsert: jest.fn(async ({ where, create }: Row) => {
        const existing = this.rows.find(
          (row) => row.operationKey === where.operationKey,
        );
        if (existing) return existing;
        const row = {
          id: `delivery-${this.rows.length + 1}`,
          status: 'PREPARED',
          attempts: 0,
          claimToken: null,
          claimExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        this.rows.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: Row) =>
        this.rows
          .filter((row) => this.matches(row, where || {}))
          .sort((a, b) => a.partIndex - b.partIndex),
      ),
      findUnique: jest.fn(async ({ where }: Row) =>
        this.rows.find((row) =>
          where.id
            ? row.id === where.id
            : row.operationKey === where.operationKey,
        ),
      ),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const matching = this.rows.filter((row) => this.matches(row, where));
        matching.forEach((row) => this.apply(row, data));
        return { count: matching.length };
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = this.rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('delivery missing');
        this.apply(row, data);
        return row;
      }),
    },
    conversation: {
      findUnique: jest.fn(async () => this.conversation),
    },
    contact: {
      findUnique: jest.fn(async () => this.contact),
    },
    humanHandoff: {
      findFirst: jest.fn(async () => this.handoff),
    },
    message: {
      findUnique: jest.fn(async () => this.source),
      findFirst: jest.fn(async () => this.latestInbound),
      create: jest.fn(async ({ data }: Row) => {
        const message = { id: `outbound-${this.messages.length + 1}`, ...data };
        this.messages.push(message);
        return message;
      }),
    },
    $executeRaw: jest.fn(async () => undefined),
    $transaction: jest.fn(async (callback: (tx: Row) => unknown) => {
      if (this.failNextClaimTransaction) {
        this.failNextClaimTransaction = false;
        throw new Error('claim transaction failed');
      }
      if (
        this.failConfirmationTransaction &&
        this.rows.some((row) => row.status === 'DISPATCHING')
      ) {
        this.failConfirmationTransaction = false;
        throw new Error('confirmation transaction failed');
      }
      return callback(this.prisma);
    }),
  };
}

function inbound(id: string, receivedAt: Date): Row {
  return {
    id,
    conversationId: 'conversation-1',
    direction: 'INBOUND',
    createdAt: receivedAt,
    rawPayload: { timestamp: String(Math.floor(receivedAt.getTime() / 1000)) },
  };
}

function batch(...contents: string[]): PrepareAutomatedDeliveryBatch {
  return {
    deliveryKind: 'HERMES_REPLY',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    sourceMessageId: 'inbound-1',
    sender: 'HERMES',
    allowHandedOff: false,
    parts: contents.map((content, partIndex) => ({ partIndex, content })),
  };
}

function confirmedMetaResponse(wamid: string) {
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: '593991234567', wa_id: '593991234567' }],
    messages: [{ id: wamid }],
  };
}

function preparedRow(overrides: Row = {}): Row {
  return {
    id: 'delivery-1',
    operationKey: 'inbound-1:HERMES_REPLY:0',
    deliveryKind: 'HERMES_REPLY',
    partIndex: 0,
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    sourceMessageId: 'inbound-1',
    sender: 'HERMES',
    content: 'respuesta',
    allowHandedOff: false,
    status: 'PREPARED',
    attempts: 0,
    claimToken: null,
    claimExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function expiredDispatchingRow(): Row {
  return preparedRow({
    status: 'DISPATCHING',
    claimToken: 'expired-claim',
    claimExpiresAt: new Date(Date.now() - 1_000),
  });
}

describe('AutomatedDeliveryService', () => {
  let store: DeliveryStore;
  let meta: { sendTextMessage: jest.Mock };
  let service: AutomatedDeliveryService;

  beforeEach(() => {
    store = new DeliveryStore();
    meta = {
      sendTextMessage: jest
        .fn()
        .mockResolvedValue(confirmedMetaResponse('wamid.1')),
    };
    service = new AutomatedDeliveryService(
      store.prisma,
      meta as unknown as MetaService,
    );
  });

  afterEach(() => service.onModuleDestroy());

  it('prepares every multipart operation before the first Meta call', async () => {
    const pendingAtFirstSend: number[] = [];
    meta.sendTextMessage.mockImplementation(async () => {
      pendingAtFirstSend.push(store.rows.length);
      return confirmedMetaResponse(`wamid.${pendingAtFirstSend.length}`);
    });
    await service.prepareBatch(batch('uno', 'dos'));
    await service.deliverPreparedBatch('inbound-1');
    expect(pendingAtFirstSend[0]).toBe(2);
  });

  it('lets only one concurrent worker claim an operation', async () => {
    await service.prepareBatch(batch('respuesta'));
    await Promise.all([
      service.deliverPreparedBatch('inbound-1'),
      service.deliverPreparedBatch('inbound-1'),
    ]);
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('retries safely when failure is provably before DISPATCHING', async () => {
    store.failNextClaimTransaction = true;
    await service.prepareBatch(batch('respuesta'));
    await expect(service.deliverPreparedBatch('inbound-1')).rejects.toThrow(
      'claim transaction failed',
    );
    expect(store.rows[0].status).toBe('PREPARED');
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    await service.deliverPreparedBatch('inbound-1');
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('treats an unexpected throw after claim as ambiguous', async () => {
    meta.sendTextMessage.mockRejectedValueOnce(
      new Error('process interrupted'),
    );
    await service.prepareBatch(batch('respuesta'));
    await service.deliverPreparedBatch('inbound-1');
    await service.deliverPreparedBatch('inbound-1');
    expect(store.rows[0].status).toBe('AMBIGUOUS');
    expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NEWER_INBOUND'],
    ['CONTACT_OPTED_OUT'],
    ['HANDOFF_ACTIVE'],
    ['CONVERSATION_NOT_ACTIVE'],
    ['WHATSAPP_TEMPLATE_REQUIRED'],
  ])('suppresses at the final boundary: %s', async (reasonCode) => {
    arrangeEligibilityFailure(store, reasonCode);
    await service.prepareBatch(batch('respuesta'));
    const result = await service.deliverPreparedBatch('inbound-1');
    expect(result).toEqual(
      expect.objectContaining({ terminal: true, reasonCode }),
    );
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it.each([
    [new MetaSendError('AMBIGUOUS', false, null, 'META_TRANSPORT_ERROR')],
    [new MetaSendError('AMBIGUOUS', false, 500, '500')],
    [new MetaSendError('AMBIGUOUS', false, 200, 'META_WAMID_MISSING')],
  ])(
    'marks an uncertain result ambiguous and never resends it',
    async (error) => {
      meta.sendTextMessage.mockRejectedValueOnce(error);
      await service.prepareBatch(batch('respuesta'));
      await service.deliverPreparedBatch('inbound-1');
      await service.deliverPreparedBatch('inbound-1');
      expect(meta.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(store.rows[0].status).toBe('AMBIGUOUS');
    },
  );

  it('returns an explicit 429 to PREPARED for a bounded queue retry', async () => {
    meta.sendTextMessage.mockRejectedValueOnce(
      new MetaSendError('DEFINITIVE_REJECTION', true, 429, '429'),
    );
    await service.prepareBatch(batch('respuesta'));
    await expect(
      service.deliverPreparedBatch('inbound-1'),
    ).rejects.toMatchObject({
      retryable: true,
    });
    expect(store.rows[0].status).toBe('PREPARED');
  });

  it('marks an expired DISPATCHING claim ambiguous on restart', async () => {
    store.rows.push(expiredDispatchingRow());
    await service.onApplicationBootstrap();
    expect(store.rows[0].status).toBe('AMBIGUOUS');
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('resumes a PREPARED batch after worker restart without regenerating it', async () => {
    store.rows.push(preparedRow({ content: 'contenido original' }));
    const result = await service.recoverBatch('inbound-1');
    expect(result).toEqual(
      expect.objectContaining({ handled: true, confirmed: 1 }),
    );
    expect(meta.sendTextMessage).toHaveBeenCalledWith(
      '593991234567',
      'contenido original',
    );
  });

  it('marks persistence failure after a confirmed Meta call ambiguous', async () => {
    meta.sendTextMessage.mockResolvedValue(confirmedMetaResponse('wamid.1'));
    store.failConfirmationTransaction = true;
    await service.prepareBatch(batch('respuesta'));
    await service.deliverPreparedBatch('inbound-1');
    expect(store.rows[0].status).toBe('AMBIGUOUS');
  });
});

function arrangeEligibilityFailure(store: DeliveryStore, reasonCode: string) {
  if (reasonCode === 'NEWER_INBOUND') {
    store.latestInbound = inbound('inbound-2', new Date(Date.now() + 1_000));
  } else if (reasonCode === 'CONTACT_OPTED_OUT') {
    store.contact.marketingConsentStatus = 'OPTED_OUT';
  } else if (reasonCode === 'HANDOFF_ACTIVE') {
    store.handoff = { id: 'handoff-1', status: 'PENDING' };
  } else if (reasonCode === 'CONVERSATION_NOT_ACTIVE') {
    store.conversation.status = 'PAUSED';
  } else if (reasonCode === 'WHATSAPP_TEMPLATE_REQUIRED') {
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    store.source = inbound('inbound-1', stale);
    store.latestInbound = store.source;
  }
}
