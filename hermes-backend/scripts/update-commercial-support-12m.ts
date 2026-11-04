/** Manual CRM maintenance. Never imported by the backend or a migration. */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { verifyManualMaintenanceEvidence } from './maintenance-evidence';

const plans = [
  ['commercial-website-launch', '360.00', false],
  ['commercial-website-growth', '510.00', false],
  ['commercial-website-authority', '1010.00', true],
  ['commercial-store-launch', '550.00', false],
  ['commercial-store-growth', '850.00', false],
  ['commercial-store-elite', '3490.00', true],
  ['commercial-landing-pro', '600.00', false],
  ['commercial-landing-premium', '1500.00', false],
] as const;

const ordinary = '12 meses de soporte técnico posteriores a la entrega';
const vip = '12 meses de soporte VIP prioritario posteriores a la entrega';

export function updateSupport(scope: string, isVip: boolean): string {
  const desired = isVip ? vip : ordinary;
  if (/\b(?:ilimitado|24\s*\/\s*7|mantenimiento evolutivo)\b/iu.test(scope))
    throw new Error('Unsupported support condition requires commercial review');
  const matches = [
    ...scope.matchAll(
      /\b(?:(?:un|una|1|tres|3|seis|6|doce|12)\s+mes(?:es)?|(?:un|1)\s+año)\s+de\s+soporte(?:\s+(?:técnico|VIP|prioritario)){0,2}(?:\s+posterior(?:es)?\s+a\s+la\s+entrega)?|\bsoporte(?:\s+(?:técnico|VIP|prioritario)){0,2}\s+por\s+(?:un|1|tres|3|seis|6|doce|12)\s+mes(?:es)?/giu,
    ),
  ];
  if (
    matches.length > 1 ||
    matches.length !== [...scope.matchAll(/\bsoporte\b/giu)].length
  )
    throw new Error('Multiple support terms require review');
  if (matches.length === 1) {
    const old = matches[0][0];
    if (!isVip && /\bVIP\b/iu.test(old))
      throw new Error('Unexpected VIP support on ordinary plan');
    if (old === desired) return scope;
    return scope.replace(old, desired);
  }
  if (/\bsoporte\b/iu.test(scope))
    throw new Error('Unrecognized support term requires commercial review');
  return `${scope.trim().replace(/[.\s]+$/u, '')}. ${desired}.`;
}

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes('--apply');
const rollbackId = value('--rollback-audit-id');
if (apply && rollbackId) throw new Error('Choose apply or rollback');
if (
  (apply || rollbackId) &&
  (!value('--authorization-id') || !value('--backup-id'))
)
  throw new Error('Authorization ID and verified backup ID are required');

const prisma = new PrismaClient();
type Catalog = Awaited<ReturnType<typeof readCatalog>>;
const readCatalog = (client: PrismaClient | Prisma.TransactionClient) =>
  client.product.findMany({
    where: { sku: { in: plans.map(([sku]) => sku) } },
    include: { priceLists: true },
  });

function inspectCatalog(products: Catalog, now: Date) {
  const failures: string[] = [];
  const changes: Array<{
    id: string;
    sku: string;
    before: string;
    after: string;
  }> = [];
  for (const [sku, expectedPrice, isVip] of plans) {
    const product = products.find((item) => item.sku === sku);
    const expectedService = sku.includes('website-')
      ? 'WEBSITE'
      : sku.includes('store-')
        ? 'ONLINE_STORE'
        : 'LANDING_PAGE';
    const current = product?.priceLists.filter(
      (row) =>
        row.isActive &&
        !row.isPromotion &&
        row.currency === 'USD' &&
        row.market === 'EC' &&
        row.validFrom <= now &&
        (!row.validUntil || row.validUntil >= now),
    );
    if (
      !product?.isActive ||
      product.serviceCode !== expectedService ||
      current?.length !== 1
    ) {
      failures.push(`${sku}: expected one active EC/USD PriceList`);
      continue;
    }
    const row = current[0];
    if (
      row.price?.toFixed(2) !== expectedPrice ||
      row.priceType !== 'FIXED' ||
      row.taxMode !== 'INCLUDED' ||
      row.taxLabel !== 'IVA' ||
      row.taxRatePercent !== null ||
      !row.scope?.trim() ||
      row.policyVersion !== 'ec-commercial-12m-v1' ||
      row.supersedesPriceListId !== null
    ) {
      failures.push(`${sku}: commercial fields diverged; ${row.id}`);
      continue;
    }
    try {
      const after = updateSupport(row.scope, isVip);
      if (after !== row.scope)
        changes.push({ id: row.id, sku, before: row.scope, after });
    } catch (error) {
      failures.push(
        `${sku}: ${error instanceof Error ? error.message : 'review required'}`,
      );
    }
  }
  return { changes, failures };
}

async function main() {
  const evidence =
    apply || rollbackId
      ? await verifyManualMaintenanceEvidence({
          operation: rollbackId
            ? 'COMMERCIAL_SUPPORT_ROLLBACK'
            : 'COMMERCIAL_SUPPORT_12M',
          authorizationId: value('--authorization-id'),
          backupId: value('--backup-id'),
          evidencePath: value('--evidence-file'),
        })
      : undefined;
  if (rollbackId) {
    const audit = await prisma.auditLog.findUnique({
      where: { id: rollbackId },
    });
    const changes = audit?.changes as
      | {
          before?: { scope: string };
          after?: { scope: string };
          authorizationId?: string;
        }
      | undefined;
    if (
      audit?.action !== 'COMMERCIAL_SUPPORT_12M' ||
      !audit.entityId ||
      !changes?.before?.scope ||
      !changes.after?.scope ||
      changes.authorizationId !== value('--authorization-id')
    )
      throw new Error('Audit record does not authorize this rollback');
    const row = await prisma.priceList.findUnique({
      where: { id: audit.entityId },
    });
    if (!row || row.scope !== changes.after.scope)
      throw new Error('PriceList changed since update; manual review required');
    const rollbackAuditId = randomUUID();
    await prisma.$transaction(
      async (tx) => {
        const current = await tx.priceList.findUnique({
          where: { id: row.id },
          include: { product: true },
        });
        if (
          !current?.product.isActive ||
          current.updatedAt.getTime() !== row.updatedAt.getTime() ||
          current.scope !== changes.after!.scope ||
          current.price?.toString() !== row.price?.toString() ||
          current.currency !== row.currency ||
          current.market !== row.market ||
          current.taxMode !== row.taxMode ||
          current.taxLabel !== row.taxLabel ||
          current.policyVersion !== row.policyVersion ||
          current.isPromotion !== row.isPromotion ||
          current.validFrom.getTime() !== row.validFrom.getTime() ||
          current.validUntil?.getTime() !== row.validUntil?.getTime()
        )
          throw new Error('Concurrent commercial change; rollback aborted');
        const changed = await tx.priceList.updateMany({
          where: {
            id: row.id,
            scope: changes.after!.scope,
            updatedAt: row.updatedAt,
          },
          data: { scope: changes.before!.scope },
        });
        if (changed.count !== 1) throw new Error('Concurrent PriceList change');
        await tx.auditLog.create({
          data: {
            id: rollbackAuditId,
            action: 'COMMERCIAL_SUPPORT_12M_ROLLBACK',
            entity: 'price_lists',
            entityId: row.id,
            changes: {
              sourceAuditId: rollbackId,
              authorizationId: value('--authorization-id'),
              backupId: value('--backup-id'),
              evidenceSha256: evidence?.evidenceSha256,
              before: { scope: changes.after!.scope },
              after: { scope: changes.before!.scope },
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    console.log(
      JSON.stringify({ result: 'ROLLED_BACK', auditId: rollbackAuditId }),
    );
    return;
  }

  const now = new Date();
  const products = await readCatalog(prisma);
  const { changes, failures } = inspectCatalog(products, now);
  console.log(
    JSON.stringify(
      { mode: apply ? 'APPLY' : 'PREFLIGHT', changes, failures },
      null,
      2,
    ),
  );
  if (failures.length)
    throw new Error('Preflight failed; no PriceList updated');
  if (!apply) return;
  const runId = randomUUID();
  await prisma.$transaction(
    async (tx) => {
      const current = await readCatalog(tx);
      const checked = inspectCatalog(current, new Date());
      if (
        checked.failures.length ||
        JSON.stringify(checked.changes) !== JSON.stringify(changes) ||
        current.some((product) => {
          const before = products.find((item) => item.id === product.id);
          return (
            !before ||
            product.updatedAt.getTime() !== before.updatedAt.getTime() ||
            product.priceLists.some((row) => {
              const prior = before.priceLists.find(
                (item) => item.id === row.id,
              );
              return (
                !prior || row.updatedAt.getTime() !== prior.updatedAt.getTime()
              );
            }) ||
            product.priceLists.length !== before.priceLists.length
          );
        })
      )
        throw new Error(
          'Commercial catalog changed after preflight; apply aborted',
        );
      for (const change of changes) {
        const before = products
          .flatMap((product) => product.priceLists)
          .find((row) => row.id === change.id)!;
        const changed = await tx.priceList.updateMany({
          where: {
            id: change.id,
            scope: change.before,
            updatedAt: before.updatedAt,
          },
          data: { scope: change.after },
        });
        if (changed.count !== 1)
          throw new Error(`Concurrent PriceList change: ${change.id}`);
        await tx.auditLog.create({
          data: {
            id: randomUUID(),
            action: 'COMMERCIAL_SUPPORT_12M',
            entity: 'price_lists',
            entityId: change.id,
            changes: {
              runId,
              sku: change.sku,
              reason:
                'Owner approved twelve months of support for eight EC/USD packages',
              authorizationId: value('--authorization-id'),
              backupId: value('--backup-id'),
              evidenceSha256: evidence?.evidenceSha256,
              before: { scope: change.before },
              after: { scope: change.after },
            },
          },
        });
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  console.log(
    JSON.stringify({ result: 'APPLIED', runId, changed: changes.length }),
  );
}

if (require.main === module)
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Unknown error');
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
