import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import docker_acceptance as runner
import image_probe as probe

class StartupTests(unittest.TestCase):
    def test_explicit_gateway_configuration_and_clean_env(self):
        api = probe.CONFIG['platforms']['api_server']
        self.assertEqual(api, {'enabled':True, 'host':'127.0.0.1', 'port':18772, 'model_name':'hermes-agent'})
        env = probe.gateway_env()
        self.assertEqual(env['API_SERVER_ENABLED'], 'true')
        self.assertEqual(env['API_SERVER_HOST'], '127.0.0.1')
        self.assertEqual(env['API_SERVER_PORT'], '18772')
        self.assertGreaterEqual(len(env['API_SERVER_KEY']), 32)
        self.assertEqual(env['API_SERVER_KEY'], probe.KEY)
        self.assertNotIn('WHATSAPP_ENABLED', env)
        self.assertEqual(env['HERMES_GATEWAY_NO_SUPERVISE'], '1')
        self.assertEqual(env['HERMES_DISABLE_LAZY_INSTALLS'], '1')
        self.assertNotIn('HERMES_LAZY_INSTALL_TARGET', env)
        self.assertNotIn('TIRITH_ENABLED', env)
        self.assertFalse(any('WATCHDOG' in k for k in env))

    def test_logs_are_fixed_labels_not_lines_or_secrets(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            path = Path(temp)/'log'
            secret = 'DO-NOT-LEAK-example-1234'
            path.write_text('PermissionError ' + secret + '\nAPI server listening on PRIVATE:' + secret)
            result = probe.classify_gateway_log(path)
            self.assertEqual(result, ['api_listener_started','permission_denied'])
            self.assertNotIn(secret, str(result))
            self.assertEqual(probe.classify_gateway_log(path / 'missing'), ['log_unavailable'])

    def test_preflight_only_exposes_allowlisted_boolean_fields(self):
        valid = dict.fromkeys(('api_platform_present','api_enabled','api_key_usable','api_connected',
                               'host_expected','port_expected','model_expected'), True)
        valid['secret'] = 'DO-NOT-LEAK'
        with patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(valid))):
            value = probe.gateway_preflight(probe.gateway_env())
        self.assertEqual(value['result'], 'ok')
        self.assertNotIn('secret',value)
        valid['api_enabled'] = 'DO-NOT-LEAK'
        with patch.object(probe.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(valid))):
            self.assertEqual(probe.gateway_preflight({}), {'result':'invalid_output'})

    def test_safe_diagnostics_filter_every_untrusted_field(self):
        marker='DO-NOT-LEAK'
        obs={'diagnostic_code':'gateway_readiness_timeout', 'health_error':'connection_refused',
             'gateway_exit_code':marker,'health_http_status':503,
             'preflight':{'result':'ok','api_enabled':False,'api_key_usable':marker},
             'log_flags':['no_platforms', marker], 'body':marker, 'diagnostic':marker}
        output=runner.format_safe_diagnostics(obs)
        self.assertIn('reason=gateway_readiness_timeout',output)
        self.assertIn('api_enabled=false',output)
        self.assertIn('log_categories=no_platforms',output)
        self.assertNotIn(marker,output)

    def test_response_summary_does_not_echo_body(self):
        marker='DO-NOT-LEAK'
        data=json.dumps({'error':{'message':marker}}).encode()
        response=probe.response_summary(data)
        self.assertTrue(response['has_error'])
        self.assertNotIn(marker, str(response))
        self.assertFalse(probe.response_summary(b'{broken')['json_object'])
        self.assertTrue(probe.response_summary(b'{"choices":[{"finish_reason":"stop","message":{"content":"{\\"replyText\\":\\"synthetic-ok\\"}"}}]}')['synthetic_answer_ok'])

    def test_passive_startup_snapshot(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            base = Path(temp); home = base/'home'; home.mkdir()
            proc = base/'proc'; process = proc/'123'; process.mkdir(parents=True)
            (home/'gateway.pid').write_text('sensitive pid content')
            (home/'gateway_state.json').write_text(json.dumps({'gateway_state':'starting','secret':'DO-NOT-LEAK'}))
            (process/'cmdline').write_bytes(b'/bin/sleep\0infinity\0DO-NOT-LEAK\0')
            (process/'stat').write_text('123 (sleep) S 1 2 3')
            result = probe.startup_snapshot(home, 123, proc)
            self.assertEqual(result, {'pid_file_present':True,'gateway_state':'starting',
                                      'process_kind':'sleep_infinity','process_state':'S'})
            self.assertNotIn('DO-NOT-LEAK', str(result))
            rendered = runner.format_safe_diagnostics({'startup': result})
            self.assertIn('process_kind=sleep_infinity', rendered)
            self.assertIn('gateway_state=starting', rendered)
            self.assertNotIn('DO-NOT-LEAK', rendered)
            (home/'gateway_state.json').write_text('{broken')
            self.assertEqual(probe.startup_snapshot(home, 999, proc)['gateway_state'], 'unavailable')

    def test_real_startup_log_categories_without_raw_log(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            home=Path(temp); (home/'logs').mkdir()
            (home/'logs'/'gateway.log').write_text('Starting Hermes Gateway...\nConnecting to api_server...\nDO-NOT-LEAK')
            stderr=home/'gateway.stderr'; stderr.write_text('s6 supervision DO-NOT-LEAK')
            flags=probe.startup_log_flags(stderr,home)
            self.assertEqual(flags,['api_connecting','gateway_start_entered','supervision_redirect'])
            rendered=runner.format_safe_diagnostics({'log_flags':flags})
            self.assertIn('supervision_redirect',rendered)
            self.assertNotIn('DO-NOT-LEAK',rendered)

    def test_health_diagnostics_are_classifications_only(self):
        self.assertEqual(probe.classify_health_error(urllib.error.URLError(ConnectionRefusedError('secret'))),'connection_refused')
        self.assertEqual(probe.classify_health_error(TimeoutError('secret')),'timeout')
        self.assertEqual(probe.classify_health_error(OSError('secret')),'other_io_error')

if __name__ == '__main__': unittest.main(verbosity=2)
