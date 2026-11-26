import unittest
import docker_acceptance as d


def obs(calls=1, status=200, body=None):
    request = {'path': '/v1/chat/completions', 'model': 'gpt-test', 'messages_count': 1}
    if body is None:
        body = {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"replyText":"synthetic-ok"}'}}]}
    return {'calls': [dict(request) for _ in range(calls)], 'http_status': status, 'body': body}

class DockerAcceptanceTests(unittest.TestCase):
    def test_isolation_command(self):
        command = d.docker_command('local:qa', 'success', 'hermes-qa-id')
        self.assertIn('--network=none', command)
        self.assertIn('--pull=never', command)
        self.assertIn('--cap-drop=ALL', command)
        self.assertNotIn('--privileged', command)
        self.assertNotIn('-p', command)
        self.assertTrue(any('readonly' in item for item in command))

    def test_success_needs_actual_observation(self):
        self.assertIsNone(d.evaluate('success', obs()))
        self.assertIsNotNone(d.evaluate('success', obs(calls=0)))
        self.assertIsNotNone(d.evaluate('success', obs(calls=3)))
        self.assertIsNotNone(d.evaluate('success', obs(body={'choices': []})))
        bad = obs(); bad['calls'][0]['path'] = '/v1/responses'
        self.assertIsNotNone(d.evaluate('success', bad))

    def test_failure_must_be_closed(self):
        self.assertIsNone(d.evaluate('invalid_json', obs(status=502, body={'error': {}})))
        self.assertIsNotNone(d.evaluate('rate_limit', obs()))
        self.assertIsNotNone(d.evaluate('rate_limit', obs(status=500, body={'error': {}, 'choices': []})))
        self.assertIsNotNone(d.evaluate('rate_limit', obs(status=200, body={'error': {}})))

    def test_limit_must_be_exercised_and_bounded(self):
        self.assertIsNone(d.evaluate('turn_limit', obs(calls=2, status=503, body={'error': {}})))
        self.assertIsNotNone(d.evaluate('turn_limit', obs(calls=1, status=503, body={'error': {}})))
        self.assertIsNotNone(d.evaluate('turn_limit', obs(calls=3, status=503, body={'error': {}})))

if __name__ == '__main__':
    unittest.main(verbosity=2)
