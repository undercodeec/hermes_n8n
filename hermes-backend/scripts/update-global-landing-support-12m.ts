/** Separate manual maintenance for the existing GLOBAL Landing Básica tariff. */
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { verifyManualMaintenanceEvidence } from './maintenance-evidence';
import { updateSupport } from './commercial-support-scope';

const PRODUCT_ID = 'commercial-product-landing-basic';
const SKU = 'commercial-landing-basic';
const BASE_ID = 'commercial-price-landing-basic-global-v1';
const PROMOTION_ID = 'commercial-price-landing-black-friday-80-global-v1';
const ACTION = 'COMMERCIAL_GLOBAL_LANDING_SUPPORT_12M';
const ROLLBACK_ACTION = 'COMMERCIAL_GLOBAL_LANDING_SUPPORT_ROLLBACK';

export const GLOBAL_LANDING_SCOPE_BEFORE =
  'Una página, diseño adaptable, WhatsApp y llamada, formulario, beneficios, dominio .com y hosting básico por un año, cinco correos corporativos, SEO técnico base y un mes de soporte.';
export const GLOBAL_LANDING_SCOPE_AFTER = updateSupport(
  GLOBAL_LANDING_SCOPE_BEFORE,
  false,
);

const BLACK_FRIDAY_FEATURES = [
  'Captación de leads',
  'landing page de una sola sección',
  'diseño responsive para celulares',
  'botón flotante de WhatsApp y llamada directa',
  'formulario de contacto o captura de prospectos',
  'apartado de beneficios del servicio o producto',
  'dominio .com y hosting básico por 1 año',
  '5 correos corporativos',
  'SEO técnico base',
];

type Db = PrismaClient | Prisma.TransactionClient;
async function readState(db: Db) {
  const products = await db.product.findMany({
    where: { OR: [{ id: PRODUCT_ID }, { sku: SKU }] },
    include: { priceLists: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  const reservedPrices = await db.priceList.findMany({
    where: { id: { in: [BASE_ID, PROMOTION_ID] } },
    orderBy: { id: 'asc' },
  });
  return { products, reservedPrices };
}
type State = Awaited<ReturnType<typeof readState>>;
const stateSha256 = (state: State) =>
  createHash('sha256').update(JSON.stringify(state)).digest('hex');

/** Fail closed on missing, changed, or conflicting CRM rows. No row is repaired here. */
export function inspectGlobalLandingSupport(state: State, now = new Date()) {
  const failures: string[] = [];
  const product = state.products.find((row) => row.id === PRODUCT_ID);
  if (
    state.products.length !== 1 ||
    product?.sku !== SKU ||
    !product.isActive ||
    product.serviceCode !== 'LANDING_PAGE'
  )
    failures.push('Landing Básica Product identity or state differs');

  const base = product?.priceLists.find((row) => row.id === BASE_ID);
  const baseActive = product?.priceLists.filter(
    (row) => row.isActive && !row.isPromotion && row.market === null,
  );
  if (
    product?.priceLists.some(
      (row) => row.isActive && !row.isPromotion && row.market === 'EC',
    )
  )
    failures.push('Unexpected EC Landing Básica tariff requires market review');
  if (
    !base ||
    state.reservedPrices.find((row) => row.id === BASE_ID)?.productId !==
      PRODUCT_ID ||
    baseActive?.length !== 1 ||
    baseActive[0].id !== BASE_ID ||
    !base.isActive ||
    base.isPromotion ||
    base.productId !== PRODUCT_ID ||
    base.price?.toFixed(2) !== '250.00' ||
    base.currency !== 'USD' ||
    base.market !== null ||
    base.priceType !== 'FIXED' ||
    base.taxMode !== 'INCLUDED' ||
    base.taxLabel !== 'IVA' ||
    base.taxRatePercent !== null ||
    base.policyVersion !== 'global-v1' ||
    base.supersedesPriceListId !== null ||
    base.validFrom > now ||
    (base.validUntil !== null && base.validUntil < now)
  )
    failures.push(
      'Landing Básica GLOBAL PriceList differs from approved baseline',
    );

  if (
    base?.scope !== GLOBAL_LANDING_SCOPE_BEFORE &&
    base?.scope !== GLOBAL_LANDING_SCOPE_AFTER
  )
    failures.push('Landing Básica scope requires manual commercial review');

  const promotion = product?.priceLists.find((row) => row.id === PROMOTION_ID);
  const clauses = promotion?.scope?.split(';').map((part) => part.trim());
  if (
    !promotion ||
    state.reservedPrices.find((row) => row.id === PROMOTION_ID)?.productId !==
      PRODUCT_ID ||
    promotion.productId !== PRODUCT_ID ||
    promotion.supersedesPriceListId !== BASE_ID ||
    promotion.price?.toFixed(2) !== '80.00' ||
    promotion.currency !== 'USD' ||
    promotion.market !== null ||
    promotion.priceType !== 'FIXED' ||
    !promotion.isPromotion ||
    promotion.policyVersion !== 'black-friday-landing-80-v1' ||
    promotion.validFrom > now ||
    (promotion.validUntil !== null && promotion.validUntil < now) ||
    clauses?.length !== 10 ||
    !BLACK_FRIDAY_FEATURES.every(
      (feature, index) => clauses?.[index] === feature,
    ) ||
    !/^(?:12 meses|1 año|un año) de soporte técnico posterior(?:es)? a la entrega\.$/iu.test(
      clauses?.[9] ?? '',
    )
  )
    failures.push(
      'Black Friday relationship, price or ten approved features differ',
    );

  return {
    failures,
    change:
      failures.length === 0 && base?.scope === GLOBAL_LANDING_SCOPE_BEFORE
        ? {
            id: BASE_ID,
            before: GLOBAL_LANDING_SCOPE_BEFORE,
            after: GLOBAL_LANDING_SCOPE_AFTER,
          }
        : undefined,
  };
}

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const apply = args.includes('--apply');
const rollbackId = value('--rollback-audit-id');
const prisma = new PrismaClient();

async function main() {
  if (apply && rollbackId) throw new Error('Choose apply or rollback');
  const approval = value('--commercial-approval-id');
  if ((apply || rollbackId) && !approval)
    throw new Error('Option B commercial approval ID is required');
  const evidence =
    apply || rollbackId
      ? await verifyManualMaintenanceEvidence({
          operation: rollbackId ? ROLLBACK_ACTION : ACTION,
          authorizationId: value('--authorization-id'),
          backupId: value('--backup-id'),
          evidencePath: value('--evidence-file'),
          commercialApprovalId: approval,
          approvedMarket: 'GLOBAL',
        })
      : undefined;

  const before = await readState(prisma);
  const checked = inspectGlobalLandingSupport(before);
  if (checked.failures.length)
    throw new Error(
      `Global landing preflight failed: ${checked.failures.join('; ')}`,
    );
  if (rollbackId) {
    const audit = await prisma.auditLog.findUnique({
      where: { id: rollbackId },
    });
    const prior = audit?.changes as
      | {
          before?: { scope: string };
          after?: { scope: string; stateSha256: string };
          authorizationId?: string;
          commercialApprovalId?: string;
        }
      | undefined;
    if (
      audit?.action !== ACTION ||
      audit.entityId !== BASE_ID ||
      prior?.before?.scope !== GLOBAL_LANDING_SCOPE_BEFORE ||
      prior.after?.scope !== GLOBAL_LANDING_SCOPE_AFTER ||
      prior.after.stateSha256 !== stateSha256(before) ||
      prior.authorizationId !== value('--authorization-id') ||
      prior.commercialApprovalId !== approval ||
      checked.change
    )
      throw new Error('Audit record does not authorize this rollback');
    await prisma.$transaction(
      async (tx) => {
        const inside = await readState(tx);
        if (
          JSON.stringify(inside) !== JSON.stringify(before) ||
          inspectGlobalLandingSupport(inside).failures.length
        )
          throw new Error('Global landing changed before rollback');
        const base = before.reservedPrices.find((row) => row.id === BASE_ID)!;
        const changed = await tx.priceList.updateMany({
          where: {
            id: BASE_ID,
            scope: GLOBAL_LANDING_SCOPE_AFTER,
            updatedAt: base.updatedAt,
          },
          data: { scope: GLOBAL_LANDING_SCOPE_BEFORE },
        });
        if (changed.count !== 1)
          throw new Error('Concurrent global PriceList change');
        await tx.auditLog.create({
          data: {
            action: ROLLBACK_ACTION,
            entity: 'price_lists',
            entityId: BASE_ID,
            changes: {
              sourceAuditId: rollbackId,
              authorizationId: value('--authorization-id'),
              commercialApprovalId: approval,
              backupId: value('--backup-id'),
              evidenceSha256: evidence?.evidenceSha256,
              before: { scope: GLOBAL_LANDING_SCOPE_AFTER },
              after: { scope: GLOBAL_LANDING_SCOPE_BEFORE },
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    console.log(
      JSON.stringify({ result: 'ROLLED_BACK', sourceAuditId: rollbackId }),
    );
    return;
  }

  console.log(
    JSON.stringify(
      { mode: apply ? 'APPLY' : 'PREFLIGHT', target: BASE_ID, ...checked },
      null,
      2,
    ),
  );
  if (!apply || !checked.change) return;
  const runId = randomUUID();
  await prisma.$transaction(
    async (tx) => {
      const inside = await readState(tx);
      const confirmed = inspectGlobalLandingSupport(inside);
      if (
        JSON.stringify(inside) !== JSON.stringify(before) ||
        JSON.stringify(confirmed) !== JSON.stringify(checked)
      )
        throw new Error('Global landing changed after preflight');
      const base = before.reservedPrices.find((row) => row.id === BASE_ID)!;
      const changed = await tx.priceList.updateMany({
        where: {
          id: BASE_ID,
          scope: checked.change!.before,
          updatedAt: base.updatedAt,
        },
        data: { scope: checked.change!.after },
      });
      if (changed.count !== 1)
        throw new Error('Concurrent global PriceList change');
      const after = await readState(tx);
      await tx.auditLog.create({
        data: {
          action: ACTION,
          entity: 'price_lists',
          entityId: BASE_ID,
          changes: {
            runId,
            authorizationId: value('--authorization-id'),
            commercialApprovalId: approval,
            backupId: value('--backup-id'),
            evidenceSha256: evidence?.evidenceSha256,
            before: { scope: checked.change!.before },
            after: {
              scope: checked.change!.after,
              stateSha256: stateSha256(after),
            },
          },
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  console.log(JSON.stringify({ result: 'APPLIED', runId, changed: 1 }));
}

if (require.main === module)
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Unknown error');
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
