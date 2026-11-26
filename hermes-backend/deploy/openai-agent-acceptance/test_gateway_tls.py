import pathlib
import unittest
import docker_acceptance as runner
import image_probe as probe


def observation():
    return {'calls':[{'path':'/v1/chat/completions','model':'gpt-6-luna','host':'api.openai.com',
        'stream':False,'max_completion_tokens':100,'messages_count':2,'system_contains_policy':True}],
        'http_status':200,'body':{'choices':[{'finish_reason':'stop','message':{'content':'{"answer":"synthetic-ok"}'}}]}}

class GatewayTlsTests(unittest.TestCase):
    def test_candidate_config_and_gateway_input(self):
        config = probe.CONFIG
        self.assertEqual(config['model']['default'], 'gpt-6-luna')
        self.assertEqual(config['model']['provider'], 'openai-api')
        self.assertEqual(config['model']['base_url'], 'https://api.openai.com/v1')
        self.assertEqual(config['model']['api_mode'], 'chat_completions')
        self.assertEqual(config['agent']['provider_budget']['max_calls'], 1)
        req = probe.gateway_request_body()
        self.assertEqual(req['model'], 'hermes-agent')
        self.assertEqual(req['messages'][0], {'role':'system','content':'synthetic CRM policy'})
        self.assertFalse(req['stream'])

    def test_gateway_command_contains_tls_and_both_probes(self):
        cmd = runner.gateway_command('image', 'success', 'name', '/opt/certifi/cacert.pem',
             pathlib.Path('/test/ca'), pathlib.Path('/test/cert'), pathlib.Path('/test/key'))
        for item in ('--network=none','--user','hermes','--pull=never','api.openai.com:127.0.0.1'):
            self.assertIn(item,cmd)
        self.assertTrue(any('dst=/opt/certifi/cacert.pem,readonly' in arg for arg in cmd))
        self.assertTrue(any('dst=/qa/image_probe.py,readonly' in arg for arg in cmd))
        self.assertTrue(any('dst=/qa/tls_image_probe.py,readonly' in arg for arg in cmd))
        self.assertEqual(cmd[-4:], ['image','-B','/qa/image_probe.py','success'])
        self.assertNotIn('--privileged',cmd)

    def test_success_demands_gateway_and_exact_mock_contract(self):
        obs = observation()
        self.assertIsNone(runner.evaluate_gateway('success',obs))
        obs['calls'][0]['model'] = 'other'
        self.assertIsNotNone(runner.evaluate_gateway('success',obs))
        obs = observation(); obs['calls'][0]['system_contains_policy'] = False
        self.assertIsNotNone(runner.evaluate_gateway('success',obs))
        obs = observation(); obs['http_status'] = 500
        self.assertIsNotNone(runner.evaluate_gateway('success',obs))
        obs = observation(); obs['calls'].append(dict(obs['calls'][0]))
        self.assertIsNotNone(runner.evaluate_gateway('success',obs))

    def test_turn_limit_not_claimed_from_one_shot_gateway(self):
        obs = observation(); obs['calls'].append(dict(obs['calls'][0]))
        obs['http_status'] = 500; obs['body'] = {'error':{}}
        self.assertIn('one-shot', runner.evaluate_gateway('turn_limit',obs))

if __name__ == '__main__': unittest.main(verbosity=2)
