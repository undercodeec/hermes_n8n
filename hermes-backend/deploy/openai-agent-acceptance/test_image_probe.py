import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
import image_probe as probe

class MockHttpTests(unittest.TestCase):
    def setUp(self):
        probe.CALLS.clear()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), probe.Upstream)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%d/v1/chat/completions' % self.server.server_port
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def send(self):
        req = urllib.request.Request(self.url, json.dumps({'model': 'x', 'messages': [{'role':'user','content':'synthetic'}]}).encode(), method='POST')
        try:
            with urllib.request.urlopen(req, timeout=3) as r: return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
    def test_scenarios_record_actual_dispatches(self):
        for scenario in ('success', 'invalid_json', 'rate_limit', 'turn_limit'):
            with self.subTest(scenario=scenario):
                probe.CALLS.clear(); probe.SCENARIO = scenario
                status, data = self.send()
                self.assertEqual(len(probe.CALLS), 1)
                self.assertEqual(probe.CALLS[0]['path'], '/v1/chat/completions')
                if scenario == 'invalid_json':
                    with self.assertRaises(ValueError): json.loads(data)
                elif scenario == 'rate_limit': self.assertEqual(status, 429)
                elif scenario == 'turn_limit': self.assertEqual(json.loads(data)['choices'][0]['finish_reason'], 'tool_calls')
                else: self.assertEqual(json.loads(data)['choices'][0]['finish_reason'], 'stop')

if __name__ == '__main__': unittest.main(verbosity=2)
