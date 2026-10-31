#!/usr/bin/env python3
"""Run every integration suite against its own disposable loopback resource."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
COMPOSE = ROOT / 'docker-compose.integration-test.yml'
PROJECT = 'hermes-integration-' + uuid.uuid4().hex[:10]
PORTS = (55432, 55888, 55439, 55433, 56379, 56380)
PRODUCTION_HOSTS = {'racknerd-8cc858a'}
WITHOUT_A7 = sys.argv[1:] == ['--without-a7']
if sys.argv[1:] and not WITHOUT_A7:
    raise SystemExit('Usage: run-all-integration.py [--without-a7]')

if not WITHOUT_A7 and (socket.gethostname().lower() in PRODUCTION_HOSTS or os.environ.get('HOSTNAME', '').lower() in PRODUCTION_HOSTS):
    raise SystemExit('Full integration includes A7-D16 and is forbidden on the production VPS; use GitHub Actions or local Windows')
if str(ROOT).replace('\\', '/').startswith('/var/www/'):
    raise SystemExit('Production checkout is forbidden')

for port in PORTS:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError as error:
            raise SystemExit(f'Isolated port {port} is occupied; refusing to start: {error}')

base_env = {
    key: value for key, value in os.environ.items()
    if key in ('PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'WINDIR')
}
base_env.update(CI='true', NODE_ENV='test', GITHUB_ACTIONS=os.environ.get('GITHUB_ACTIONS', 'false'))
compose = ['docker', 'compose', '-f', str(COMPOSE), '-p', PROJECT]
started = False
results = []
failed_groups = []

def run(command, env=None, capture=False):
    result = subprocess.run(command, cwd=ROOT, env=env or base_env,
                            text=True, capture_output=capture, check=False)
    if result.returncode:
        if capture:
            print(result.stderr, file=sys.stderr)
        raise RuntimeError(f'Command failed ({result.returncode}): {command[0]} {command[1] if len(command) > 1 else ""}')
    return result.stdout.strip() if capture else None

def migrate(url):
    env = {**base_env, 'DATABASE_URL': url}
    run(['node', './node_modules/prisma/build/index.js', 'migrate', 'deploy'], env)

def group(name, files, database, redis=None, extra=None):
    env = {**base_env, 'DATABASE_URL': database, 'DATABASE_INTEGRATION_URL': database}
    if redis:
        env['REDIS_INTEGRATION_URL'] = redis
    env.update(extra or {})
    print(f'INTEGRATION_GROUP {name}: {len(files)} suite(s)', flush=True)
    result = subprocess.run(
        ['node', './node_modules/jest/bin/jest.js', '--config', './test/jest-integration.json',
         '--runInBand', '--silent', '--json', '--outputFile', f'artifacts/integration-{name}.json',
         '--runTestsByPath', *files], cwd=ROOT, env=env, check=False)
    data = json.loads((ROOT / f'artifacts/integration-{name}.json').read_text())
    results.append({'group': name, 'suites': data['numTotalTestSuites'],
                    'passed': data['numPassedTests'], 'failed': data['numFailedTests'],
                    'skipped': data['numPendingTests']})
    if result.returncode or data['numFailedTestSuites'] or data['numFailedTests']:
        failed_groups.append(name)

learning = 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/hermes_learning_test?schema=public'
a6 = 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55888/hermes_a6_d1_temp?schema=public'
a3 = 'postgresql://a3_gate:fixture-a3-local@127.0.0.1:55439/hermes_a3_temp?schema=public'
a7 = 'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/hermes_a7_d16_test?schema=public'
ads_d = 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/ads_d_test_gate?schema=public'
ads_e = 'postgresql://learning_test:fixture-learning-local@127.0.0.1:55432/ads_e_test_gate?schema=public'
retention = 'postgresql://a7_d16_test:fixture-a7-d16-local@127.0.0.1:55433/retention_test?schema=public'
redis_learning = 'redis://127.0.0.1:56379/0'
redis_a7 = 'redis://127.0.0.1:56380/0'

try:
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    started = True
    run([*compose, 'up', '-d', '--wait'])
    container = run([*compose, 'ps', '-q', 'learning-postgres'], capture=True)
    if len(container) != 64:
        raise RuntimeError('Could not identify isolated calendar PostgreSQL container')
    run(['node', './node_modules/prisma/build/index.js', 'generate'], {**base_env, 'DATABASE_URL': learning})
    for url in (learning, a3, a7):
        migrate(url)
    for service, user, template, names in (
        ('learning-postgres', 'learning_test', 'hermes_learning_test',
         ('hermes_a6_d1_temp', 'ads_d_test_gate', 'ads_e_test_gate')),
        ('a7-postgres', 'a7_d16_test', 'hermes_a7_d16_test', ('retention_test',)),
    ):
        for name in names:
            run([*compose, 'exec', '-T', service, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                 '-U', user, '-d', 'postgres', '-c', f'CREATE DATABASE {name} TEMPLATE {template}'])

    group('learning', [
        'test/conversation-learning.integration-spec.ts',
        'test/f3-approval.integration-spec.ts',
        'test/f3-rollback.integration-spec.ts',
        'test/f3-traceability.integration-spec.ts',
        'test/f3-single-generation.integration-spec.ts',
        'test/nous-recovery-pagination.integration-spec.ts',
        'test/commercial-solution.integration-spec.ts',
        'test/inbound-turn.integration-spec.ts',
        'test/automated-delivery.integration-spec.ts',
        'test/nous-hermes-queue.integration-spec.ts',
        'test/conversation-guard-cold-start.integration-spec.ts',
        'test/calendar-meetings.integration-spec.ts',
    ], learning, redis_learning, {
        'CALENDAR_TEST_DATABASE_URL': learning,
        'CALENDAR_TEST_PSQL': str(ROOT / 'scripts/calendar-test-psql.py'),
        'HERMES_TEST_PG_CONTAINER_ID': container,
    })
    group('ads-d', ['test/advertising-flow.integration-spec.ts'], ads_d, redis_learning,
          {'ADS_D_TEST_DATABASE_URL': ads_d, 'ADS_E_TEST_REDIS_URL': redis_learning})
    group('ads-e', ['test/advertising-outbox.integration-spec.ts'], ads_e, redis_learning,
          {'ADS_E_TEST_DATABASE_URL': ads_e, 'ADS_E_TEST_REDIS_URL': redis_learning})
    group('a6', ['test/f3-canary-run-scope.integration-spec.ts'], a6)
    group('a3', ['test/f3-native-diagnostics.integration-spec.ts'], a3)
    if not WITHOUT_A7:
        group('a7', ['test/a7-d16-critical.integration-spec.ts'], a7, redis_a7)
    group('retention', ['test/retention-policy.integration-spec.ts'], retention,
          extra={'RETENTION_TEST_DATABASE_URL': retention})
finally:
    if started:
        run([*compose, 'down', '--volumes', '--remove-orphans'])
    if results:
        summary = {'groups': results, 'passed': sum(r['passed'] for r in results),
                   'failed': sum(r['failed'] for r in results),
                   'skipped': sum(r['skipped'] for r in results)}
        (ROOT / 'artifacts/integration-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print('INTEGRATION_SUMMARY', json.dumps(summary), flush=True)
if failed_groups:
    raise SystemExit('Failed integration groups: ' + ', '.join(failed_groups))
