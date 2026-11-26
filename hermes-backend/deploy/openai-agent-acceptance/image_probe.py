"""Runs INSIDE the unmodified candidate container, Docker network=none.

The mock and HTTP client are loopback-only. All evidence is independently measured;
no agent functions are patched or replaced.
"""
import json
import os
import ssl
import pathlib
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENARIO = None
KEY = 'synthetic-local-only-gateway-key-0123456789abcdef'
HOME = pathlib.Path('/tmp/qa-hermes')
CONFIG = {
    'model': {'default': 'gpt-6-luna', 'provider': 'openai-api', 'api_mode': 'chat_completions', 'base_url': 'https://api.openai.com/v1'},
    'platform_toolsets': {'api_server': []},
    'agent': {'api_max_retries': 0, 'disabled_toolsets': ['web', 'search', 'browser', 'terminal', 'file', 'skills', 'todo', 'memory', 'delegation'],
              'provider_budget': {'model': 'gpt-6-luna', 'max_calls': 1, 'max_input_bytes': 16384,
                                  'max_input_tokens': 65536, 'max_output_tokens': 100,
                                  'max_estimated_usd': '1', 'input_usd_per_million': '1', 'output_usd_per_million': '1'}},
    'memory': {'memory_enabled': False}, 'compression': {'enabled': False}}
CALLS = []

class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 1000000:
                raise ValueError('size')
            request = json.loads(self.rfile.read(size))
            model = request.get('model')
            messages = request.get('messages')
            CALLS.append({'path': self.path, 'model': model,
                          'messages_count': len(messages) if isinstance(messages, list) else 0})
        except (ValueError, AttributeError):
            CALLS.append({'path': self.path, 'model': None, 'messages_count': 0})
        if SCENARIO == 'rate_limit':
            status, body = 429, b'{"error":{"message":"synthetic rate limit","type":"rate_limit_error"}}'
        elif SCENARIO == 'invalid_json':
            status, body = 200, b'{invalid HTTP JSON'
        else:
            status = 200
            message = {'role': 'assistant', 'content': '{"answer":"synthetic-ok"}'}
            finish = 'stop'
            if SCENARIO == 'turn_limit':
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_test', 'type': 'function', 'function': {'name': 'synthetic_noop', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            body = json.dumps({'id': 'synthetic', 'object': 'chat.completion', 'created': 1,
                               'model': 'gpt-4o-mini', 'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                               'usage': {'prompt_tokens': 5, 'completion_tokens': 5, 'total_tokens': 10}}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def gateway_request_body():
    return {'model': 'hermes-agent', 'messages': [
        {'role': 'system', 'content': 'synthetic CRM policy'},
        {'role': 'user', 'content': 'Return only JSON {"answer":"synthetic-ok"}.'}], 'stream': False}


def request(url, data=None):
    headers = {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return response.status, response.read(1000000)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(1000000)


def main():
    global SCENARIO
    SCENARIO = sys.argv[1]
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / 'config.yaml').write_text(json.dumps(CONFIG), encoding='utf-8')
    if os.geteuid() == 0:
        return {'calls': [], 'diagnostic': 'probe must run as non-root hermes'}
    import tls_image_probe as upstream
    upstream.SCENARIO = {'invalid_json': 'http_json', 'turn_limit': 'nonstop'}.get(SCENARIO, SCENARIO)
    upstream.CALLS.clear()
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 443), upstream.Mock)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain('/qa/server.pem', '/qa/server-key.pem')
        server.socket = context.wrap_socket(server.socket, server_side=True)
    except (OSError, ssl.SSLError) as exc:
        return {'calls': [], 'diagnostic': 'TLS mock startup: ' + type(exc).__name__}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = {'PATH': '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp',
           'HERMES_HOME': str(HOME), 'OPENAI_API_KEY': 'synthetic-local-only',
           'OPENAI_BASE_URL': 'https://api.openai.com/v1', 'API_SERVER_KEY': KEY,
           'API_SERVER_HOST': '127.0.0.1', 'API_SERVER_PORT': '18772',
           'API_SERVER_MODEL_NAME': 'hermes-agent', 'PYTHONDONTWRITEBYTECODE': '1',
           'NO_PROXY': '*'}
    # CLI comes from the candidate image; no host Docker socket and no mounts of source/config.
    proc = None
    output = {'calls': upstream.CALLS}
    stderr_path = HOME / 'gateway.stderr'
    stderr_file = stderr_path.open('w', encoding='utf-8')
    try:
        proc = subprocess.Popen(['/opt/hermes/.venv/bin/hermes', 'gateway', 'run'], env=env,
                                cwd='/opt/hermes', stdout=stderr_file, stderr=stderr_file)
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                stderr_file.flush()
                text = stderr_path.read_text(encoding='utf-8', errors='replace').lower()
                categories = [name for name in ('modulenotfounderror', 'importerror', 'valueerror',
                              'permissionerror', 'filenotfounderror', 'typeerror', 'runtimeerror',
                              'config', 'gateway', 'python', 'platform', 'disabled', 'enabled',
                              'usage:', 'error:', 'not found', 'fatal', 'module', 'database',
                              'key', 'command', 'already running', 'no platforms', 'no platforms configured',
                              'no platforms enabled', 'not configured', 'no platform', 'set up',
                              'setup', 'install', 'missing', 'invalid', 'disabled', 'root',
                              'connect', 'environment', 'non-interactive') if name in text]
                if 'command' in text and 'root' in text:
                    import re
                    output['diagnostic_startup_words'] = ' '.join(
                        w for w in re.findall(r'[a-z]+', text)
                        if w in {'cannot', 'run', 'running', 'root', 'gateway', 'command', 'disabled',
                                 'docker', 'container', 'cli', 'use', 'user', 'not', 'requires', 'as',
                                 'permission', 'permissions', 'no', 'configuration', 'found', 'error',
                                 'daemon', 'already', 'started', 'file', 'missing', 'start', 'failed'})[:250]
                output['diagnostic'] = ('gateway exited before readiness (code %s; categories: %s)' %
                                        (proc.returncode, ','.join(categories) or 'unknown'))
                return output
            try:
                status, _ = request('http://127.0.0.1:18772/health')
                if status == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.25)
        else:
            output['diagnostic'] = 'gateway not ready within 35 seconds'
            return output
        data = json.dumps(gateway_request_body()).encode()
        status, body = request('http://127.0.0.1:18772/v1/chat/completions', data)
        output['http_status'] = status
        try:
            output['body'] = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            output['diagnostic'] = 'gateway response was not JSON'
    except (OSError, urllib.error.URLError) as exc:
        output['diagnostic'] = 'probe or gateway I/O error: ' + type(exc).__name__
    finally:
        stderr_file.close()
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        server.shutdown()
        server.server_close()
        thread.join()
    return output

if __name__ == '__main__':
    print(json.dumps(main(), separators=(',', ':')))
