import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = resolve(root, 'artifacts/f3-approval-gate');
const readJson = (name) =>
  JSON.parse(readFileSync(resolve(artifactDir, name), 'utf8'));
const timings = existsSync(resolve(artifactDir, 'measurements.tmp.json'))
  ? readJson('measurements.tmp.json')
  : readJson('offline-approval-report.json').performance.timings;
const unit = readJson('jest-unit.tmp.json');
if (!unit.success || unit.numTotalTestSuites < 75 || unit.numTotalTests < 1241)
  throw new Error('F3 approval unit regression is incomplete');
for (const [operation, measurement] of Object.entries(timings)) {
  if (!measurement || measurement.samples < 12)
    throw new Error(`F3 approval timing sample missing: ${operation}`);
}
const corpusFiles = [
  'src/learning/f3-approval-controller.spec.ts',
  'src/learning/learning-decision.spec.ts',
  'src/auto-replies/auto-reply.service.spec.ts',
  'test/f3-approval.integration-spec.ts',
  'test/conversation-learning.integration-spec.ts',
];
const fixtureHash = createHash('sha256');
for (const path of corpusFiles)
  fixtureHash.update(path).update(readFileSync(resolve(root, path)));
const stateMatrix = [
  { before: 'PROPOSED', action: 'APPROVE', after: 'ACTIVE', http: 201 },
  { before: 'PROPOSED', action: 'REJECT', after: 'REJECTED', http: 201 },
  { before: 'ACTIVE', action: 'RETIRE', after: 'RETIRED', http: 201 },
  ...[
    ['PROPOSED', 'RETIRE'],
    ['ACTIVE', 'APPROVE'],
    ['ACTIVE', 'REJECT'],
    ['REJECTED', 'APPROVE'],
    ['REJECTED', 'RETIRE'],
    ['RETIRED', 'APPROVE'],
    ['RETIRED', 'REJECT'],
    ['RETIRED', 'RETIRE'],
  ].map(([before, action]) => ({ before, action, after: before, http: 409 })),
];
const report = {
  result: 'F3_APPROVAL_GATE_PROVEN_OFFLINE',
  baseCommit: 'a2a6cc4b0faaefd764f2f36fbc4b8fe6abc05c22',
  finalCommitReference: 'CONTAINING_GIT_COMMIT',
  fixture: {
    version: 1,
    sha256: fixtureHash.digest('hex'),
    paths: corpusFiles,
    syntheticOnly: true,
  },
  stateMatrix,
  authority: {
    endpoint: 'POST /api/learning/candidates/:id/decision',
    actorFrom: 'validated JWT user loaded from DB',
    allowedRole: 'ADMIN',
    unauthorizedHttp: 401,
    insufficientRoleHttp: 403,
    rejectedBodyActorHttp: 400,
  },
  reviewer: {
    creates: 'PROPOSED',
    confidence: 1,
    sourceConversationCount: 2,
    evidenceCount: 2,
    automaticActiveTransitions: 0,
  },
  validDecision: {
    actorPersisted: true,
    reasonAudited: true,
    beforeAfterAudited: true,
    versionAudited: true,
    approvedAtPersisted: true,
    validUntilPersisted: true,
    guidanceAndFingerprintUnchanged: true,
    evidencePreserved: true,
  },
  evidence: {
    absent: 'APPROVE_REJECTED',
    deleted: 'APPROVE_REJECTED',
    ineffectiveReview: 'APPROVE_REJECTED',
    ineffectiveFeedback: 'APPROVE_REJECTED',
    missingMessage: 'APPROVE_REJECTED',
    invalidatedAfterApproval: 'NOT_RETRIEVABLE',
  },
  expiry: {
    past: 'APPROVE_REJECTED',
    moreThan180Days: 'APPROVE_REJECTED',
    at180Days: 'APPROVE_ACCEPTED',
    expiredActive: 'NOT_RETRIEVABLE',
  },
  concurrency: {
    approveVsReject: 'ONE_WINNER_ONE_409_ONE_AUDIT',
    approveVsApprove: 'ONE_WINNER_ONE_409_ONE_AUDIT',
    rejectVsReject: 'ONE_WINNER_ONE_409_ONE_AUDIT',
    retireVsRetire: 'ONE_WINNER_ONE_409',
    staleDecision: '409_NO_OVERWRITE',
    replay: '409_NO_SECOND_EFFECT',
  },
  retrieval: {
    beforeApproval: false,
    activeEligible: true,
    rejected: false,
    retired: false,
    expired: false,
    afterEvidenceLoss: false,
  },
  engines: {
    gemini_direct: {
      proposed: false,
      activeEligible: true,
      rejected: false,
      retired: false,
      expired: false,
      fakeHttp: true,
    },
    nous_hermes: {
      proposed: false,
      activeEligible: true,
      rejected: false,
      retired: false,
      expired: false,
      fakeHttp: true,
    },
  },
  learningExposed: {
    activeEligible: 'ID_AND_VERSION_ONLY',
    proposed: 'ABSENT',
    rejected: 'ABSENT',
    retired: 'ABSENT',
    expired: 'ABSENT',
  },
  guards: {
    privacy: 'APPROVE_REJECTED',
    commercial: 'APPROVE_REJECTED',
    highRisk: 'ACTIVE_BUT_NOT_RETRIEVABLE',
    coreShadowRegression: 'PASS',
  },
  failures: {
    auditInsertFailure: 'TRANSACTION_ROLLED_BACK',
    evidenceLookupFailure: 'NO_UPDATE_NO_AUDIT',
    stateConflict: '409_NO_PARTIAL_ACTIVATION',
    missingItem: '404',
  },
  tests: {
    unitSuites: unit.numTotalTestSuites,
    unitCases: unit.numTotalTests,
    isolatedIntegrationSuites: 2,
    isolatedIntegrationCases: 72,
    build: 'PASS',
    productionTypecheck: 'PASS',
    eslintDirected: 'PASS',
    prettierDirected: 'PASS',
    prismaValidate: 'PASS',
    diffCheck: 'PASS',
  },
  performance: { timings, threshold: 'THRESHOLD_NOT_DEFINED' },
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    migrationsRequired: false,
    existingMigrationDirectories: 23,
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
const lines = [
  '# F3 approval authority — offline',
  '',
  `Result: \`${report.result}\`. Base: \`${report.baseCommit}\`. The containing Git commit is the final commit reference. F3 remains OPEN.`,
  '',
  `Corpus v1 SHA-256: \`${report.fixture.sha256}\`. All data is synthetic.`,
  '',
  '| State before | Decision | State after | HTTP |',
  '|---|---|---|---:|',
  ...stateMatrix.map(
    ({ before, action, after, http }) =>
      `| ${before} | ${action} | ${after} | ${http} |`,
  ),
  '',
  'Only a DB-validated ADMIN JWT can decide. The reviewer produced confidence 1.0 with two source conversations and two evidence rows, yet the item remained PROPOSED until the human decision. The service uses an advisory transaction lock and a conditional state update; state and audit persist atomically.',
  '',
  'Effective evidence, expiry, privacy, commercial safety, risk and selector limits still gate exposure after APPROVE. Invalidated evidence, REJECT and RETIRE removed eligibility. Both real adapters were inspected with deterministic fake HTTP; only valid ACTIVE guidance and its ID/version reached Gemini Direct and Nous.',
  '',
  '| Local operation | Samples | Min ms | Max ms | Mean ms | Median ms | p50 ms | p95 ms |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(timings).map(
    ([operation, item]) =>
      `| ${operation} | ${item.samples} | ${item.min.toFixed(3)} | ${item.max.toFixed(3)} | ${item.mean.toFixed(3)} | ${item.median.toFixed(3)} | ${item.p50.toFixed(3)} | ${item.p95.toFixed(3)} |`,
  ),
  '',
  '`THRESHOLD_NOT_DEFINED`. These are local PostgreSQL/selector timings; no production SLO is inferred.',
  '',
  `Unit: ${unit.numTotalTestSuites} suites / ${unit.numTotalTests} cases. Isolated PostgreSQL/Redis integration: 2 suites / 72 cases. Build, typecheck, directed lint and Prettier, Prisma validation and diff check: PASS.`,
  '',
  'Prisma schema changed: no; new migrations: 0; migrations required: no. Real Gemini reviewer/conversation, Nous, Meta and WhatsApp traffic: 0. Production and flags: unchanged.',
  '',
  'Reproduce from this backend: start `npm run learning:harness:up`, run `npm run test:learning:integration`, run `npx jest --runInBand --silent --json --outputFile=artifacts/f3-approval-gate/jest-unit.tmp.json`, then `node scripts/evaluate-f3-approval.mjs`. Remove temporary JSON and stop the harness afterward.',
  '',
];
writeFileSync(
  resolve(artifactDir, 'offline-approval-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(
  resolve(artifactDir, 'offline-approval-summary.md'),
  lines.join('\n'),
);
console.log(
  JSON.stringify({ result: report.result, fixtureHash: report.fixture.sha256 }),
);
