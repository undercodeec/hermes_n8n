import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_PILOT_DRIFT,
  runInboxOrderIntegration,
} from './run-inbox-order-integration.mjs';

function harness(faults = [], options = {}) {
  const calls = [];
  const resources = { container: false, network: false };
  let project;
  const spawn = (command, args, config) => {
    // Snapshot env: runner pins context only after inspecting initial context.
    calls.push({
      command,
      args,
      config: { ...config, env: { ...config.env } },
    });
    let stdout = '';
    let fault;
    if (command !== 'docker')
      fault = args[0].includes('prisma') ? 'schema-drift' : 'jest';
    else if (args[0] === 'context') {
      stdout =
        args[1] === 'show'
          ? faults.includes('remote-context')
            ? 'remote'
            : 'desktop-linux'
          : JSON.stringify([
              {
                Endpoints: {
                  docker: {
                    Host: faults.includes('remote-endpoint')
                      ? 'tcp://remote:2375'
                      : 'npipe:////./pipe/dockerDesktopLinuxEngine',
                  },
                },
              },
            ]);
    } else if (args[0] === 'info') stdout = '29.6.1';
    else if (args[0] === 'network' && args[1] === 'create') {
      project = args.at(-1);
      resources.network = true;
      stdout = 'owned-network-id';
      fault = 'network-create';
    } else if (args[0] === 'run') {
      resources.container = true;
      stdout = 'owned-container-id';
      fault = 'container-start';
    } else if (args[0] === 'port') stdout = '127.0.0.1:54321';
    else if (args[0] === 'exec' && args.includes('psql')) fault = 'migration';
    else if (args[0] === 'ps') {
      stdout = resources.container ? 'owned-container-id' : '';
      fault = 'container-list';
    } else if (args[0] === 'network' && args[1] === 'ls')
      stdout = resources.network ? 'owned-network-id' : '';
    else if (args[0] === 'rm') {
      fault = 'container-remove';
      if (!faults.includes(fault)) resources.container = false;
    } else if (args[0] === 'network' && args[1] === 'rm') {
      fault = 'network-remove';
      if (!faults.includes(fault)) resources.network = false;
    }
    if (fault === 'schema-drift' && faults.includes('known-drift'))
      return { status: 2, stdout: KNOWN_PILOT_DRIFT, stderr: '' };
    if (fault === 'schema-drift' && faults.includes('unexpected-drift'))
      return { status: 2, stdout: 'Unexpected changed table', stderr: '' };
    return faults.includes(fault)
      ? { status: 1, stdout, stderr: `injected ${fault}` }
      : { status: 0, stdout, stderr: '' };
  };
  return {
    calls,
    resources,
    run: () => runInboxOrderIntegration({ spawn, log: () => {}, ...options }),
    assertScopedCleanup() {
      const listings = calls.filter(
        ({ args }) =>
          args[0] === 'ps' || (args[0] === 'network' && args[1] === 'ls'),
      );
      assert.equal(listings.length, 2);
      for (const { args } of listings) {
        assert.ok(args.includes(`label=com.docker.compose.project=${project}`));
        assert.ok(args.includes(`name=${project}`));
      }
      for (const { args } of calls.filter(
        ({ args }) =>
          args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'),
      ))
        assert.ok(
          ['owned-container-id', 'owned-network-id'].includes(args.at(-1)),
        );
    },
  };
}
for (const fault of [
  'network-create',
  'container-start',
  'migration',
  'schema-drift',
  'jest',
]) {
  test(`cleans owned resources after ${fault} and preserves original error`, () => {
    const h = harness([fault]);
    assert.throws(h.run, new RegExp(`injected ${fault}`));
    h.assertScopedCleanup();
    assert.deepEqual(h.resources, { container: false, network: false });
  });
}
for (const fault of ['container-remove', 'container-list']) {
  test(`attempts network cleanup despite ${fault}, retaining both errors`, () => {
    const h = harness(['container-start', fault]);
    assert.throws(h.run, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /injected container-start/);
      assert.match(error.errors[1].message, new RegExp(`injected ${fault}`));
      return true;
    });
    h.assertScopedCleanup();
    assert.equal(h.resources.network, false);
  });
}
test('reports both cleanup failures after successful tests', () => {
  const h = harness(['container-remove', 'network-remove']);
  assert.throws(
    h.run,
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  h.assertScopedCleanup();
});
test('successful run pins local context, ignores caller URLs and cleans both resources', () => {
  const h = harness();
  h.run();
  h.assertScopedCleanup();
  assert.deepEqual(h.resources, { container: false, network: false });
  const call = h.calls.find(({ command }) => command !== 'docker');
  const url = new URL(call.config.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/inbox_test_[a-f0-9]{32}$/);
  assert.equal(call.config.env.DOCKER_CONTEXT, 'desktop-linux');
  assert.equal(call.config.env.INBOX_ORDER_EXPORT_FIXTURE, undefined);
});
test('fixture export is opt-in', () => {
  const h = harness([], { exportFixture: true });
  h.run();
  assert.equal(
    h.calls.find(({ command }) => command !== 'docker').config.env
      .INBOX_ORDER_EXPORT_FIXTURE,
    '1',
  );
});
for (const fault of ['remote-context', 'remote-endpoint']) {
  test(`rejects ${fault} before creating resources`, () => {
    const h = harness([fault]);
    assert.throws(h.run, /local/);
    assert.deepEqual(h.resources, { container: false, network: false });
    assert.ok(h.calls.every(({ args }) => args[0] === 'context'));
  });
}

test('records exact inherited pilot drift and still executes Jest', () => {
  const h = harness(['known-drift']);
  h.run();
  assert.ok(h.calls.some(({ args }) => args[0].includes('jest/bin/jest.js')));
  h.assertScopedCleanup();
});
test('rejects additional schema drift before fixture writes and cleans resources', () => {
  const h = harness(['unexpected-drift']);
  assert.throws(h.run, /Unexpected schema drift/);
  assert.ok(!h.calls.some(({ args }) => args[0].includes('jest/bin/jest.js')));
  h.assertScopedCleanup();
  assert.deepEqual(h.resources, { container: false, network: false });
});
