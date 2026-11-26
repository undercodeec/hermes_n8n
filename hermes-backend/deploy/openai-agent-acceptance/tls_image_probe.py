"""Executed in candidate image as hermes, network none; no production code patched."""
import json
import os
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else None
CALLS = []

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1000000: raise ValueError('bad length')
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict): raise ValueError('bad body')
            messages = request.get('messages')
            CALLS.append({'path': self.path, 'model': request.get('model'),
                          'host': self.headers.get('Host'), 'stream': request.get('stream'),
                          'max_completion_tokens': request.get('max_completion_tokens'),
                          'messages_count': len(messages) if isinstance(messages, list) else 0,
                          'system_contains_policy': isinstance(messages, list) and bool(messages) and
                              messages[0].get('role') == 'system' and 'synthetic CRM policy' in str(messages[0].get('content'))})
        except (TypeError, ValueError, AttributeError):
            CALLS.append({'path': self.path, 'invalid': True})
        if SCENARIO == 'http_json':
            code, data = 200, b'{broken JSON'
        elif SCENARIO == 'rate_limit':
            code, data = 429, b'{"error":{"message":"synthetic","type":"rate_limit_error"}}'
        else:
            content = '{invalid' if SCENARIO == 'content_json' else '{"replyText":"synthetic-ok"}'
            message = {'role': 'assistant', 'content': content}
            finish = 'length' if SCENARIO == 'nonstop' else 'stop'
            code = 200
            data = json.dumps({'id':'test', 'object':'chat.completion', 'created':1, 'model':'gpt-6-luna',
                'choices':[{'index':0, 'message':message, 'finish_reason':finish}],
                'usage':{'prompt_tokens':10, 'completion_tokens':4, 'total_tokens':14}}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run():
    # Fail if accidentally run as root; mock must use TLS with hostname verification enabled.
    if os.geteuid() == 0: return {'fatal': 'probe must run as hermes non-root', 'calls': []}
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 443), Mock)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain('/qa/server.pem', '/qa/server-key.pem')
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    except (OSError, ssl.SSLError) as exc:
        return {'fatal': 'TLS mock startup: ' + type(exc).__name__, 'calls': []}
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    result = {'calls': CALLS}
    try:
        from agent.provider_budget import BudgetPolicy, scoped_budget
        from agent.openai_budgeted_turn import run_text_turn
        policy = BudgetPolicy.from_config(dict(model='gpt-6-luna', max_calls=1,
            max_input_bytes=16384, max_input_tokens=65536, max_output_tokens=100,
            max_estimated_usd='1', input_usd_per_million='1', output_usd_per_million='1'))
        agent = SimpleNamespace(provider='openai-api', model='gpt-6-luna', api_mode='chat_completions',
            base_url='https://api.openai.com/v1', api_key='synthetic-test-only', _fallback_chain=[],
            ephemeral_system_prompt='synthetic CRM policy', _build_system_prompt=lambda _: 'synthetic system')
        with scoped_budget(policy) as ledger:
            try:
                turn = run_text_turn(agent, ledger, 'synthetic user input', None, [])
                result['outcome'] = 'success'
                result['content'] = turn.get('final_response')
                result['reported_api_calls'] = turn.get('api_calls')
            except Exception as exc:
                result['outcome'] = 'error'
                result['error_type'] = type(exc).__name__
            result['ledger_calls'] = ledger.calls
            result['terminal_reason'] = ledger.terminal_reason
            if SCENARIO == 'turn_limit':
                try:
                    run_text_turn(agent, ledger, 'synthetic second attempt', None, [])
                    result['second_outcome'] = 'success'
                except Exception as exc:
                    result['second_outcome'] = 'error'
                    result['second_error_type'] = type(exc).__name__
                result['ledger_calls_after_second'] = ledger.calls
                result['terminal_reason_after_second'] = ledger.terminal_reason
    except Exception as exc:
        result['fatal'] = 'probe import or setup: ' + type(exc).__name__
    finally:
        server.shutdown(); server.server_close(); thread.join()
    return result

if __name__ == '__main__': print(json.dumps(run(), separators=(',', ':')))
