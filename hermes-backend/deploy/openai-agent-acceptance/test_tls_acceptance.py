import json
import socket
import ssl
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
import qa_certificates
import tls_docker_acceptance as runner
import tls_image_probe as probe

HERE = Path(__file__).resolve().parent

def good_call():
    return {'path':'/v1/chat/completions', 'model':'gpt-6-luna', 'host':'api.openai.com',
            'stream':False, 'max_completion_tokens':100, 'messages_count':2, 'system_contains_policy':True}

class Tests(unittest.TestCase):
    def test_docker_commands_enforce_isolation_and_real_ca(self):
        cmd = runner.probe_command('sha256:' + 'a'*64, 'qa', 'success', '/opt/venv/certifi/cacert.pem',
                                   Path('/test/ca'), Path('/test/cert'), Path('/test/key'))
        for item in ('--network=none', '--user', 'hermes', '--pull=never', '--cap-drop=ALL',
                     'api.openai.com:127.0.0.1', 'net.ipv4.ip_unprivileged_port_start=0'):
            self.assertIn(item, cmd)
        self.assertTrue(any('dst=/opt/venv/certifi/cacert.pem,readonly' in x for x in cmd))
        self.assertFalse(any('verify=false' in x.lower() for x in cmd))
        self.assertNotIn('--privileged', cmd)
        negative = runner.probe_command('img', 'qa', 'untrusted_ca', '/a/ca.pem', Path('/test/ca'), Path('/test/cert'), Path('/test/key'))
        self.assertFalse(any('dst=/a/ca.pem' in x for x in negative))
        with self.assertRaises(ValueError): runner.probe_command('img','qa','success','/a/../x',Path('/c'),Path('/s'),Path('/k'))

    def test_evaluator_checks_observed_contract_and_failure(self):
        success = {'calls':[good_call()], 'outcome':'success', 'ledger_calls':1,
                   'reported_api_calls':1, 'content':'{"replyText":"synthetic-ok"}'}
        self.assertIsNone(runner.evaluate('success', success))
        self.assertIsNotNone(runner.evaluate('content_json', success))
        self.assertIsNotNone(runner.evaluate('success', {**success, 'calls':[]}))
        self.assertIsNotNone(runner.evaluate('success', {**success, 'calls':[good_call(),good_call()]}))
        self.assertIsNone(runner.evaluate('rate_limit', {'calls':[good_call()], 'ledger_calls':1, 'outcome':'error'}))
        limited = {**success, 'second_outcome':'error','second_error_type':'BudgetAbort', 'ledger_calls_after_second':1, 'terminal_reason_after_second':'call_limit'}
        self.assertIsNone(runner.evaluate('turn_limit', limited))
        self.assertIsNotNone(runner.evaluate('turn_limit', {**limited, 'second_outcome':'success'}))
        self.assertIsNone(runner.evaluate('untrusted_ca', {'calls':[],'ledger_calls':1,'outcome':'error','error_type':'APIConnectionError'}))

    def test_real_tls_chain_hostname_and_dispatch(self):
        with tempfile.TemporaryDirectory(prefix='qa-test-', dir=HERE) as directory:
            ca, cert, key = qa_certificates.create(directory)
            probe.SCENARIO = 'success'; probe.CALLS.clear()
            server = ThreadingHTTPServer(('127.0.0.1', 0), probe.Mock)
            server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server_ctx.load_cert_chain(cert, key)
            server.socket = server_ctx.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                context = ssl.create_default_context(cafile=str(ca))
                self.assertTrue(context.check_hostname); self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                with socket.create_connection(server.server_address, timeout=3) as raw:
                    with context.wrap_socket(raw, server_hostname='api.openai.com') as client:
                        body = json.dumps({'model':'gpt-6-luna','messages':[{'role':'system','content':'synthetic CRM policy'}, {'role':'user','content':'hello'}], 'stream':False, 'max_completion_tokens':100}).encode()
                        client.sendall(b'POST /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
                        received = b''
                        while True:
                            chunk = client.recv(4096)
                            if not chunk: break
                            received += chunk
                        self.assertIn(b'200 OK', received)
                self.assertEqual(probe.CALLS, [good_call()])
                with socket.create_connection(server.server_address, timeout=3) as raw:
                    with self.assertRaises(ssl.SSLCertVerificationError): context.wrap_socket(raw, server_hostname='wrong.example')
                with socket.create_connection(server.server_address, timeout=3) as raw:
                    with self.assertRaises(ssl.SSLCertVerificationError): ssl.create_default_context().wrap_socket(raw, server_hostname='api.openai.com')
                self.assertEqual(len(probe.CALLS), 1)
            finally:
                server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main(verbosity=2)
