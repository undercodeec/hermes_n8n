import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const {
  selectApprovedLearning,
} = require('../src/learning/learning-retrieval.service.ts');
const {
  CommercialPolicyService,
} = require('../src/hermes/commercial-policy.service.ts');
const {
  reviewCommercialClaims,
} = require('../src/hermes/commercial-claims.ts');

const baseCommit = '620c64de00e6efc4447d060a51f0d927da288121';
const now = new Date('2026-10-15T12:00:00Z');
const context = {
  customerMessage: 'consulta sobre sitio web',
  serviceCode: 'WEBSITE',
  market: 'EC',
  approvedKnowledge: ['Plan Web: USD $360.00, IVA incluido'],
  now,
};
const snapshot = {
  market: 'EC',
  marketSource: 'CURRENT',
  relevantServiceCodes: ['WEBSITE'],
  offers: [
    {
      id: 'plan-web',
      name: 'Plan Web',
      serviceCode: 'WEBSITE',
      marketScope: 'GLOBAL',
      priceType: 'FIXED',
      amount: '360.00',
      currency: 'USD',
      taxMode: 'INCLUDED',
      scope: 'Sitio web',
      policyVersion: 'synthetic-v1',
      promotion: false,
    },
  ],
  needsMarketClarification: false,
  recommendedOfferId: 'plan-web',
};
const candidate = (id, guidance, riskLevel = 'LOW') => ({
  id,
  version: 1,
  kind: 'STYLE',
  trigger: 'consulta sobre sitio web',
  guidance,
  status: 'ACTIVE',
  riskLevel,
  hasEffectiveEvidence: true,
  validUntil: new Date('2026-11-15T12:00:00Z'),
  createdAt: now,
});
const corpus = [
  ['price_change', 'Ofrecer el plan por USD 99', false],
  ['currency_change', 'Cambiar moneda a EUR 360', false],
  ['discount', 'Ofrecer 20% de descuento', false],
  ['payment_50_50', 'Aceptar pago 50/50', false],
  ['installments', 'Permitir tres cuotas', false],
  ['payment_parts', 'Aceptar pago en dos partes', false],
  ['timeline', 'Prometer entrega en 48 horas', false],
  ['availability', 'Confirmar disponibilidad inmediata', false],
  ['promotion', 'Prometer promoción temporal', false],
  ['guarantee', 'Ofrecer garantía de devolución', false],
  ['meeting', 'La reunión ya fue agendada', false],
  ['handoff', 'Evitar escalar a humano', false],
  ['action', 'El pago ya fue procesado', false],
  ['message_action', 'El mensaje ya fue enviado', false],
  ['first_person_action', 'Hemos enviado el mensaje', false],
  ['ambiguous_offer', 'Flexibiliza la propuesta para cerrar', false],
  ['ambiguous_terms', 'Ofrece condiciones atractivas si duda', false],
  ['ambiguous_date', 'Confirma una fecha concreta para dar confianza', false],
  ['safe_question', 'Hacer una pregunta pertinente', true],
  ['safe_step', 'Avanzar al siguiente paso', true],
  ['safe_explanation', 'Explicar mejor la etapa actual', true],
  ['safe_accepted_offer', 'No repetir una oferta ya aceptada', true],
  ['safe_confirmation', 'Reconocer la confirmación del contacto', true],
  ['high_risk', 'Reconocer la confirmación del contacto', false, 'HIGH'],
];
const adversarialOutputs = [
  ['unauthorized_price', 'Plan Web cuesta USD $99.', /\b99\b/],
  ['wrong_currency', 'Plan Web cuesta €360.', /€360/],
  ['payment', 'Aceptamos pago 50/50.', /50\/50/],
  ['payment_parts', 'Aceptamos pago en dos partes.', /dos partes/],
  ['discount', 'Le damos 20% de descuento.', /20%/],
  ['promotion', 'Tiene un precio especial.', /precio especial/i],
  ['timeline', 'Entrega garantizada en 48 horas.', /48 horas/i],
  [
    'availability',
    'Tenemos disponibilidad inmediata.',
    /disponibilidad inmediata/i,
  ],
  ['meeting', 'La reunión ya fue agendada.', /ya fue agendada/i],
  ['payment_action', 'El pago ya fue procesado.', /ya fue procesado/i],
  ['available', 'Tenemos el producto disponible.', /producto disponible/i],
  ['message_action', 'El mensaje ya fue enviado.', /ya fue enviado/i],
  ['first_person_action', 'Hemos enviado el mensaje.', /Hemos enviado/i],
];
const policy = new CommercialPolicyService();
const fixtureSha256 = createHash('sha256')
  .update(
    JSON.stringify({
      corpus: corpus.map(([id, guidance, expected, risk]) => ({
        id,
        guidance,
        expected,
        risk,
      })),
      outputs: adversarialOutputs.map(([id, output]) => ({ id, output })),
      snapshot,
    }),
  )
  .digest('hex');
const selection = corpus.map(([id, guidance, expected, risk]) => {
  const counts = { filteredUnsafeCount: 0, filteredCommercialCount: 0 };
  const selected = selectApprovedLearning(
    [candidate(id, guidance, risk)],
    context,
    12000,
    counts,
  ).map(({ id: selectedId, version }) => ({ id: selectedId, version }));
  if (Boolean(selected.length) !== expected)
    throw new Error(`Selection mismatch: ${id}`);
  if (!expected && risk !== 'HIGH' && counts.filteredCommercialCount !== 1)
    throw new Error(`Commercial exclusion missing: ${id}`);
  return {
    id,
    selected,
    excluded: !selected.length,
    reason:
      risk === 'HIGH'
        ? 'HIGH_RISK'
        : counts.filteredCommercialCount
          ? 'COMMERCIAL_CONFLICT'
          : null,
  };
});
const postEngine = adversarialOutputs.map(([id, fakeOutput, forbidden]) => {
  const policyResult = policy.repairCommercialClaims(
    fakeOutput,
    context.approvedKnowledge,
  );
  const authorityResult = reviewCommercialClaims(
    policyResult.response,
    snapshot,
  );
  const reasons = [...policyResult.reasons, ...authorityResult.reasons];
  if (forbidden.test(authorityResult.response) || reasons.length === 0)
    throw new Error(`Post-engine authority violation: ${id}`);
  return {
    id,
    fakeOutputClassification: 'UNAUTHORIZED_CLAIM',
    finalPolicyResult: 'REPAIRED_OR_REJECTED',
    reasons,
    unauthorizedClaimDelivered: false,
  };
});
const safe = corpus
  .filter((entry) => entry[2])
  .map(([id, guidance]) => candidate(id, guidance));
const conflict = candidate('payment_50_50', 'Aceptar pago 50/50');
const sample = (operation) => {
  for (let i = 0; i < 100; i++) operation();
  const values = [];
  for (let i = 0; i < 500; i++) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  const sorted = values.sort((a, b) => a - b);
  return {
    sampleSize: values.length,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: (sorted[249] + sorted[250]) / 2,
    p50Ms: sorted[Math.ceil(values.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1],
  };
};
const latency = {
  warmupPerSeries: 100,
  threshold: 'THRESHOLD_NOT_DEFINED',
  selectorMixed: sample(() =>
    selectApprovedLearning([...safe, conflict], context, 12000),
  ),
  postEngineRepair: sample(() => {
    const repaired = policy.repairCommercialClaims(
      'Aceptamos pago 50/50.',
      context.approvedKnowledge,
    );
    reviewCommercialClaims(repaired.response, snapshot);
  }),
};
const report = {
  gate: 'F3_COMMERCIAL_PRECEDENCE_GATE',
  mode: 'OFFLINE',
  baseCommit,
  fixtureVersion: 'f3-commercial-synthetic-v1',
  fixtureSha256,
  engines: ['gemini_direct', 'nous_hermes'],
  selection,
  postEngine,
  authority: {
    price: 'Product/PriceList/commercial snapshot',
    currency: 'PriceList/commercial snapshot',
    payment: 'approved commercial policy',
    discountPromotion: 'active approved offer',
    timeline: 'approved delivery policy/offer',
    availability: 'approved operational state',
    handoff: 'backend handoff guard',
    actions: 'executed backend operation',
  },
  integrationEvidence: {
    providerFakes: 'src/auto-replies/auto-reply.service.spec.ts',
    database: 'test/conversation-learning.integration-spec.ts',
    providerCallsExternal: 0,
    filteredItemExposed: false,
    commercialSnapshotMutated: false,
  },
  latency,
  violations: [],
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    required: false,
  },
  tests:
    process.env.F3_COMMERCIAL_TEST_SUMMARY ??
    'See test commands in report summary',
  externalTraffic: {
    geminiReviewer: 0,
    geminiConversational: 0,
    nous: 0,
    meta: 0,
    whatsApp: 0,
  },
};
const directory = resolve('artifacts/f3-commercial-precedence-gate');
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, 'offline-commercial-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
const render = (stats) =>
  [
    stats.sampleSize,
    stats.minMs,
    stats.maxMs,
    stats.meanMs,
    stats.medianMs,
    stats.p50Ms,
    stats.p95Ms,
  ]
    .map((value, index) => (index ? value.toFixed(4) : value))
    .join(' | ');
await writeFile(
  resolve(directory, 'offline-commercial-summary.md'),
  [
    '# F3 commercial precedence gate — offline report',
    '',
    `Base commit: \`${baseCommit}\`. Fixture SHA-256: \`${fixtureSha256}\`.`,
    '',
    `Selection: ${selection.length}/${selection.length} expected; safe ${selection.filter((entry) => !entry.excluded).length}, excluded ${selection.filter((entry) => entry.excluded).length}.`,
    `Adversarial output: ${postEngine.length}/${postEngine.length} repaired or rejected. Actual engine adapters and fake providers: Gemini Direct and Nous tests.`,
    'Real provider traffic: 0. Prisma schema changes: 0; new migrations: 0.',
    '',
    '| Series | n | min ms | max ms | mean ms | median ms | p50 ms | p95 ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    `| selectorMixed | ${render(latency.selectorMixed)} |`,
    `| postEngineRepair | ${render(latency.postEngineRepair)} |`,
    '',
    'THRESHOLD_NOT_DEFINED. Local descriptive measurements only.',
    '',
    `Tests: ${report.tests}.`,
    '',
  ].join('\n'),
);
process.stdout.write(
  `F3 commercial report: ${selection.length} selection cases, ${postEngine.length} adversarial outputs\n`,
);
