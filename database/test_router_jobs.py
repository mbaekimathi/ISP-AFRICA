import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import router_jobs


class RouterJobTests(unittest.TestCase):
    def test_discovery_does_not_invent_a_live_check(self):
        result = router_jobs.discover_result(
            {"name": "Tower", "routeros_version": "7", "tunnel_status": "unknown"}
        )
        self.assertFalse(result["checked"])
        self.assertIsNone(result["model"])
        self.assertIsNone(result["lastSuccessfulCheck"])
        self.assertEqual(result["capabilities"], ["wireguard"])
        self.assertNotIn("password", result)

    def test_configuration_is_not_retried(self):
        status, delay = router_jobs.classify_retry("configure", "timed_out", 1, 3)
        self.assertEqual(status, "timed_out")
        self.assertIsNone(delay)

    def test_read_only_timeout_backs_off_until_the_limit(self):
        status, delay = router_jobs.classify_retry("discover", "timed_out", 1, 3)
        self.assertEqual((status, delay), ("queued", 2))
        status, delay = router_jobs.classify_retry("discover", "timed_out", 3, 3)
        self.assertEqual(status, "timed_out")
        self.assertIsNone(delay)

    def test_not_configured_failure_is_terminal(self):
        status, delay = router_jobs.classify_retry("discover", "failed", 1, 3)
        self.assertEqual(status, "failed")
        self.assertIsNone(delay)

    def test_one_router_failure_does_not_stop_the_next(self):
        seen = []

        def run(device):
            seen.append(device)
            if device == "bad":
                raise RuntimeError("secret-password")
            return "ok"

        outcomes = []
        for device in ("bad", "good"):
            try:
                outcomes.append(run(device))
            except Exception:
                outcomes.append("failed")
        self.assertEqual(outcomes, ["failed", "ok"])
        self.assertEqual(seen, ["bad", "good"])

    def test_duplicate_clicks_reuse_the_active_job(self):
        active = {}

        def enqueue(key):
            if key in active:
                return active[key], False
            active[key] = "job-1"
            return "job-1", True

        first, created = enqueue("router:discover")
        second, again = enqueue("router:discover")
        self.assertTrue(created)
        self.assertFalse(again)
        self.assertEqual(first, second)

    def test_parallel_failures_stay_isolated(self):
        results = []
        lock = threading.Lock()

        def work(name):
            if name == "bad":
                raise TimeoutError("down")
            return "succeeded"

        def settle(name):
            try:
                outcome = work(name)
            except TimeoutError:
                outcome = "timed_out"
            except Exception:
                outcome = "failed"
            with lock:
                results.append((name, outcome))

        threads = [threading.Thread(target=settle, args=(name,)) for name in ("bad", "good", "bad")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), [("bad", "timed_out"), ("bad", "timed_out"), ("good", "succeeded")])

    def test_rate_limit_bounds_repeats(self):
        router_jobs.RATE_HITS.clear()
        self.assertTrue(router_jobs.allow_job("client", 0))
        os_limit = router_jobs.os.environ.get("ISP_JOB_RATE_PER_MINUTE")
        router_jobs.os.environ["ISP_JOB_RATE_PER_MINUTE"] = "1"
        try:
            self.assertFalse(router_jobs.allow_job("client", 1))
            self.assertTrue(router_jobs.allow_job("other", 1))
        finally:
            if os_limit is None:
                router_jobs.os.environ.pop("ISP_JOB_RATE_PER_MINUTE", None)
            else:
                router_jobs.os.environ["ISP_JOB_RATE_PER_MINUTE"] = os_limit
            router_jobs.RATE_HITS.clear()

    def test_job_error_fits_the_stored_column(self):
        captured = {}

        class Cursor:
            def execute(self, _sql, params):
                captured["message"] = params[1]

        router_jobs.finish_job(
            Cursor(),
            {"operation": "switch-uplink", "attempts": 1, "max_attempts": 1, "id": "job"},
            "failed",
            "x" * 400,
            None,
        )
        self.assertEqual(len(captured["message"]), 240)


if __name__ == "__main__":
    unittest.main()
