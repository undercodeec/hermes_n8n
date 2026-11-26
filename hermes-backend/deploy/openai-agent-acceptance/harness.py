"""Isolated adapter contract harness. No Hermes API is assumed."""
import argparse
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_CALLS = 2

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            body = None
        self.server.calls.append({'path': self.path, 'body': body})
        scenario = self.server.scenario
        if scenario == 'rate_limit':
            status, payload = 429, b'{"error":{"message":"synthetic rate limit"}}'
        else:
            status = 200
            content = '{not valid json' if scenario == 'invalid_json' else json.dumps({'answer': 'synthetic-ok'})
            message = {'role': 'assistant', 'content': content}
            if scenario == 'turn_limit':
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'synthetic-tool', 'type': 'function', 'function': {'name': 'synthetic_noop', 'arguments': '{}'}}]}
            payload = json.dumps({'id': 'synthetic', 'object': 'chat.completion', 'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if scenario == 'turn_limit' else 'stop'}]}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def check(command, scenario):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    server.calls, server.scenario = [], scenario
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    request = {'scenario': scenario, 'openai_base_url': 'http://127.0.0.1:%d/v1' % server.server_port,
               'input': 'synthetic only', 'max_provider_calls': MAX_CALLS}
    # Do not pass inherited credentials, proxy settings, or home-directory secrets.
    env = {k: os.environ[k] for k in ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') if k in os.environ}
    try:
        proc = subprocess.run(command, input=json.dumps(request), text=True, capture_output=True, timeout=15, env=env)
        if proc.returncode:
            raise AssertionError('adapter exit code %d; stderr omitted to avoid accidental disclosure' % proc.returncode)
        try:
            result = json.loads(proc.stdout)
        except ValueError:
            raise AssertionError('adapter stdout is not a single JSON document')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    calls = server.calls
    assert 1 <= len(calls) <= MAX_CALLS, 'provider calls %d outside 1..%d' % (len(calls), MAX_CALLS)
    for call in calls:
        assert call['path'] == '/v1/chat/completions', 'unexpected provider path'
        assert isinstance(call['body'], dict), 'provider request is not JSON object'
        assert isinstance(call['body'].get('model'), str) and call['body']['model'], 'missing model'
        assert isinstance(call['body'].get('messages'), list) and call['body']['messages'], 'missing messages'
    assert isinstance(result, dict), 'adapter result must be object'
    if scenario in ('invalid_json', 'rate_limit', 'turn_limit'):
        assert result.get('status') == 'error', 'provider failure must fail closed'
        assert 'answer' not in result, 'failure must not emit an answer'
        assert result.get('side_effects') == 0, 'failure must not execute side effects'
        if scenario == 'turn_limit':
            assert len(calls) == MAX_CALLS, 'limit test must exercise both allowed calls'
    else:
        assert result.get('status') == 'ok' and result.get('answer') == 'synthetic-ok', 'unexpected successful result'
        assert result.get('side_effects') == 0, 'unexpected side effect'
    return len(calls)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter', nargs=argparse.REMAINDER, required=True, help='adapter command and arguments')
    args = parser.parse_args()
    if not args.adapter:
        parser.error('adapter command required')
    failed = False
    for scenario in ('success', 'invalid_json', 'rate_limit', 'turn_limit'):
        try:
            calls = check(args.adapter, scenario)
            print('PASS %s (%d observed mock calls)' % (scenario, calls))
        except (AssertionError, OSError, subprocess.TimeoutExpired) as exc:
            failed = True
            print('FAIL %s: %s' % (scenario, exc))
    return int(failed)

if __name__ == '__main__':
    sys.exit(main())
