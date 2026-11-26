import os
import sys
import unittest
import harness

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixture_adapter.py')

class HarnessSelfTest(unittest.TestCase):
    def test_fixture(self):
        for scenario in ('success', 'invalid_json', 'rate_limit', 'turn_limit'):
            with self.subTest(scenario=scenario):
                harness.check([sys.executable, '-B', FIXTURE], scenario)

    def test_reject_fail_open(self):
        for scenario in ('invalid_json', 'rate_limit'):
            with self.subTest(scenario=scenario):
                with self.assertRaises(AssertionError):
                    harness.check([sys.executable, '-B', FIXTURE, 'failopen'], scenario)

    def test_reject_over_limit(self):
        with self.assertRaises(AssertionError):
            harness.check([sys.executable, '-B', FIXTURE, 'overlimit'], 'turn_limit')

if __name__ == '__main__':
    unittest.main(verbosity=2)
