export const databaseUrls = {
  main: 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/hermes_learning_test?schema=public',
  adsD: 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/ads_d_test_gate?schema=public',
  adsE: 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/ads_e_test_gate?schema=public',
  a7: 'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/hermes_a7_d16_test?schema=public',
  retention:
    'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/retention_test?schema=public',
  a3: 'postgresql://a3_gate:fixture-a3-local@127.0.0.1:55439/hermes_a3_temp?schema=public',
  a6: 'postgresql://a6_gate:fixture-a6-local@127.0.0.1:55888/hermes_a6_d1_temp?schema=public',
};

export const redisUrls = {
  main: 'redis://127.0.0.1:56379/0',
  a7: 'redis://127.0.0.1:56380/0',
};

// The Phase H web BFF case requires a separately built Next fixture.
export const allowedSkippedTests = {
  'advertising-flow.integration-spec.ts': [
    'registers a web BFF v2 intent through Nest and resolves its signed reference',
  ],
};

export const suiteGroups = [
  {
    database: 'main',
    redis: 'main',
    suites: [
      'automated-delivery.integration-spec.ts',
      'calendar-meetings.integration-spec.ts',
      'commercial-solution.integration-spec.ts',
      'conversation-guard-cold-start.integration-spec.ts',
      'conversation-learning.integration-spec.ts',
      'f3-approval.integration-spec.ts',
      'f3-rollback.integration-spec.ts',
      'f3-single-generation.integration-spec.ts',
      'f3-traceability.integration-spec.ts',
      'inbound-turn.integration-spec.ts',
      'nous-hermes-queue.integration-spec.ts',
      'nous-recovery-pagination.integration-spec.ts',
    ],
  },
  {
    database: 'adsD',
    redis: 'main',
    suites: ['advertising-flow.integration-spec.ts'],
  },
  {
    database: 'adsE',
    redis: 'main',
    suites: ['advertising-outbox.integration-spec.ts'],
  },
  {
    database: 'a3',
    redis: 'main',
    suites: ['f3-native-diagnostics.integration-spec.ts'],
  },
  {
    database: 'a6',
    redis: 'main',
    suites: ['f3-canary-run-scope.integration-spec.ts'],
  },
  {
    database: 'a7',
    redis: 'a7',
    suites: ['a7-d16-critical.integration-spec.ts'],
  },
  {
    database: 'retention',
    redis: 'a7',
    suites: ['retention-policy.integration-spec.ts'],
  },
];
