import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const now = new Date();
  const [
    products,
    currentPrices,
    documents,
    playbooks,
    pendingCallbacks,
    openHandoffs,
  ] = await Promise.all([
    prisma.product.count({ where: { isActive: true } }),
    prisma.priceList.count({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
      },
    }),
    prisma.knowledgeDocument.groupBy({
      by: ['type'],
      where: { isActive: true },
      _count: { _all: true },
    }),
    prisma.salesPlaybook.count({ where: { isActive: true } }),
    prisma.task.count({ where: { type: 'CALLBACK', status: 'PENDING' } }),
    prisma.humanHandoff.count({
      where: { status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } },
    }),
  ]);
  process.stdout.write(
    `${JSON.stringify({ products, currentPrices, documents, playbooks, pendingCallbacks, openHandoffs }, null, 2)}\n`,
  );
}

void run()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
