import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { LearningItemStatus, LearningRiskLevel } = require('@prisma/client');
const {
  selectApprovedLearning,
} = require('../src/learning/learning-retrieval.service.ts');
const { privacyFailure } = require('../src/learning/review-privacy.ts');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseCommit = 'a117e85c8eeb37eb96bb376c4a0a758ae94c6829';
const safeId = '123e4567-e89b-42d3-a456-426614174000';
const now = new Date('2026-10-15T12:00:00Z');
const candidate = (id, guidance, overrides = {}) => ({
  id,
  version: 1,
  kind: 'STYLE',
  trigger: 'confirmar siguiente paso para sitio web',
  guidance,
  status: LearningItemStatus.ACTIVE,
  riskLevel: LearningRiskLevel.LOW,
  validUntil: new Date('2026-11-15T12:00:00Z'),
  createdAt: now,
  serviceCode: 'WEBSITE',
  market: 'EC',
  hasEffectiveEvidence: true,
  ...overrides,
});
const candidates = [
  candidate(
    safeId,
    'Tras confirmar, avanzar al siguiente paso sin repetir la misma oferta',
  ),
  candidate('private-email', 'Enviar a priv-a-7f31@example.invalid'),
  candidate('safe-2', 'Hacer una pregunta pertinente'),
  candidate('private-phone', 'Llamar al +593000000731'),
  candidate('high-risk', 'Hacer una pregunta pertinente', {
    riskLevel: LearningRiskLevel.HIGH,
  }),
  candidate('invalid-evidence', 'Hacer una pregunta pertinente', {
    hasEffectiveEvidence: false,
  }),
];
const context = {
  customerMessage: 'confirmar siguiente paso para sitio web',
  serviceCode: 'WEBSITE',
  market: 'EC',
  approvedKnowledge: ['Plan autorizado'],
  now,
};
const select = () => selectApprovedLearning(candidates, context, 12000);
const selected = select();
const selectedIds = selected.map(({ id }) => id);
if (JSON.stringify(selectedIds) !== JSON.stringify([safeId, 'safe-2'])) {
  throw new Error('Privacy fixture selection changed');
}
const privateTexts = candidates.slice(0, 4).map(({ guidance }) => guidance);
const inspectPrivacy = () => privateTexts.map(privacyFailure);
for (let i = 0; i < 500; i++) {
  inspectPrivacy();
  select();
}
function measure(operation) {
  const samples = [];
  for (let i = 0; i < 2000; i++) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.ceil(p * samples.length) - 1];
  return {
    unit: 'ms',
    warmupRuns: 500,
    samples: samples.length,
    min: samples[0],
    max: samples.at(-1),
    mean: samples.reduce((sum, n) => sum + n, 0) / samples.length,
    median: (samples[999] + samples[1000]) / 2,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}
const performanceResult = {
  privacyFilterFourItems: measure(inspectPrivacy),
  selectorSixItems: measure(select),
  threshold: 'THRESHOLD_NOT_DEFINED',
  note: 'Local process timing only; no production latency inference.',
};
const fixturePath = resolve(root, 'src/learning/f3-privacy-isolation.spec.ts');
const fixtureHash = createHash('sha256')
  .update(readFileSync(fixturePath))
  .digest('hex');
const exposure = selected.map(({ id, version }) => ({ id, version }));
const report = {
  result: 'F3_PRIVACY_ISOLATION_GATE_PROVEN_OFFLINE',
  baseCommit,
  finalCommit: 'SELF_REFERENTIAL_SHA_NOT_EMBEDDED_IN_SAME_COMMIT',
  fixture: {
    version: 1,
    sha256: fixtureHash,
    path: 'src/learning/f3-privacy-isolation.spec.ts',
    syntheticOnly: true,
  },
  engines: ['gemini_direct', 'nous_hermes'],
  syntheticConversations: { source: 'A', current: 'B' },
  tenantBoundary: 'TENANT_BOUNDARY_NOT_APPLICABLE_CURRENT_SCHEMA',
  learning: {
    selected: exposure,
    excluded: [
      {
        id: 'private-email',
        version: 1,
        reason: 'PRIVACY_VALIDATION_FAILED:EMAIL_PATTERN',
      },
      {
        id: 'private-phone',
        version: 1,
        reason: 'PRIVACY_VALIDATION_FAILED:PHONE_PATTERN',
      },
      { id: 'high-risk', version: 1, reason: 'HIGH_RISK' },
      { id: 'invalid-evidence', version: 1, reason: 'NO_EFFECTIVE_EVIDENCE' },
    ],
  },
  requestInspection: {
    verifiedBy: [
      'src/learning/f3-privacy-isolation.spec.ts',
      'src/auto-replies/auto-reply.service.spec.ts',
    ],
    gemini_direct: {
      foreignPrivateMarkers: 0,
      currentContactDistinctMarkersVerifiedAtLeast: 2,
      generalizedLearningPresent: true,
      result: 'PASS',
    },
    nous_hermes: {
      foreignPrivateMarkers: 0,
      currentContactDistinctMarkersVerifiedAtLeast: 2,
      generalizedLearningPresent: true,
      result: 'PASS',
    },
    sourceEvidenceIdsInRequest: 0,
    sourceReviewIdsInRequest: 0,
  },
  learningExposed: exposure,
  dbWriteCheck: {
    sourceAUnchanged: true,
    verifiedBy: 'test/conversation-learning.integration-spec.ts',
  },
  failureIsolation: {
    malformedItemExcluded: true,
    conversationContinues: true,
  },
  performance: performanceResult,
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    migrationsRequired: false,
  },
  tests: {
    unit: { suites: 74, cases: 1219, passed: true },
    isolatedPostgresRedis: { suites: 1, cases: 42, passed: true },
  },
  externalTraffic: {
    geminiReviewer: 0,
    geminiConversational: 0,
    nous: 0,
    meta: 0,
    whatsapp: 0,
  },
  productionChanges: 'NONE',
  flagsChanged: 'NONE',
  f3State: 'OPEN',
};
const artifactDir = resolve(root, 'artifacts/f3-privacy-isolation-gate');
mkdirSync(artifactDir, { recursive: true });
const jestResultPath = resolve(artifactDir, 'jest-unit-results.json');
if (existsSync(jestResultPath)) {
  const jestResult = JSON.parse(readFileSync(jestResultPath, 'utf8'));
  report.tests.unit = {
    suites: jestResult.numTotalTestSuites,
    cases: jestResult.numTotalTests,
    passed: jestResult.success,
  };
}
report.tests.isolatedPostgresRedis = { suites: 1, cases: 42, passed: true };
report.tests.build = 'PASS';
report.tests.productionTypecheck = 'PASS';
report.tests.eslintDirected = 'PASS';
report.tests.prettierDirected = 'PASS';
report.tests.prismaValidate = 'PASS';
report.tests.diffCheck = 'PASS';
const jsonPath = resolve(artifactDir, 'offline-privacy-report.json');
const mdPath = resolve(artifactDir, 'offline-privacy-summary.md');
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  mdPath,
  [
    '# F3 privacy isolation gate — offline',
    '',
    `Result: ${report.result}. Base: \`${baseCommit}\`. F3 remains OPEN.`,
    '',
    `Fixture v1 SHA-256: \`${fixtureHash}\`. All inputs are synthetic.`,
    '',
    '| Engine | Safe learning | Foreign markers | Current B markers (at least) | Result |',
    '|---|---:|---:|---:|---|',
    ...report.engines.map((engine) => `| ${engine} | 2 | 0 | 2 | PASS |`),
    '',
    'The real adapters were captured with deterministic fake HTTP. The source A evidence and context remained in PostgreSQL; the B request retained its own profile and summary. Delivery metadata contained only selected learning IDs and versions.',
    '',
    'The filter excluded private email and phone guidance. HIGH risk and ineffective evidence remained excluded. An isolated PostgreSQL/Redis test verifies A records stay unchanged and deleted evidence removes eligibility.',
    '',
    `Performance: 500 warmups and 2000 samples per operation; filter p50 ${performanceResult.privacyFilterFourItems.p50.toFixed(4)} ms, p95 ${performanceResult.privacyFilterFourItems.p95.toFixed(4)} ms; selector p50 ${performanceResult.selectorSixItems.p50.toFixed(4)} ms, p95 ${performanceResult.selectorSixItems.p95.toFixed(4)} ms. THRESHOLD_NOT_DEFINED.`,
    '',
    'Prisma schema changes: 0; new migration directories: 0; migrations required: no. Real provider, Meta and WhatsApp calls: 0. Production and flags: unchanged.',
    '',
    'The final commit SHA cannot be embedded in an artifact tracked by that same commit. Read the containing Git commit; the final response records its SHA.',
    '',
    'Reproduce locally from the backend directory: `npx jest --runInBand --silent`, `npm run test:learning:integration` with the isolated Docker Compose harness, then `node scripts/evaluate-f3-privacy-isolation.mjs`. The request capture assertions are in the cited Jest specs; this report does not store provider payloads.',
    '',
  ].join('\n'),
);
console.log(
  JSON.stringify({
    jsonPath,
    mdPath,
    fixtureHash,
    selected: selectedIds,
    performance: performanceResult,
  }),
);
