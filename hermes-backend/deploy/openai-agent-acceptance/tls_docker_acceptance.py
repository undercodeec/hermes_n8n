"""Real-image OpenAI text-turn acceptance using a disposable localhost HTTPS CA."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid
from qa_certificates import create

HERE = Path(__file__).resolve().parent
SCENARIOS = ('success', 'http_json', 'content_json', 'rate_limit', 'nonstop', 'turn_limit', 'untrusted_ca')


def base(name):
    return ['docker', 'run', '--rm', '--name', name, '--pull=never', '--network=none',
            '--user', 'hermes', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--entrypoint', '/opt/hermes/.venv/bin/python3', '--workdir', '/opt/hermes']


def inspect_command(image, name):
    code = ('import certifi,os,json,hashlib; '
            'p=os.path.realpath(certifi.where()); '
            'print(json.dumps({"ca_path":p,"uid":os.getuid(),'
            '"probe_sha256":hashlib.sha256(open("/opt/hermes/agent/openai_budgeted_turn.py","rb").read()).hexdigest()}))')
    return base(name) + [image, '-B', '-c', code]


def mount(src, dst):
    if ',' in str(src) or ',' in dst or not dst.startswith('/'):
        raise ValueError('unsafe Docker mount path')
    return ['--mount', 'type=bind,src=' + str(src) + ',dst=' + dst + ',readonly']


def probe_command(image, name, scenario, ca_path, ca, cert, key):
    if not re.fullmatch(r'/[A-Za-z0-9_./+-]+', ca_path) or '/..' in ca_path:
        raise ValueError('unexpected certifi path')
    cmd = base(name) + ['--add-host', 'api.openai.com:127.0.0.1',
          '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
          '-e', 'HTTP_PROXY=http://127.0.0.1:9', '-e', 'HTTPS_PROXY=http://127.0.0.1:9',
          '-e', 'SSL_CERT_FILE=/no-such-qa-certificate', '-e', 'PYTHONPATH=/opt/hermes',
          '-e', 'PYTHONDONTWRITEBYTECODE=1']
    cmd += mount(HERE / 'tls_image_probe.py', '/qa/tls_image_probe.py')
    cmd += mount(cert, '/qa/server.pem') + mount(key, '/qa/server-key.pem')
    if scenario != 'untrusted_ca':
        cmd += mount(ca, ca_path)
    return cmd + [image, '-B', '/qa/tls_image_probe.py', scenario]


def evaluate(scenario, obs):
    calls = obs.get('calls')
    if obs.get('fatal'): return 'probe infrastructure failure: ' + str(obs['fatal'])
    if not isinstance(calls, list): return 'missing mock dispatch evidence'
    expected = 0 if scenario == 'untrusted_ca' else 1
    if len(calls) != expected: return 'expected %d mock dispatches, observed %d' % (expected, len(calls))
    for call in calls:
        if not isinstance(call, dict) or call.get('path') != '/v1/chat/completions' or call.get('model') != 'gpt-6-luna' or call.get('host') != 'api.openai.com' or call.get('stream') is not False or call.get('max_completion_tokens') != 100 or call.get('messages_count', 0) < 2 or call.get('system_contains_policy') is not True:
            return 'unexpected request contract'
    if obs.get('ledger_calls') != 1: return 'expected one reserved provider call'
    if scenario in ('success', 'turn_limit'):
        if obs.get('outcome') != 'success' or obs.get('reported_api_calls') != 1: return 'turn did not succeed'
        try: content = json.loads(obs.get('content', ''))
        except (TypeError, ValueError): return 'answer is not JSON'
        if content != {'answer': 'synthetic-ok'}: return 'wrong answer'
        if scenario == 'turn_limit' and (obs.get('second_outcome') != 'error' or obs.get('second_error_type') != 'BudgetAbort' or obs.get('ledger_calls_after_second') != 1 or obs.get('terminal_reason_after_second') != 'call_limit'):
            return 'second attempt was not refused by the shared ledger'
    else:
        if obs.get('outcome') != 'error' or 'content' in obs: return 'provider failure returned assistant text'
        if scenario == 'untrusted_ca' and obs.get('error_type') != 'APIConnectionError': return 'untrusted TLS did not surface as connection error'
    return None


def run_named(command, name, timeout):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    finally:
        try: subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired): print('WARNING cleanup not confirmed: ' + name, file=sys.stderr)


def name(): return 'hermes-qa-' + uuid.uuid4().hex


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='already-local candidate image; never pulls')
    args = parser.parse_args()
    try:
        image = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.image], capture_output=True, text=True, timeout=15)
        image_id = image.stdout.strip()
        if image.returncode or not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
            print('FAIL Docker unavailable or image is not local; no pull attempted'); return 1
        inspect_name = name()
        inspect = run_named(inspect_command(image_id, inspect_name), inspect_name, 30)
        if inspect.returncode: print('FAIL candidate inspection as hermes; details withheld'); return 1
        metadata = json.loads(inspect.stdout)
        if not isinstance(metadata.get('uid'), int) or metadata['uid'] == 0: print('FAIL hermes is root'); return 1
        ca_path = metadata['ca_path']
        print('image=%s uid=%s certifi=%s module_sha256=%s' % (image_id, metadata['uid'], ca_path, metadata['probe_sha256']))
        failures = 0
        with tempfile.TemporaryDirectory(prefix='qa-tls-', dir=HERE) as directory:
            ca, cert, key = create(directory)
            for scenario in SCENARIOS:
                container = name()
                try:
                    result = run_named(probe_command(image_id, container, scenario, ca_path, ca, cert, key), container, 95)
                    if result.returncode:
                        print('FAIL %s: container exit %d (stderr withheld)' % (scenario, result.returncode)); failures += 1; continue
                    obs = json.loads(result.stdout)
                    reason = evaluate(scenario, obs)
                    print('%s %s dispatches=%s outcome=%s error=%s%s' % ('FAIL' if reason else 'PASS', scenario,
                          len(obs.get('calls', [])), obs.get('outcome'), obs.get('error_type'), ': ' + reason if reason else ''))
                    failures += bool(reason)
                except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                    failures += 1; print('FAIL %s: %s' % (scenario, type(exc).__name__))
        return int(bool(failures))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        print('FAIL setup: ' + type(exc).__name__); return 1

if __name__ == '__main__': sys.exit(main())
