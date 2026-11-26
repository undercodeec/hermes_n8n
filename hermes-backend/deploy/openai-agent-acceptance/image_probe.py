"""Runs INSIDE the unmodified candidate container, Docker network=none.

The mock and HTTP client are loopback-only. All evidence is independently measured;
no agent functions are patched or replaced.
"""
import json
import os
import ssl
import secrets
import pathlib
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENARIO = None
# Ephemeral synthetic key: never emitted or inherited from the host.
KEY = secrets.token_hex(32)
HOME = pathlib.Path('/tmp/qa-hermes')
CONFIG = {
    'model': {'default': 'gpt-6-luna', 'provider': 'openai-api', 'api_mode': 'chat_completions', 'base_url': 'https://api.openai.com/v1'},
    'platform_toolsets': {'api_server': []},
    'platforms': {'api_server': {'enabled': True, 'host': '127.0.0.1',
                                  'port': 18772, 'model_name': 'hermes-agent'}},
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


def gateway_env():
    return {'PATH': '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp',
            'HERMES_HOME': str(HOME), 'OPENAI_API_KEY': secrets.token_hex(32),
            'OPENAI_BASE_URL': 'https://api.openai.com/v1', 'API_SERVER_KEY': KEY,
            'API_SERVER_ENABLED': 'true', 'API_SERVER_HOST': '127.0.0.1',
            'API_SERVER_PORT': '18772', 'API_SERVER_MODEL_NAME': 'hermes-agent',
            'PYTHONDONTWRITEBYTECODE': '1', 'NO_PROXY': '*'}


def request(url, data=None, timeout=40):
    headers = {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read(1000000)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(1000000)


def response_summary(raw):
    try:
        body = json.loads(raw)
        if not isinstance(body, dict): return {'json_object': False}
        summary = {'json_object': True, 'has_error': 'error' in body, 'has_choices': 'choices' in body,
                   'synthetic_answer_ok': False}
        try:
            choice = body['choices'][0]
            parsed = json.loads(choice['message']['content'])
            summary['synthetic_answer_ok'] = choice['finish_reason'] == 'stop' and parsed == {'answer': 'synthetic-ok'}
        except (KeyError, TypeError, IndexError, ValueError):
            pass
        return summary
    except (ValueError, UnicodeDecodeError):
        return {'json_object': False}


# Only fixed labels ever leave the probe; no arbitrary gateway log line or HTTP body.
LOG_PATTERNS = {
    'api_key_rejected': ('api_server_key is a placeholder', 'api_server_key is required',
                         'api_server_key strength could not be verified'),
    'aiohttp_missing': ('aiohttp not installed',),
    'api_listener_started': ('api server listening on',),
    'address_in_use': ('address already in use',),
    'permission_denied': ('permissionerror', 'permission denied'),
    'module_missing': ('modulenotfounderror', 'no module named'),
    'import_error': ('importerror',),
    'config_parse_failed': ('failed to process config.yaml',),
    'no_platforms': ('no platforms configured', 'no platforms enabled', 'no platforms connected'),
    'api_connect_failed': ('failed to connect api_server', 'api server failed to start'),
}


def classify_gateway_log(path):
    try:
        # Bounded read: inspect only the tail; do not output log content.
        with path.open('rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 262144))
            text = f.read().decode('utf-8', errors='replace').lower()
    except OSError:
        return ['log_unavailable']
    return [name for name, patterns in LOG_PATTERNS.items() if any(p in text for p in patterns)]


def classify_health_error(exc):
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ConnectionRefusedError): return 'connection_refused'
    if isinstance(reason, (TimeoutError,)): return 'timeout'
    if isinstance(reason, ConnectionResetError): return 'connection_reset'
    return 'other_io_error'


def gateway_preflight(env):
    # Execute the image's actual loader under the exact environment used for gateway.
    # Only allowlisted booleans are returned; never forward output, config, keys or tracebacks.
    code = ("import json; from gateway.config import load_gateway_config,Platform,_has_usable_api_server_key; "
            "c=load_gateway_config(); p=c.platforms.get(Platform.API_SERVER); "
            "x=p.extra if p else {}; print(json.dumps({"
            "'api_platform_present': p is not None, 'api_enabled': bool(p and p.enabled), "
            "'api_key_usable': bool(_has_usable_api_server_key(x.get('key'))), "
            "'api_connected': Platform.API_SERVER in c.get_connected_platforms(), "
            "'host_expected': x.get('host') == '127.0.0.1', 'port_expected': x.get('port') == 18772, "
            "'model_expected': x.get('model_name') == 'hermes-agent'}))")
    fields = ('api_platform_present', 'api_enabled', 'api_key_usable', 'api_connected',
              'host_expected', 'port_expected', 'model_expected')
    try:
        proc = subprocess.run(['/opt/hermes/.venv/bin/python3', '-B', '-c', code], env=env,
                              cwd='/opt/hermes', capture_output=True, text=True, timeout=15)
        if proc.returncode: return {'result': 'process_failed'}
        data = json.loads(proc.stdout.splitlines()[-1])
        if not isinstance(data, dict) or any(type(data.get(k)) is not bool for k in fields):
            return {'result': 'invalid_output'}
        return {'result': 'ok', **{k: data[k] for k in fields}}
    except subprocess.TimeoutExpired:
        return {'result': 'timeout'}
    except (OSError, ValueError, IndexError):
        return {'result': 'unavailable'}


def main():
    global SCENARIO
    SCENARIO = sys.argv[1]
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / 'config.yaml').write_text(json.dumps(CONFIG), encoding='utf-8')
    if os.geteuid() == 0:
        return {'calls': [], 'diagnostic_code': 'root_forbidden'}
    import tls_image_probe as upstream
    upstream.SCENARIO = {'invalid_json': 'http_json', 'turn_limit': 'nonstop'}.get(SCENARIO, SCENARIO)
    upstream.CALLS.clear()
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 443), upstream.Mock)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain('/qa/server.pem', '/qa/server-key.pem')
        server.socket = context.wrap_socket(server.socket, server_side=True)
    except (OSError, ssl.SSLError) as exc:
        return {'calls': [], 'diagnostic_code': 'tls_mock_startup_failed'}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = gateway_env()
    # CLI comes from the candidate image; no host Docker socket and no mounts of source/config.
    proc = None
    output = {'calls': upstream.CALLS}
    stderr_path = HOME / 'gateway.stderr'
    stderr_file = stderr_path.open('w', encoding='utf-8')
    output['preflight'] = gateway_preflight(env)
    try:
        proc = subprocess.Popen(['/opt/hermes/.venv/bin/hermes', 'gateway', 'run'], env=env,
                                cwd='/opt/hermes', stdout=stderr_file, stderr=stderr_file)
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                output['diagnostic_code'] = 'gateway_exited'
                output['gateway_exit_code'] = proc.returncode
                return output
            try:
                status, _ = request('http://127.0.0.1:18772/health', timeout=1)
                output['health_http_status'] = status
                if status == 200:
                    output.pop('health_error', None)
                    break
                output['health_error'] = 'http_non_200'
            except (OSError, urllib.error.URLError, TimeoutError) as exc:
                output['health_error'] = classify_health_error(exc)
            time.sleep(0.25)
        else:
            output['diagnostic_code'] = 'gateway_readiness_timeout'
            return output
        data = json.dumps(gateway_request_body()).encode()
        status, body = request('http://127.0.0.1:18772/v1/chat/completions', data)
        output['http_status'] = status
        output['response'] = response_summary(body)
        if not output['response']['json_object']:
            output['diagnostic_code'] = 'gateway_response_not_json'
    except (OSError, urllib.error.URLError) as exc:
        output['diagnostic_code'] = 'gateway_io_error'
        output['health_error'] = classify_health_error(exc)
    finally:
        stderr_file.close()
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        output['log_flags'] = classify_gateway_log(stderr_path)
        server.shutdown()
        server.server_close()
        thread.join()
    return output

if __name__ == '__main__':
    print(json.dumps(main(), separators=(',', ':')))
