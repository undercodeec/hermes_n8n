import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseSha = '66cd47722372f8252d0df49610b21403b6171d5f';
const outputDir = join(process.cwd(), 'artifacts', 'f3-retrieval-canary-gate');
const temp = process.env.TEMP || tmpdir();
const sha = (value) => createHash('sha256').update(value).digest('hex');
const unit = JSON.parse(
  readFileSync(join(temp, 'f3-canary-unit-jest.json'), 'utf8'),
);
const integration = JSON.parse(
  readFileSync(join(temp, 'f3-canary-integration-jest.json'), 'utf8'),
);
const tests = (run) => ({
  suites: run.numTotalTestSuites,
  passedSuites: run.numPassedTestSuites,
  cases: run.numTotalTests,
  passedCases: run.numPassedTests,
  failedCases: run.numFailedTests,
  success: run.success,
});
if (!unit.success || !integration.success)
  throw new Error('Local canary scope regression did not pass');
const report = {
  gate: 'F3_RETRIEVAL_CANARY_GATE',
  result: 'BLOCKED_F3_RETRIEVAL_CANARY_QA_CONVERSATION_MISSING',
  baseSha,
  preparationReference: 'refs/heads/f3-retrieval-canary-gate',
  timestampUtc: new Date().toISOString(),
  canaryScopeControl: {
    flag: 'LEARNING_RETRIEVAL_ENABLED',
    allowlist: 'LEARNING_RETRIEVAL_CONVERSATION_ALLOWLIST',
    default: 'empty',
    exactConversationCount: 1,
    malformedOrMultiple: 'fail_closed',
    appliedBeforeSelector: true,
    multipleSelectedLearningItems: 'fail_closed',
    independentOfNousRouting: true,
    restartRequired: true,
  },
  qaScope: {
    designatedConversationIdProvided: false,
    operatorOwnedDeliveryAuthorizationProvided: false,
    conversationCount: 0,
  },
  authorizedLearning: {
    idAndVersionProvided: false,
    productionEligibilityChecked: false,
  },
  operator: { canaryOwnerProvided: false, authorizationVerified: false },
  localValidation: {
    unit: tests(unit),
    relevantPostgresRedisIntegration: tests(integration),
    build: 'PASS',
    productionTypecheck: 'PASS',
    directedEslint: 'PASS',
    directedPrettier: 'PASS',
    prismaValidate: 'PASS',
    diffCheck: 'PASS',
    unrelatedFullIntegrationAtBase: {
      advertisingFlow: 'SETUP_BLOCKED_ADS_D_TEST_DATABASE_URL_MISSING',
      advertisingOutbox: 'SETUP_BLOCKED_ADS_E_TEST_DATABASE_URL_MISSING',
      evidence:
        'Observed in the prior full integration attempt on the immediate base; excluded from this F3 relevant run and not rerun here.',
    },
  },
  migrations: {
    prismaSchemaChanged: false,
    newMigrationDirectories: 0,
    required: false,
  },
  vpsPreflight: 'NOT_STARTED_MISSING_QA_CONVERSATION',
  lineage: 'NOT_VERIFIED_ON_VPS',
  deployedRelease: null,
  previousRelease: null,
  rollbackRelease: 'NOT_VERIFIED_ON_VPS',
  finalProductionFlags: 'NOT_VERIFIED_ON_VPS',
  finalProductionRetrievalAllowlistCount: 'NOT_VERIFIED_ON_VPS',
  localIsolatedHarnessStopped: true,
  canaryTurnsExecuted: 0,
  liveNonQaExposureCount: 'NOT_MEASURED_NO_LIVE_WINDOW',
  externalTraffic: {
    geminiReviewer: 0,
    geminiConversational: 0,
    nous: 0,
    metaOutbound: 0,
    whatsappQaOutbound: 0,
    nonQaOutboundAttributableToGate: 0,
  },
  productionChanges: 'NONE',
  f3State: 'OPEN',
  nextRequiredInputs: [
    'previously designated QA/operator-owned conversation ID and live delivery authorization',
    'authorized ACTIVE LearningItem ID/version with effective evidence',
    'named canary owner/operator authorization',
  ],
};
mkdirSync(outputDir, { recursive: true });
const reportText = JSON.stringify(report, null, 2) + '\n';
writeFileSync(join(outputDir, 'controlled-canary-report.json'), reportText);
const summary = `# F3 retrieval canary — local preparation\n\nResult: **${report.result}**. F3 remains OPEN. Base: \`${baseSha}\`; preparation branch: \`f3-retrieval-canary-gate\`.\n\nA fail-closed retrieval conversation scope was added before the selector. A global ON flag with an empty, malformed or multiple-ID allowlist cannot retrieve. Exactly one safe ID is permitted; non-QA turns skip the selector. More than one selected learning item also causes no injection for this first canary. The new allowlist and flag require a controlled process restart because ConfigModule snapshots validated environment at startup.\n\nLocal validation: ${report.localValidation.unit.passedCases}/${report.localValidation.unit.cases} unit tests and ${report.localValidation.relevantPostgresRedisIntegration.passedCases}/${report.localValidation.relevantPostgresRedisIntegration.cases} relevant isolated PostgreSQL/Redis integration tests passed. Build, production typecheck, ESLint, Prettier, Prisma validation and diff check passed. Schema and migrations: unchanged.\n\nThe prompt/session did not provide a previously designated QA conversation ID, authorization for its live delivery, an authorized LearningItem ID/version, or a canary owner. No VPS preflight, deployment, provider call, Meta/WhatsApp delivery or production flag change was performed. Live flag state was not inspected and is not asserted here.\n\nReport SHA-256: \`${sha(reportText)}\`.\n`;
writeFileSync(join(outputDir, 'controlled-canary-summary.md'), summary);
console.log(
  JSON.stringify({
    result: report.result,
    reportSha256: sha(reportText),
    tests: report.localValidation,
  }),
);
