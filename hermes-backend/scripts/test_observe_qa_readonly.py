import subprocess
import unittest
from unittest.mock import patch

from observe_qa_readonly import build_sql, observe


SOURCE_ID = '13d6ef41-8384-4f2e-a0d0-1486d39a9080'
AFTER = '2026-10-25T00:00:00Z'


class ObserverTest(unittest.TestCase):
    def test_validates_inputs_and_constructs_read_only_sql(self):
        sql = build_sql(SOURCE_ID, AFTER)
        self.assertIn('BEGIN READ ONLY;', sql)
        self.assertIn('COMMIT;', sql)
        self.assertIn('FROM messages', sql)
        self.assertIn('FROM automated_deliveries', sql)
        self.assertNotIn('SENTINEL_PERSONAL_TEXT', sql)
        for bad in [SOURCE_ID + "'; DROP TABLE messages; --", 'not-a-uuid']:
            with self.assertRaises(ValueError):
                build_sql(bad, AFTER)
        with self.assertRaises(ValueError):
            build_sql(SOURCE_ID, "2026-10-25T00:00:00Z'; DELETE FROM messages; --")

    @patch('observe_qa_readonly.subprocess.run')
    def test_stdin_requires_docker_exec_i_and_reports_rows(self, run):
        def fake(command, *, input, text, capture_output, check, timeout):
            if '-i' not in command:
                return subprocess.CompletedProcess(command, 1, '', 'stdin closed')
            self.assertTrue(input.startswith('BEGIN READ ONLY;'))
            return subprocess.CompletedProcess(command, 0,
                'MESSAGE|13d6ef41-8384-4f2e-a0d0-1486d39a9080|2026-10-25 00:01:00+00\n'
                'DELIVERY|5ed40000-0000-4000-8000-000000000001|SUPPRESSED\n', '')
        run.side_effect = fake
        result = observe(SOURCE_ID, AFTER)
        self.assertEqual(result, {
            'state': 'ROWS', 'messageCount': 1, 'deliveryCount': 1,
            'deliveryStatuses': ['SUPPRESSED'],
        })
        self.assertIn('-i', run.call_args.args[0])
        self.assertIn('-q', run.call_args.args[0][-1])

    @patch('observe_qa_readonly.subprocess.run')
    def test_psql_command_tags_do_not_mask_an_empty_result(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'BEGIN\nCOMMIT\n', '')
        self.assertEqual(observe(SOURCE_ID, AFTER)['state'], 'NO_ROWS')

    @patch('observe_qa_readonly.subprocess.run')
    def test_empty_rows_and_sql_error_are_distinct(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, '', '')
        self.assertEqual(observe(SOURCE_ID, AFTER)['state'], 'NO_ROWS')
        run.return_value = subprocess.CompletedProcess([], 2, '', 'SENTINEL_PERSONAL_TEXT')
        self.assertEqual(observe(SOURCE_ID, AFTER), {'state': 'SQL_ERROR', 'exitCode': 2})
        self.assertNotIn('SENTINEL_PERSONAL_TEXT', str(observe(SOURCE_ID, AFTER)))


if __name__ == '__main__':
    unittest.main()
