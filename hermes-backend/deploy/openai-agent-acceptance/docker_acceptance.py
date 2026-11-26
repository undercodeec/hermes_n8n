"""Actual gateway acceptance through an isolated TLS mock in the candidate image."""
import argparse
import json
import pathlib
import re
import subprocess
import tempfile
import uuid
import tls_docker_acceptance as tls
from qa_certificates import create

HERE = pathlib.Path(__file__).resolve().parent
SCENARIOS = ('success', 'invalid_json', 'rate_limit', 'turn_limit')


def docker_command(image, scenario, name):
    """Legacy command retained only for historical harness self-tests; not used by CI."""
    return ['docker', 'run', '--rm', '--name', name, '--pull=never', '--network=none', '--user=hermes',
            '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
            '--mount', 'type=bind,src=' + str(HERE / 'image_probe.py') + ',dst=/qa/image_probe.py,readonly',
            '--workdir', '/opt/hermes', '--entrypoint', '/opt/hermes/.venv/bin/python3',
            image, '-B', '/qa/image_probe.py', scenario]


def gateway_command(image, scenario, name, ca_path, ca, cert, key):
    """Reuse the TLS module harness isolation and mounts, plus the real gateway probe."""
    cmd = tls.probe_command(image, name, scenario, ca_path, ca, cert, key)
    # Last four arguments are IMAGE -B PROBE SCENARIO; insert an extra readonly probe mount.
    return cmd[:-4] + tls.mount(HERE / 'image_probe.py', '/qa/image_probe.py') + [image, '-B', '/qa/image_probe.py', scenario]


def evaluate(scenario, observation):
    """Historical basic HTTP checker, retained for existing self-tests."""
    calls = observation.get('calls')
    if not isinstance(calls, list): return 'missing independent mock observations'
    if any(not isinstance(c, dict) or c.get('path') != '/v1/chat/completions' or
           not isinstance(c.get('model'), str) or not c.get('model') or
           not isinstance(c.get('messages_count'), int) or c['messages_count'] < 1 for c in calls):
        return 'unexpected upstream request contract'
    if not 1 <= len(calls) <= 2: return 'upstream dispatch count outside 1..2: %d' % len(calls)
    status, body = observation.get('http_status'), observation.get('body')
    if not isinstance(status, int) or not isinstance(body, dict): return 'gateway did not return an observable JSON response'
    if scenario == 'success':
        try:
            choice = body['choices'][0]
            content = json.loads(choice['message']['content'])
            if status != 200 or choice['finish_reason'] != 'stop' or content != {'answer': 'synthetic-ok'}:
                return 'gateway did not propagate the structured synthetic answer'
        except (KeyError, TypeError, IndexError, ValueError): return 'unexpected success response contract'
    else:
        if status < 400 or 'error' not in body or 'choices' in body: return 'failure not exposed as a non-2xx error without assistant choices'
        if scenario == 'turn_limit' and len(calls) != 2: return 'limit not exercised through two observed dispatches'
    return None


def evaluate_gateway(scenario, observation):
    calls = observation.get('calls')
    if not isinstance(calls, list): return 'missing independent mock observations'
    if len(calls) != 1: return 'expected exactly one actual upstream dispatch'
    call = calls[0]
    if (not isinstance(call, dict) or call.get('path') != '/v1/chat/completions' or
            call.get('model') != 'gpt-6-luna' or call.get('host') != 'api.openai.com' or
            call.get('stream') is not False or call.get('max_completion_tokens') != 100 or
            not isinstance(call.get('messages_count'), int) or call['messages_count'] < 2 or
            call.get('system_contains_policy') is not True):
        return 'OpenAI upstream request does not match the candidate contract'
    if scenario == 'turn_limit':
        return 'gateway route is one-shot; this scenario does not exercise a shared-ledger call limit'
    status, response = observation.get('http_status'), observation.get('response')
    if type(status) is not int or not isinstance(response, dict) or response.get('json_object') is not True:
        return 'gateway did not return an observable JSON response'
    if scenario == 'success':
        if status != 200 or response.get('synthetic_answer_ok') is not True:
            return 'gateway did not propagate the structured synthetic answer'
    elif status < 400 or response.get('has_error') is not True or response.get('has_choices') is not False:
        return 'failure not exposed as a non-2xx error without assistant choices'
    return None


def format_safe_diagnostics(obs):
    # All output is from fixed enums, booleans or bounded integers; never print raw logs/body.
    parts = []
    codes = {'root_forbidden', 'tls_mock_startup_failed', 'gateway_exited',
             'gateway_readiness_timeout', 'gateway_response_not_json', 'gateway_io_error'}
    code = obs.get('diagnostic_code')
    if code in codes: parts.append('reason=' + code)
    health = obs.get('health_error')
    if health in {'connection_refused', 'timeout', 'connection_reset', 'http_non_200', 'other_io_error'}:
        parts.append('health=' + health)
    for field in ('health_http_status', 'gateway_exit_code'):
        value = obs.get(field)
        if type(value) is int and -255 <= value <= 599: parts.append('%s=%d' % (field, value))
    preflight = obs.get('preflight')
    fields = ('api_platform_present', 'api_enabled', 'api_key_usable', 'api_connected',
              'host_expected', 'port_expected', 'model_expected')
    if isinstance(preflight, dict):
        result = preflight.get('result')
        if result in {'ok', 'process_failed', 'invalid_output', 'timeout', 'unavailable'}:
            parts.append('config_probe=' + result)
        for field in fields:
            if type(preflight.get(field)) is bool: parts.append('%s=%s' % (field, str(preflight[field]).lower()))
    allowed = {'api_key_rejected', 'aiohttp_missing', 'api_listener_started', 'address_in_use',
               'permission_denied', 'module_missing', 'import_error', 'config_parse_failed',
               'no_platforms', 'api_connect_failed', 'log_unavailable', 'supervision_redirect',
               'gateway_start_entered', 'api_connecting', 'gateway_running'}
    flags = obs.get('log_flags')
    if isinstance(flags, list):
        clean = sorted({x for x in flags if isinstance(x, str) and x in allowed})
        if clean: parts.append('log_categories=' + ','.join(clean))
    startup = obs.get('startup')
    if isinstance(startup, dict):
        value = startup.get('pid_file_present')
        if type(value) is bool: parts.append('pid_file_present=' + str(value).lower())
        for field, allowed_values in (('gateway_state', {'starting', 'running', 'stopped', 'startup_failed', 'draining', 'missing', 'unavailable', 'invalid', 'other'}),
                                      ('process_kind', {'sleep_infinity', 'python_or_hermes', 'other', 'unavailable'}),
                                      ('process_state', {'R', 'S', 'D', 'T', 'Z', 'other', 'unavailable'})):
            value = startup.get(field)
            if isinstance(value, str) and value in allowed_values: parts.append(field + '=' + value)
    return ' '.join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='candidate image already present locally')
    parser.add_argument('--scenario', action='append', choices=SCENARIOS, help='repeat to select scenarios; default all')
    args = parser.parse_args()
    try:
        inspect = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.image], capture_output=True, text=True, timeout=15)
        image_id = inspect.stdout.strip()
        if inspect.returncode or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
            print('FAIL: Docker unavailable or image is not local; no pull attempted'); return 1
        name = tls.name()
        result = tls.run_named(tls.inspect_command(image_id, name), name, 30)
        if result.returncode: print('FAIL: candidate inspection as hermes (details withheld)'); return 1
        metadata = json.loads(result.stdout)
        if not isinstance(metadata.get('uid'), int) or metadata['uid'] == 0:
            print('FAIL: hermes must be non-root'); return 1
        print('image=%s uid=%s certifi=%s module_sha256=%s' % (image_id, metadata['uid'], metadata['ca_path'], metadata['probe_sha256']))
        failures = 0
        with tempfile.TemporaryDirectory(prefix='qa-tls-', dir=HERE) as directory:
            ca, cert, key = create(directory)
            for scenario in (args.scenario or SCENARIOS):
                name = tls.name()
                try:
                    command = gateway_command(image_id, scenario, name, metadata['ca_path'], ca, cert, key)
                    result = tls.run_named(command, name, 145)
                    if result.returncode:
                        print('FAIL %s: Docker/probe exited %s (details withheld)' % (scenario, result.returncode)); failures += 1; continue
                    obs = json.loads(result.stdout)
                    reason = evaluate_gateway(scenario, obs)
                    calls = obs.get('calls')
                    count = len(calls) if isinstance(calls, list) else 'unknown'
                    status = obs.get('http_status')
                    status = status if type(status) is int and 100 <= status <= 599 else None
                    print('%s %s: dispatches=%s http=%s%s' % ('FAIL' if reason else 'PASS', scenario,
                          count, status, ': ' + reason if reason else ''))
                    diagnostics = format_safe_diagnostics(obs)
                    if diagnostics: print('  diagnostic: ' + diagnostics)
                    failures += bool(reason)
                except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                    print('FAIL %s: %s' % (scenario, type(exc).__name__)); failures += 1
        return int(bool(failures))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('FAIL setup: ' + type(exc).__name__); return 1

if __name__ == '__main__': raise SystemExit(main())
