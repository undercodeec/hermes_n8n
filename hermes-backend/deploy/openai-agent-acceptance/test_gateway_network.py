import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import patch
import docker_acceptance as runner
import image_probe as probe

class Health(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'synthetic')

class PoisonProxy(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(502); self.end_headers()

class GatewayNetworkTests(unittest.TestCase):
    def test_loopback_probe_ignores_poisoned_proxy(self):
        try:
            server=ThreadingHTTPServer(('127.0.0.1',18772), Health)
        except OSError:
            self.skipTest('isolated local test port occupied')
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        proxy=ThreadingHTTPServer(('127.0.0.1',0), PoisonProxy)
        pt=threading.Thread(target=proxy.serve_forever,daemon=True); pt.start()
        try:
            proxy_url='http://127.0.0.1:%d' % proxy.server_port
            with patch.dict(os.environ, {'HTTP_PROXY':proxy_url,'http_proxy':proxy_url,
                                         'NO_PROXY':'','no_proxy':''}, clear=True), \
                 patch('urllib.request.proxy_bypass', return_value=False):
                with self.assertRaises(urllib.error.HTTPError) as failed:
                    urllib.request.build_opener().open('http://127.0.0.1:18772/health',timeout=2)
                self.assertEqual(failed.exception.code,502)
                status, body=probe.request('http://127.0.0.1:18772/health',timeout=2)
            self.assertEqual(status,200); self.assertEqual(body,b'synthetic')
            with self.assertRaises(ValueError): probe.request('http://api.openai.com:18772/health')
            with self.assertRaises(ValueError): probe.request('http://127.0.0.1:9999/health')
        finally:
            proxy.shutdown(); proxy.server_close(); pt.join()
            server.shutdown(); server.server_close(); thread.join()

    def test_proc_socket_parse_and_owned_fd_never_leak(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as td:
            root=Path(td); proc=root/'123'; (proc/'net').mkdir(parents=True); (proc/'fd').mkdir()
            (proc/'fd'/'4').write_text('')
            header='sl local_address rem_address st tx_queue tr tm->when retrnsmt uid timeout inode\n'
            # Target 18772 = 4954; default 8642 = 21C2. Include a non-listening row.
            data=(header+'0: 0100007F:4954 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345\n'
                  +'1: 00000000:21C2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 99999\n'
                  +'2: 0100007F:1234 00000000:0000 01 00000000:00000000 00:00000000 00000000 1000 0 88888\n')
            (proc/'net'/'tcp').write_text(data)
            with patch.object(probe.os,'readlink',return_value='socket:[12345]'):
                result=probe.listener_snapshot(123,root)
            self.assertTrue(result['proc_tcp_readable']); self.assertFalse(result['proc_tcp6_readable'])
            self.assertTrue(result['listen_target']); self.assertTrue(result['listen_default'])
            self.assertTrue(result['gateway_owned_target']); self.assertFalse(result['gateway_owned_default'])
            self.assertFalse(result['gateway_owned_other'])
            output=runner.format_safe_diagnostics({'listeners':result})
            self.assertIn('listen_target=true',output); self.assertIn('gateway_owned_default=false',output)
            self.assertNotIn('0100007F',output); self.assertNotIn('12345',output)

    def test_health_scan_is_diagnostic_not_fallback(self):
        with patch.object(probe,'request',side_effect=[OSError(),(200,b'private')]):
            scan=probe.diagnostic_health_scan()
        self.assertEqual(scan,{'health_target_200':False,'health_default_200':True})
        self.assertIsNotNone(runner.evaluate_gateway('success', {'calls':[], 'listeners':scan}))
        rendered=runner.format_safe_diagnostics({'listeners':{**scan,'private':'do-not-leak'}})
        self.assertIn('health_default_200=true',rendered); self.assertNotIn('do-not-leak',rendered)

if __name__ == '__main__': unittest.main(verbosity=2)
