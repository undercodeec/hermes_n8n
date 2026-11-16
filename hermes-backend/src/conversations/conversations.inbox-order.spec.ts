import { ConversationStatus, Prisma } from '@prisma/client';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { originConversationWhere } from '../attribution-crm/attribution-crm';
import { ConversationsService } from './conversations.service';

describe('Pilot global inbox ordering', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 0, minute));
  const row = (id: string, minute: number | null) => ({
    id,
    updatedAt: at(500),
    metadata: null,
    handoffs: [] as { id: string }[],
    tasks: [],
    messages:
      minute === null ? [] : [{ id: `message-${id}`, createdAt: at(minute) }],
  });
  let rows: ReturnType<typeof row>[];
  const findMany = jest.fn<
    Promise<unknown[]>,
    [Prisma.ConversationFindManyArgs]
  >();
  const groupBy = jest.fn();
  const queryRaw = jest.fn<Promise<unknown[]>, [Prisma.Sql]>();
  const client = {
    conversation: { findMany },
    message: { groupBy },
    $queryRaw: queryRaw,
  };
  const transaction = jest.fn();
  const service = new ConversationsService(
    { $transaction: transaction } as unknown as PrismaService,
    {} as MetaService,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    transaction.mockImplementation((callback: (tx: typeof client) => unknown) =>
      callback(client),
    );
    rows = Array.from({ length: 65 }, (_, index) =>
      row(`chat-${String(index).padStart(3, '0')}`, index),
    );
    groupBy.mockResolvedValue([]);
    queryRaw.mockImplementation((query: Prisma.Sql) => {
      if (!query.sql.includes('unnest')) return Promise.resolve([]);
      const [ids, skip, limit] = query.values as [string[], number, number];
      return Promise.resolve(
        [...rows]
          .filter((item) => ids.includes(item.id))
          .sort((a, b) => {
            const aAt = a.messages[0]?.createdAt.getTime() ?? -Infinity;
            const bAt = b.messages[0]?.createdAt.getTime() ?? -Infinity;
            return aAt !== bAt
              ? aAt > bAt
                ? -1
                : 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0;
          })
          .slice(skip, skip + limit)
          .map(({ id }) => ({ id })),
      );
    });
    findMany.mockImplementation((args) => {
      if (args.select)
        return Promise.resolve(
          rows.map(({ id, messages }) => ({ id, messages })),
        );
      const ids = (args.where?.id as Prisma.StringFilter).in as string[];
      return Promise.resolve(rows.filter((item) => ids.includes(item.id)));
    });
  });
  it('ranks all 65 candidates before slicing and preserves projected hydration order', async () => {
    const first = await service.findAll({ page: 1, limit: 50 });
    const second = await service.findAll({ page: 2, limit: 50 });
    const expected = [...rows].reverse().map((item) => item.id);
    expect(first.data.map((item) => item.id)).toEqual(expected.slice(0, 50));
    expect(second.data.map((item) => item.id)).toEqual(expected.slice(50));
    expect(first).toMatchObject({ total: 65, totalPages: 2 });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(findMany.mock.calls[0][0]).toEqual({
      where: {},
      select: { id: true },
    });
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { id: { in: expected.slice(0, 50) } },
      include: {
        handoffs: {
          include: {
            assignedAgent: {
              select: { id: true, name: true, email: true, role: true },
            },
          },
        },
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(4); // ranking + attribution within transaction
    const rankQuery = queryRaw.mock.calls[0][0];
    expect(rankQuery.sql).toContain('LEFT JOIN LATERAL');
    expect(rankQuery.sql).toContain('NULLS LAST');
    expect(rankQuery.values).toEqual([rows.map((item) => item.id), 0, 50]);
    expect(rankQuery.sql).not.toContain('chat-'); // candidate IDs are parameters
    expect(first.data[0].attribution).toMatchObject({ origin: 'unknown' });
  });
  it('breaks timestamp ties across pages by ascending conversation id', async () => {
    rows.reverse().forEach((item) => (item.messages[0].createdAt = at(1)));
    const first = await service.findAll({ page: 1, limit: 50 });
    const second = await service.findAll({ page: 2, limit: 50 });
    expect([...first.data, ...second.data].map((item) => item.id)).toEqual(
      rows.map((item) => item.id).sort(),
    );
  });
  it('places empty conversations last and does not promote non-message activity', async () => {
    rows = [
      row('empty-z', null),
      row('old', 0),
      row('empty-a', null),
      row('new', 10),
    ];
    rows[1].updatedAt = at(1000);
    rows[1].handoffs = [{ id: 'handoff' }];
    const result = await service.findAll({ page: 1, limit: 50 });
    expect(result.data.map((item) => item.id)).toEqual([
      'new',
      'old',
      'empty-a',
      'empty-z',
    ]);
    expect(result.data[1].isPriority).toBe(true);
    rows[1].messages = [{ id: 'fresh', createdAt: at(1001) }];
    expect((await service.findAll({ page: 1, limit: 50 })).data[0].id).toBe(
      'old',
    );
  });
  it('retains pilot origin + priority AND filters before ranking alongside legacy filters', async () => {
    await service.findAll({
      page: 1,
      limit: 50,
      status: ConversationStatus.ACTIVE,
      query: 'fixture',
      intent: 'purchase',
      from: at(0).toISOString(),
      to: at(60).toISOString(),
      priorityOnly: true,
      origin: 'meta_ad',
    });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: ConversationStatus.ACTIVE,
      updatedAt: { gte: at(0), lte: at(60) },
      state: {
        is: { detectedIntent: { equals: 'purchase', mode: 'insensitive' } },
      },
    });
    expect(where?.contact).toBeDefined();
    expect(where?.AND).toHaveLength(2);
    expect(where?.AND).toContainEqual(originConversationWhere('meta_ad'));
  });
  it.each([0, 65])(
    'handles empty page with %i total matches',
    async (count) => {
      rows = rows.slice(0, count);
      expect(await service.findAll({ page: 3, limit: 50 })).toMatchObject({
        data: [],
        total: count,
      });
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(groupBy).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
    },
  );
  it('binds one array with SQL metacharacters and more than 32767 candidate IDs', async () => {
    rows = Array.from({ length: 33_000 }, (_, index) =>
      row(`id-${index}`, index),
    );
    rows[0].id = "quote'); DROP TABLE messages; --";
    await service.findAll({ page: 1, limit: 1 });
    const rankQuery = queryRaw.mock.calls[0][0];
    expect(rankQuery.values).toHaveLength(3);
    expect(rankQuery.values[0]).toHaveLength(33_000);
    expect(rankQuery.sql).not.toContain('DROP TABLE');
    expect(rankQuery.sql).toContain('::text[]');
  });
});
