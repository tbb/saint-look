import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'ui-watchdog.py'


class WatchdogTests(unittest.TestCase):
    def run_child(self, code, *options):
        with tempfile.TemporaryDirectory() as folder:
            summary = Path(folder) / 'summary.json'
            result = subprocess.run([sys.executable, str(SCRIPT), '--summary', str(summary),
                                     *options, '--', sys.executable, '-u', '-c', code],
                                    capture_output=True, text=True, timeout=10)
            return result, json.loads(summary.read_text())

    def test_preserves_failure_and_timings(self):
        result, summary = self.run_child('''
print("Test Case '-[Tests testOne]' started.")
print("Test Case '-[Tests testOne]' failed (0.3 seconds).")
raise SystemExit(65)
''')
        self.assertEqual(result.returncode, 65)
        self.assertEqual(summary['tests'], [dict(test='-[Tests testOne]', result='failed', seconds=0.3)])

    def test_launch_failure_cannot_wait_for_the_job_timeout(self):
        result, summary = self.run_child('''
import time
print("Test Case '-[Tests testCreate]' started.")
print('Failed to get launch progress: No such process')
print('Wait for com.saintlook.dev to become Running Foreground')
time.sleep(60)
''', '--idle-seconds', '0.3')
        self.assertEqual(result.returncode, 124)
        self.assertEqual(summary['reason'], 'no-output')
        self.assertEqual(summary['activeTest'], '-[Tests testCreate]')
        self.assertLess(summary['elapsedSeconds'], 3)

    def test_recorded_fatal_launch_error_stops_without_waiting_for_a_stall(self):
        result, summary = self.run_child("""
import time
print("Test Case '-[Tests testCreate]' started.")
print('/work/OutfitFlowTests.swift:250: error: -[Tests testCreate] : Failed to get launch progress for <XCUIApplicationImpl com.saintlook.dev>: Simulator device failed to launch com.saintlook.dev. No such process.')
while True:
 print('Wait for com.saintlook.dev to idle')
 time.sleep(0.02)
""", '--case-seconds', '1')
        self.assertEqual(result.returncode, 65)
        self.assertEqual(summary['reason'], 'app-launch-failed')
        self.assertEqual(summary['activeTest'], '-[Tests testCreate]')
        self.assertLess(summary['elapsedSeconds'], 3)

    def test_platform_warning_alone_does_not_abort_acceptance(self):
        result, summary = self.run_child("""
print("Test Case '-[Tests testOne]' started.")
print('warning: Simulator device failed to launch com.saintlook.dev. No such process.')
print("Test Case '-[Tests testOne]' passed (1.5 seconds).")
""")
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(summary['reason'])

    def test_chatty_stuck_case_is_bounded_too(self):
        result, summary = self.run_child('''
import time
print("Test Case '-[Tests testStuck]' started.")
while True:
 print('Waiting for app to idle')
 time.sleep(0.02)
''', '--case-seconds', '0.3')
        self.assertEqual(result.returncode, 124)
        self.assertEqual(summary['reason'], 'test-deadline')

    def test_success_is_not_changed(self):
        result, summary = self.run_child('print("Test Case \'-[Tests testOne]\' passed (1.5 seconds).")')
        self.assertEqual(result.returncode, 0)
        self.assertIsNone(summary['reason'])

    def test_empty_success_does_not_claim_acceptance(self):
        result, summary = self.run_child('pass')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(summary['reason'], 'no-test-results')

    def test_cancellation_is_preserved(self):
        result, summary = self.run_child('''
import os, signal, time
os.kill(os.getppid(), signal.SIGTERM)
time.sleep(60)
''')
        self.assertEqual(result.returncode, 143)
        self.assertEqual(summary['reason'], 'cancelled')

    def test_partial_output_cannot_block_the_timer(self):
        result, summary = self.run_child('''
import sys, time
sys.stdout.write('partial line without newline')
sys.stdout.flush()
time.sleep(60)
''', '--idle-seconds', '0.3')
        self.assertEqual(result.returncode, 124)
        self.assertEqual(summary['reason'], 'no-output')


if __name__ == '__main__':
    unittest.main()
