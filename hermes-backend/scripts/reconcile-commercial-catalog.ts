/** Manual catalog recovery only. Never run from boot, build, migration or deploy. */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { verifyManualMaintenanceEvidence } from './maintenance-evidence';

export const catalog = [
  {
    slug: 'website-launch',
    name: 'Plan de Lanzamiento',
    category: 'Sitio Web',
    serviceCode: 'WEBSITE',
    price: '360.00',
    scope:
      'Hasta cinco páginas, diseño profesional adaptable, dominio .com y hosting por un año, SSL, hasta cinco correos corporativos, formulario y WhatsApp, configuración inicial en Google y 12 meses de soporte técnico posteriores a la entrega.',
  },
  {
    slug: 'website-growth',
    name: 'Plan de Crecimiento',
    category: 'Sitio Web',
    serviceCode: 'WEBSITE',
    price: '510.00',
    scope:
      'Incluye el Plan de Lanzamiento y añade hasta ocho páginas, textos persuasivos, optimización de velocidad, posicionamiento local, Analytics y Search Console, integraciones y 12 meses de soporte técnico posteriores a la entrega.',
  },
  {
    slug: 'website-authority',
    name: 'Plan de Autoridad',
    category: 'Sitio Web',
    serviceCode: 'WEBSITE',
    price: '1010.00',
    scope:
      'Incluye el Plan de Crecimiento y añade diseño totalmente personalizado, automatización con IA, sistemas avanzados a medida, seguridad reforzada, campaña de Google Ads por un mes, seguimiento y 12 meses de soporte VIP prioritario posteriores a la entrega.',
  },
  {
    slug: 'store-launch',
    name: 'Tienda de Lanzamiento',
    category: 'Tienda Online',
    serviceCode: 'ONLINE_STORE',
    price: '550.00',
    scope:
      'Catálogo administrable, carga inicial de hasta 20 productos, carrito y pago seguro, dominio .com, hosting y SSL por un año, diseño adaptable, configuración de envíos, configuración inicial en Google, cinco correos corporativos, capacitación para gestionar la tienda y 12 meses de soporte técnico posteriores a la entrega.',
  },
  {
    slug: 'store-growth',
    name: 'Tienda de Crecimiento',
    category: 'Tienda Online',
    serviceCode: 'ONLINE_STORE',
    price: '850.00',
    scope:
      'Incluye Tienda de Lanzamiento, filtros avanzados, SEO técnico avanzado, recuperación de carritos abandonados, inventario en tiempo real, estrategia de envíos por zonas y condiciones, y 12 meses de soporte técnico posteriores a la entrega.',
  },
  {
    slug: 'store-elite',
    name: 'Tienda Élite',
    category: 'Tienda Online',
    serviceCode: 'ONLINE_STORE',
    price: '3490.00',
    scope:
      'Incluye Tienda de Crecimiento, tecnología ultra rápida, conexión con sistemas empresariales, recomendador con IA, ventas internacionales, automatización de marketing, facturación electrónica, seguridad reforzada, respaldos automáticos y 12 meses de soporte VIP prioritario posteriores a la entrega.',
  },
  {
    slug: 'landing-pro',
    name: 'Landing Pro',
    category: 'Landing Page',
    serviceCode: 'LANDING_PAGE',
    price: '600.00',
    scope:
      'Incluye Landing Básica, textos persuasivos, formulario optimizado, recurso promocional, Analytics e integración con WhatsApp y respuestas iniciales. 12 meses de soporte técnico posteriores a la entrega.',
  },
  {
    slug: 'landing-premium',
    name: 'Landing Premium',
    category: 'Landing Page',
    serviceCode: 'LANDING_PAGE',
    price: '1500.00',
    scope:
      'Incluye Landing Básica, palabras clave para Google, campaña de Google Ads por un mes y diseño personalizado con animaciones inmersivas. 12 meses de soporte técnico posteriores a la entrega.',
  },
] as const;

const productId = (slug: string) => `commercial-product-${slug}`;
const sku = (slug: string) => `commercial-${slug}`;
const priceId = (slug: string) => `commercial-price-${slug}-ec-12m-v1`;
const expectedTerms = (slug: string) => ({
  renewalUsdPerYear:
    slug === 'website-authority' || slug === 'store-elite' ? 80 : 40,
  estimatedBusinessDays:
    slug === 'website-launch' || slug === 'store-launch' ? 10 : 20,
});
type Db = PrismaClient | Prisma.TransactionClient;

async function readState(db: Db) {
  const products = await db.product.findMany({
    where: {
      OR: [
        { sku: { in: catalog.map((plan) => sku(plan.slug)) } },
        { id: { in: catalog.map((plan) => productId(plan.slug)) } },
      ],
    },
    include: { priceLists: true },
  });
  const reservedPrices = await db.priceList.findMany({
    where: { id: { in: catalog.map((plan) => priceId(plan.slug)) } },
  });
  return { products, reservedPrices };
}
type State = Awaited<ReturnType<typeof readState>>;

/** Returns only missing rows; any conflicting existing row blocks the entire run. */
export function inspectReconciliation(state: State) {
  const failures: string[] = [];
  const missing: Array<{ slug: string; product: boolean; price: boolean }> = [];
  for (const plan of catalog) {
    const existing = state.products.find((row) => row.sku === sku(plan.slug));
    const idOwner = state.products.find(
      (row) => row.id === productId(plan.slug),
    );
    if (idOwner && idOwner.sku !== sku(plan.slug)) {
      failures.push(
        `${plan.slug}: historical product ID belongs to another SKU`,
      );
      continue;
    }
    const metadata = existing?.metadata as { commercialTerms?: unknown } | null;
    const terms = metadata?.commercialTerms as
      | Record<string, unknown>
      | undefined;
    const approvedTerms = expectedTerms(plan.slug);
    if (
      existing &&
      (!existing.isActive ||
        existing.name !== plan.name ||
        existing.category !== plan.category ||
        existing.serviceCode !== plan.serviceCode ||
        terms?.renewalUsdPerYear !== approvedTerms.renewalUsdPerYear ||
        terms?.estimatedBusinessDays !== approvedTerms.estimatedBusinessDays)
    ) {
      failures.push(
        `${plan.slug}: existing Product differs from approved definition`,
      );
      continue;
    }
    const prices = existing?.priceLists ?? [];
    const target = prices.find((row) => row.id === priceId(plan.slug));
    if (
      state.reservedPrices.some(
        (row) =>
          row.id === priceId(plan.slug) && row.productId !== existing?.id,
      )
    ) {
      failures.push(
        `${plan.slug}: target PriceList ID belongs to another Product`,
      );
      continue;
    }
    if (prices.some((row) => row.isActive && row.id !== priceId(plan.slug))) {
      failures.push(
        `${plan.slug}: another active tariff exists; market and precedence require review`,
      );
      continue;
    }
    if (
      target &&
      (!target.isActive ||
        target.market !== 'EC' ||
        target.currency !== 'USD' ||
        target.price?.toFixed(2) !== plan.price ||
        target.priceType !== 'FIXED' ||
        target.taxMode !== 'INCLUDED' ||
        target.taxLabel !== 'IVA' ||
        target.taxRatePercent !== null ||
        target.scope !== plan.scope ||
        target.policyVersion !== 'ec-commercial-12m-v1' ||
        target.isPromotion ||
        target.supersedesPriceListId !== null ||
        target.validUntil !== null ||
        target.restrictions !== null)
    ) {
      failures.push(
        `${plan.slug}: existing EC tariff differs from approved definition`,
      );
      continue;
    }
    if (!existing || !target)
      missing.push({ slug: plan.slug, product: !existing, price: !target });
  }
  return { missing, failures };
}

const args = process.argv.slice(2);
const value = (flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const apply = args.includes('--apply');
const rollbackRunId = value('--rollback-run-id');
const prisma = new PrismaClient();

async function main() {
  if (apply && rollbackRunId) throw new Error('Choose apply or rollback');
  if (value('--market') !== 'EC')
    throw new Error('Market EC must be selected explicitly');
  const approval = value('--commercial-approval-id');
  if ((apply || rollbackRunId) && !approval)
    throw new Error('Signed commercial market approval is required');
  const evidence =
    apply || rollbackRunId
      ? await verifyManualMaintenanceEvidence({
          operation: rollbackRunId
            ? 'COMMERCIAL_CATALOG_ROLLBACK'
            : 'COMMERCIAL_CATALOG_RECONCILE',
          authorizationId: value('--authorization-id'),
          backupId: value('--backup-id'),
          evidencePath: value('--evidence-file'),
          commercialApprovalId: approval,
          approvedMarket: 'EC',
        })
      : undefined;

  if (rollbackRunId) {
    const records = (
      await prisma.auditLog.findMany({
        where: {
          action: 'COMMERCIAL_CATALOG_RECONCILE',
          entity: { in: ['products', 'price_lists'] },
        },
      })
    ).filter((record) => {
      const changes = record.changes as { runId?: string } | null;
      return changes?.runId === rollbackRunId;
    });
    if (!records.length) throw new Error('Reconciliation run not found');
    await prisma.$transaction(
      async (tx) => {
        for (const record of [...records].sort(
          (a, b) =>
            Number(b.entity === 'price_lists') -
            Number(a.entity === 'price_lists'),
        )) {
          const changes = record.changes as {
            after?: Record<string, unknown>;
            slug?: string;
          };
          if (!record.entityId || !changes?.after || !changes.slug)
            throw new Error('Incomplete reconciliation audit record');
          const plan = catalog.find((item) => item.slug === changes.slug);
          if (!plan) throw new Error('Unknown SKU in reconciliation audit');
          if (record.entity === 'price_lists') {
            const row = await tx.priceList.findUnique({
              where: { id: record.entityId },
            });
            if (
              !row ||
              row.productId !== String(changes.after.productId) ||
              row.scope !== plan.scope ||
              row.price?.toFixed(2) !== plan.price ||
              row.market !== 'EC' ||
              row.policyVersion !== 'ec-commercial-12m-v1' ||
              row.updatedAt.toISOString() !== changes.after.updatedAt
            )
              throw new Error(
                `PriceList changed since reconciliation: ${record.entityId}`,
              );
            await tx.priceList.delete({ where: { id: row.id } });
          } else {
            const row = await tx.product.findUnique({
              where: { id: record.entityId },
              include: { priceLists: true },
            });
            if (
              !row ||
              row.sku !== sku(plan.slug) ||
              row.priceLists.length ||
              row.updatedAt.toISOString() !== changes.after.updatedAt
            )
              throw new Error(
                `Product changed since reconciliation: ${record.entityId}`,
              );
            await tx.product.delete({ where: { id: row.id } });
          }
          await tx.auditLog.create({
            data: {
              action: 'COMMERCIAL_CATALOG_ROLLBACK',
              entity: record.entity,
              entityId: record.entityId,
              changes: {
                sourceAuditId: record.id,
                rollbackRunId,
                authorizationId: value('--authorization-id'),
                backupId: value('--backup-id'),
                evidenceSha256: evidence?.evidenceSha256,
              },
            },
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    console.log(
      JSON.stringify({
        result: 'ROLLED_BACK',
        rollbackRunId,
        rows: records.length,
      }),
    );
    return;
  }

  const before = await readState(prisma);
  const preflight = inspectReconciliation(before);
  console.log(
    JSON.stringify(
      { mode: apply ? 'APPLY' : 'PREFLIGHT', market: 'EC', ...preflight },
      null,
      2,
    ),
  );
  if (preflight.failures.length) throw new Error('Catalog preflight failed');
  if (!apply) return;
  const runId = randomUUID();
  await prisma.$transaction(
    async (tx) => {
      const inside = await readState(tx);
      if (
        JSON.stringify(inside) !== JSON.stringify(before) ||
        JSON.stringify(inspectReconciliation(inside)) !==
          JSON.stringify(preflight)
      )
        throw new Error('Catalog changed after preflight; apply aborted');
      for (const missing of preflight.missing) {
        const plan = catalog.find((item) => item.slug === missing.slug)!;
        let id = inside.products.find(
          (item) => item.sku === sku(plan.slug),
        )?.id;
        if (missing.product) {
          const product = await tx.product.create({
            data: {
              id: productId(plan.slug),
              sku: sku(plan.slug),
              name: plan.name,
              category: plan.category,
              serviceCode: plan.serviceCode,
              description: `${plan.name}, catálogo comercial EC.`,
              metadata: { commercialTerms: expectedTerms(plan.slug) },
            },
          });
          id = product.id;
          await tx.auditLog.create({
            data: {
              action: 'COMMERCIAL_CATALOG_RECONCILE',
              entity: 'products',
              entityId: id,
              changes: {
                runId,
                slug: plan.slug,
                authorizationId: value('--authorization-id'),
                commercialApprovalId: approval,
                evidenceSha256: evidence?.evidenceSha256,
                before: null,
                after: {
                  sku: product.sku,
                  updatedAt: product.updatedAt.toISOString(),
                },
              },
            },
          });
        }
        if (!id) throw new Error('Product ID missing');
        if (missing.price) {
          const price = await tx.priceList.create({
            data: {
              id: priceId(plan.slug),
              productId: id,
              name: 'Tarifa Ecuador aprobada',
              price: new Prisma.Decimal(plan.price),
              currency: 'USD',
              market: 'EC',
              priceType: 'FIXED',
              taxMode: 'INCLUDED',
              taxLabel: 'IVA',
              taxRatePercent: null,
              scope: plan.scope,
              policyVersion: 'ec-commercial-12m-v1',
              isPromotion: false,
              supersedesPriceListId: null,
              restrictions: null,
              validUntil: null,
              notes: `Aprobación comercial ${approval}; run ${runId}`,
            },
          });
          await tx.auditLog.create({
            data: {
              action: 'COMMERCIAL_CATALOG_RECONCILE',
              entity: 'price_lists',
              entityId: price.id,
              changes: {
                runId,
                slug: plan.slug,
                authorizationId: value('--authorization-id'),
                commercialApprovalId: approval,
                backupId: value('--backup-id'),
                evidenceSha256: evidence?.evidenceSha256,
                before: null,
                after: {
                  productId: id,
                  scope: price.scope,
                  price: price.price?.toFixed(2),
                  market: price.market,
                  updatedAt: price.updatedAt.toISOString(),
                },
              },
            },
          });
        }
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  console.log(
    JSON.stringify({
      result: 'APPLIED',
      runId,
      rows: preflight.missing.length,
    }),
  );
}

if (require.main === module)
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Unknown error');
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
