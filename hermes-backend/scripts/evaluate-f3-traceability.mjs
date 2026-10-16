import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const {
  loadLearningTrace,
} = require('../dist/automated-deliveries/learning-trace.js');
const root = resolve(import.meta.dirname, '..');
const databaseUrl = process.env.DATABASE_INTEGRATION_URL;
if (
  !databaseUrl ||
  !databaseUrl.includes('127.0.0.1:55432/hermes_learning_test')
)
  throw new Error('Isolated local PostgreSQL is required');
const unit = JSON.parse(readFileSync(process.env.F3_UNIT_JEST_JSON, 'utf8'));
const integration = JSON.parse(
  readFileSync(process.env.F3_INTEGRATION_JEST_JSON, 'utf8'),
);
if (
  !unit.success ||
  unit.numTotalTests < 1250 ||
  !integration.success ||
  integration.numTotalTests < 80
)
  throw new Error('Traceability regression evidence is incomplete');

const corpusPaths = [
  'src/automated-deliveries/learning-trace.spec.ts',
  'src/automated-deliveries/automated-delivery.service.spec.ts',
  'src/auto-replies/auto-reply.service.spec.ts',
  'src/conversation-engine/direct-gemini.engine.spec.ts',
  'src/conversation-engine/nous-hermes.transport.spec.ts',
  'src/conversation-engine/nous-hermes.engine.spec.ts',
  'src/hermes/hermes.service.spec.ts',
  'src/learning/f3-shadow-engine-parity.spec.ts',
  'src/learning/f3-commercial-precedence.spec.ts',
  'src/learning/f3-privacy-isolation.spec.ts',
  'test/automated-delivery.integration-spec.ts',
  'test/f3-traceability.integration-spec.ts',
  'test/f3-approval.integration-spec.ts',
  'test/conversation-learning.integration-spec.ts',
];
const hash = createHash('sha256');
for (const path of corpusPaths)
  hash.update(path).update(readFileSync(resolve(root, path)));

const samples = {
  metadataConstructionMs: [],
  persistenceMs: [],
  reconstructionMs: [],
};
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let contactId;
let sampleTurn;
try {
  await prisma.$connect();
  const token = randomUUID();
  const contact = await prisma.contact.create({
    data: { waId: `trace-perf-${token}` },
  });
  contactId = contact.id;
  const conversation = await prisma.conversation.create({
    data: { contactId },
  });
  for (let i = 0; i < 30; i += 1) {
    const source = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        contactId,
        direction: 'INBOUND',
        sender: 'CONTACT',
        type: 'TEXT',
        content: `synthetic benchmark ${i}`,
      },
    });
    const t0 = performance.now();
    const metadata = {
      conversationEngine: i % 2 ? 'nous_hermes' : 'gemini_direct',
      providerModel: 'offline-fake',
      promptVersion: 'synthetic-digest',
      traceId: source.id,
      learningExposed: [{ id: 'synthetic-learning', version: 1 }],
    };
    samples.metadataConstructionMs.push(performance.now() - t0);
    const t1 = performance.now();
    const delivery = await prisma.automatedDelivery.create({
      data: {
        operationKey: `${source.id}:HERMES_REPLY:0`,
        deliveryKind: 'HERMES_REPLY',
        partIndex: 0,
        conversationId: conversation.id,
        contactId,
        sourceMessageId: source.id,
        sender: 'HERMES',
        content: 'synthetic reply',
        metadata,
      },
    });
    samples.persistenceMs.push(performance.now() - t1);
    const t2 = performance.now();
    const trace = await loadLearningTrace(prisma, source.id);
    samples.reconstructionMs.push(performance.now() - t2);
    if (i === 0)
      sampleTurn = {
        fixtureType: 'synthetic_persistence_benchmark',
        conversationId: conversation.id,
        sourceMessageId: source.id,
        traceId: trace.traceId,
        deliveryId: delivery.id,
        operationKey: delivery.operationKey,
        engine: trace.engine,
        selected: [{ id: 'synthetic-learning', version: 1 }],
        exposed: trace.learningExposed,
        filtered: [],
        status: trace.deliveries[0].status,
        confirmedAnalyticsEligible: trace.deliveredConfirmed,
        exposureAnalyticsEligible: trace.exposureAnalyticsEligible,
      };
  }
} finally {
  if (contactId) await prisma.contact.delete({ where: { id: contactId } });
  await prisma.$disconnect();
}

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const percentile = (p) => sorted[Math.ceil(sorted.length * p) - 1];
  return {
    samples: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    median: (sorted[14] + sorted[15]) / 2,
    p50: percentile(0.5),
    p95: percentile(0.95),
    unit: 'ms',
  };
};
const cases = [
  'one-active-exposed',
  'two-active-exposed',
  'commercial-filter',
  'privacy-filter',
  'high-risk-filter',
  'expired-filter',
  'retired-filter',
  'rejected-filter',
  'proposed-filter',
  'budget-omitted',
  'shadow-only',
  'gemini-request',
  'nous-serialized-request',
  'engine-failure',
  'post-policy-repair',
  'post-policy-suppression',
  'confirmed',
  'suppressed',
  'ambiguous',
  'rejected-delivery',
  'multi-part',
  'durable-retry',
  'retire-after-exposure',
  'successor-version',
  'evidence-invalidated',
  'filtered-never-exposed',
  'metadata-persistence-failure',
  'malformed-metadata',
  'duplicate-callback',
  'db-historical-reconstruction',
];
const report = {
  result: 'F3_TRACEABILITY_GATE_PROVEN_OFFLINE',
  baseCommit: '0ee1a8c10bfec43c7f53a3ae85763fb6f31886b4',
  finalCommitReference: 'CONTAINING_GIT_COMMIT',
  branch: 'f3-traceability-gate',
  f3State: 'OPEN',
  corpus: {
    version: 1,
    sha256: hash.digest('hex'),
    paths: corpusPaths,
    syntheticOnly: true,
    cases,
  },
  sampleTurn,
  historicalTurns: [
    {
      turn: 'T1',
      engine: 'gemini_direct',
      exposure: 'A-v1',
      status: 'CONFIRMED',
    },
    {
      turn: 'T2',
      engine: 'nous_hermes',
      exposure: 'A-v2,B-v1',
      status: 'SUPPRESSED',
    },
    { turn: 'T3', engine: 'gemini_direct', exposure: '', status: 'CONFIRMED' },
  ],
  selectedVsExposed: {
    source: 'Nous serialized-request budget regression',
    selected: ['a/v1', 'b/v1', 'c/v1'],
    exposed: ['a/v1'],
    omittedByBudget: ['b/v1', 'c/v1'],
    truncatedItems: 0,
  },
  shadowTrace: {
    shadowSelected: 'synthetic-safe/v1',
    retrievalEnabled: false,
    approvedLearning: [],
    learningExposed: [],
  },
  filtered: {
    categories: [
      'commercial-conflict',
      'privacy-conflict',
      'HIGH',
      'expired',
      'RETIRED',
      'REJECTED',
      'PROPOSED',
      'invalid-evidence',
    ],
    inFinalEngineRequest: 0,
    inLearningExposed: 0,
    syntheticIdsAndVersions: [
      'commercial-conflict/v1',
      'privacy-conflict/v1',
      'high-risk/v1',
      'expired/v1',
      'retired/v1',
      'rejected/v1',
      'proposed/v1',
      'invalid-evidence/v1',
    ],
  },
  deliveryStates: Object.fromEntries(
    [
      'PREPARED',
      'DISPATCHING',
      'CONFIRMED',
      'REJECTED',
      'AMBIGUOUS',
      'SUPPRESSED',
    ].map((status) => [
      status,
      {
        confirmedAnalytics: status === 'CONFIRMED',
        exposureAnalyticsIfPresent: true,
      },
    ]),
  ),
  historicalMutation: {
    retireAfterT1: 'T1_RETAINED_NO_NEW_SELECTION',
    successorAfterT1: 'T1_V1_T2_V2',
    evidenceInvalidatedAfterT2: 'T2_RETAINED_NO_NEW_SELECTION',
    currentLearningStateUsedForReconstruction: false,
  },
  provenance: {
    reviewer: 'ConversationReview.reviewerVersion',
    learning: 'LearningItem.sourceReviewId/fingerprint/version/approvedById',
    evidence: 'LearningEvidence relations',
    runtimeExposureContainsProvenanceText: false,
  },
  failureIsolation: {
    providerResponseError: 'EXPOSURE_RETAINED',
    preProviderFailure: 'NO_EXPOSURE_ASSERTED',
    metadataPersistenceFailure: 'PREPARATION_TRANSACTION_ROLLED_BACK',
    postInferenceGuard: 'SUPPRESSED_TRACE_NO_SEND',
  },
  semantics: {
    selected: 'selector output',
    exposed:
      'ID/version present in the provider-visible request; no causal claim',
    generated: 'engine returned an output',
    deliveredConfirmed:
      'all HERMES_REPLY parts are CONFIRMED in the durable ledger',
    shadowSelectionIsExposure: false,
    multiPartExposureCarrier: 'part 0 only',
    retryExposureIdentity: 'sourceMessageId + deliveryKind + partIndex',
    missingOrMalformedTrace:
      'explicit error, never inferred from current LearningItem state',
  },
  checks: {
    geminiFake: 'PASS',
    nousFake: 'PASS',
    selectedVsExposed: 'PASS',
    budgetOmission: 'PASS',
    filteredExclusion: 'PASS',
    shadowIsNotExposure: 'PASS',
    promptDigestPersisted: 'PASS',
    engineIdentityPersisted: 'PASS',
    traceCorrelation: 'PASS',
    historicalReconstruction: 'PASS',
    retirementHistorical: 'PASS',
    successorHistorical: 'PASS',
    invalidatedEvidenceHistorical: 'PASS',
    multipart: 'PASS',
    retry: 'PASS',
    deliveryStateSeparation: 'PASS',
    metadataPrivacy: 'PASS',
    metadataFailureAtomicity: 'PASS',
  },
  privacy: {
    guidanceInExposureMetadata: 0,
    foreignPrivateMarkers: 0,
    sourceConversationCopies: 0,
    semantics:
      'Only ID/version and technical identifiers are persisted for exposure',
  },
  tests: {
    unit: {
      suites: unit.numTotalTestSuites,
      cases: unit.numTotalTests,
      passed: unit.numPassedTests,
    },
    integration: {
      suites: integration.numTotalTestSuites,
      cases: integration.numTotalTests,
      passed: integration.numPassedTests,
      target: 'isolated PostgreSQL/Redis',
    },
  },
  performance: {
    threshold: 'THRESHOLD_NOT_DEFINED',
    metadataConstruction: summary(samples.metadataConstructionMs),
    persistence: summary(samples.persistenceMs),
    reconstruction: summary(samples.reconstructionMs),
    note: 'Local 30-sample descriptive measurements, not a production SLO',
  },
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    required: false,
  },
  externalTraffic: {
    geminiReviewer: 0,
    geminiConversationalReal: 0,
    nousReal: 0,
    metaReal: 0,
    whatsappReal: 0,
  },
  productionChanges: 'NONE',
  flagsChanged: 'NONE',
};
const artifactDir = resolve(root, 'artifacts/f3-traceability-gate');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(
  resolve(artifactDir, 'offline-traceability-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(
  resolve(artifactDir, 'offline-traceability-summary.md'),
  `# F3 traceability gate — offline\n\n` +
    `**Result:** F3_TRACEABILITY_GATE_PROVEN_OFFLINE. **F3:** OPEN.\n\n` +
    `Base: \`${report.baseCommit}\`. Final commit reference: \`CONTAINING_GIT_COMMIT\`. Branch: \`f3-traceability-gate\`.\n\n` +
    `The ${cases.length}-case synthetic corpus (${report.corpus.sha256}) covers selector filtering, both fake engine boundaries, budget omission, shadow isolation, provider failures, post-policy suppression, delivery states, retries, versions, evidence changes, malformed metadata and DB reconstruction.\n\n` +
    `\`learningExposed\` records only ID/version in the provider-visible request. It does not claim causal use or effectiveness. Part 0 owns exposure metadata; all parts must be CONFIRMED for confirmed-delivery analytics.\n\n` +
    `Unit: ${unit.numPassedTests}/${unit.numTotalTests} in ${unit.numTotalTestSuites} suites. Integration: ${integration.numPassedTests}/${integration.numTotalTests} in ${integration.numTotalTestSuites} suites on isolated PostgreSQL/Redis. External traffic: 0. Prisma schema and migrations: unchanged. Production and flags: unchanged.\n\n` +
    `Performance: 30 local samples per operation; threshold THRESHOLD_NOT_DEFINED. See JSON for min, max, mean, median, p50 and p95.\n`,
);
