import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import radius_server


NOW = datetime(2026, 10, 19, 12, 0, 0)


def radacct_row(**extra):
    row = {
        "username": "0712000001",
        "nasipaddress": "10.88.0.10",
        "acctstarttime": NOW - timedelta(minutes=40),
        "acctupdatetime": None,
        "acctstoptime": None,
        "acctterminatecause": None,
    }
    row.update(extra)
    return row


class SweepCursor:
    """Applies the sweep UPDATE's WHERE clause against in-memory rows."""

    def __init__(self, radacct, devices, now=NOW):
        self.radacct = radacct
        self.devices = devices
        self.now = now
        self.rowcount = 0

    def execute(self, sql, args=None):
        flat = " ".join(sql.split())
        self.rowcount = 0
        if not flat.startswith("UPDATE radacct a"):
            return
        interim_minutes, dead_nas_minutes = args
        interim_cutoff = self.now - timedelta(minutes=interim_minutes)
        dead_cutoff = self.now - timedelta(minutes=dead_nas_minutes)
        for row in self.radacct:
            if row["acctstoptime"] is not None:
                continue
            last = row["acctupdatetime"] or row["acctstarttime"]
            device = next((d for d in self.devices if d["tunnel_ip"] == row["nasipaddress"]), None)
            interim_seen = row["acctupdatetime"] is not None and row["acctupdatetime"] > row["acctstarttime"]
            stale_interim = interim_seen and row["acctupdatetime"] < interim_cutoff
            dead_nas = (device or {}).get("tunnel_status") == "down" and last < dead_cutoff
            if not (stale_interim or dead_nas):
                continue
            row["acctstoptime"] = last
            row["acctterminatecause"] = "lost-service"
            self.rowcount += 1


class SweepDb:
    def __init__(self, cursor):
        self._cursor = cursor
        self.closed = False

    def cursor(self):
        return self

    def __enter__(self):
        return self._cursor

    def __exit__(self, *exc):
        return False

    def close(self):
        self.closed = True


def sweep(radacct, devices):
    cursor = SweepCursor(radacct, devices)
    radius_server.sweep_stale_sessions(lambda: SweepDb(cursor))
    return radacct


def is_open(row):
    return row["acctstoptime"] is None


class RadiusSweepTest(unittest.TestCase):
    def test_live_session_with_interim_updates_stays_open(self):
        # Interim updates are arriving — acctupdatetime is fresh. Never close.
        row = radacct_row(acctupdatetime=NOW - timedelta(minutes=2))
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "down"}])
        self.assertTrue(is_open(row))

    def test_silent_session_after_interim_updates_is_closed(self):
        # Interim updates flowed, then stopped 30 min ago — NAS went silent.
        row = radacct_row(acctupdatetime=NOW - timedelta(minutes=30))
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "up"}])
        self.assertFalse(is_open(row))
        self.assertEqual(row["acctstoptime"], NOW - timedelta(minutes=30))
        self.assertEqual(row["acctterminatecause"], "lost-service")

    def test_old_session_without_interim_on_healthy_nas_stays_open(self):
        # acctupdatetime never advanced: interim updates likely disabled on a
        # reachable router. The client may still be surfing — do not drop it.
        row = radacct_row()
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "up"}])
        self.assertTrue(is_open(row))

    def test_old_session_without_interim_on_down_nas_is_closed(self):
        # Tunnel confirmed down for a long time — the router is dead. The
        # dead-NAS threshold is higher than the interim one so a flap cannot
        # reap sessions that are still surfing.
        row = radacct_row(acctstarttime=NOW - timedelta(minutes=60))
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "down"}])
        self.assertFalse(is_open(row))
        self.assertEqual(row["acctstoptime"], row["acctstarttime"])

    def test_no_interim_session_on_recently_down_nas_stays_open(self):
        # Same session but only 40 min old — under the dead-NAS threshold a
        # tunnel flap must not close rows for clients that may still surf.
        row = radacct_row()
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "down"}])
        self.assertTrue(is_open(row))

    def test_fresh_session_on_down_nas_stays_open(self):
        # Started 2 minutes ago — the first interim update has not had time to
        # arrive yet. Too early to call it stale even with the tunnel down.
        row = radacct_row(acctstarttime=NOW - timedelta(minutes=2))
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "down"}])
        self.assertTrue(is_open(row))

    def test_stale_session_on_unknown_nas_stays_open(self):
        # NAS is not a managed device — no way to confirm it died.
        row = radacct_row(nasipaddress="192.0.2.99")
        sweep([row], [])
        self.assertTrue(is_open(row))

    def test_already_closed_rows_are_untouched(self):
        stopped = NOW - timedelta(minutes=5)
        row = radacct_row(acctstoptime=stopped, acctterminatecause="user-request")
        sweep([row], [{"tunnel_ip": "10.88.0.10", "tunnel_status": "down"}])
        self.assertEqual(row["acctstoptime"], stopped)
        self.assertEqual(row["acctterminatecause"], "user-request")


if __name__ == "__main__":
    unittest.main()
