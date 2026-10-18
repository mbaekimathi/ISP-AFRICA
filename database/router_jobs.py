"""Database-backed router jobs.

Redis, Celery, and a live RouterOS connection are not required.
The API records a job and returns it immediately. A worker in this
process claims queued rows from MySQL through PyMySQL.

Environment:
  ISP_ROUTER_CONCURRENCY          parallel router jobs, default 2
  ISP_ROUTER_JOB_TIMEOUT_SECONDS  wait limit for one attempt, default 8
  ISP_ROUTER_POLL_SECONDS         worker idle wait, default 1
  ISP_JOB_RATE_PER_MINUTE         job creates per signed-in client, default 30

Read-only discovery does not open a management connection and does not
change router configuration. A timed-out read-only attempt may be queued
again with exponential backoff. Configuration jobs are refused, so a retry
cannot repeat a change.
"""

import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout

READ_ONLY = {"discover"}
SWITCH = {"switch-uplink"}
ACTIVE = ("queued", "running")
TERMINAL = {"succeeded", "failed", "timed_out"}
RATE_HITS = {}
RATE_LOCK = threading.Lock()


class JobError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def concurrency():
    return max(1, int(os.environ.get("ISP_ROUTER_CONCURRENCY", "2")))


def job_timeout():
    return max(1, int(os.environ.get("ISP_ROUTER_JOB_TIMEOUT_SECONDS", "8")))


def poll_seconds():
    return max(0.2, float(os.environ.get("ISP_ROUTER_POLL_SECONDS", "1")))


def allow_job(client_id, now=None):
    now = time.monotonic() if now is None else now
    limit = max(1, int(os.environ.get("ISP_JOB_RATE_PER_MINUTE", "30")))
    with RATE_LOCK:
        if len(RATE_HITS) > 20000:
            for key, hits in list(RATE_HITS.items()):
                recent = [stamp for stamp in hits if now - stamp < 60]
                if recent:
                    RATE_HITS[key] = recent
                else:
                    del RATE_HITS[key]
        recent = [stamp for stamp in RATE_HITS.get(client_id, []) if now - stamp < 60]
        if len(recent) >= limit:
            RATE_HITS[client_id] = recent
            return False
        recent.append(now)
        RATE_HITS[client_id] = recent
        return True


def ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS isp_router_jobs (
          id CHAR(36) NOT NULL PRIMARY KEY,
          client_id CHAR(36) NOT NULL,
          device_id CHAR(36) NOT NULL,
          operation VARCHAR(40) NOT NULL,
          status ENUM('queued', 'running', 'succeeded', 'failed', 'timed_out') NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          max_attempts INT NOT NULL DEFAULT 1,
          error_message VARCHAR(240) NULL,
          result_text TEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME NULL,
          finished_at DATETIME NULL,
          run_after DATETIME NULL,
          KEY idx_router_jobs_claim (status, run_after, created_at),
          KEY idx_router_jobs_owner (client_id, device_id, operation, status)
        )
        """
    )
    cursor.execute("SHOW COLUMNS FROM isp_router_jobs LIKE 'request_text'")
    if cursor.fetchone() is None:
        cursor.execute("ALTER TABLE isp_router_jobs ADD COLUMN request_text TEXT NULL")


def discover_result(device):
    version = device.get("routeros_version") or ""
    capabilities = []
    if version == "7":
        capabilities.append("wireguard")
    elif version == "6":
        capabilities.append("routeros6")
    return {
        "checked": False,
        "message": "No private management path is configured, so this router was not contacted.",
        "identity": device.get("name"),
        "model": None,
        "routerosVersion": version or None,
        "capabilities": capabilities,
        "vpnStatus": device.get("tunnel_status") or "unknown",
        "lastSuccessfulCheck": None,
    }


def classify_retry(operation, outcome, attempts, max_attempts):
    if operation not in READ_ONLY:
        return outcome, None
    if outcome != "timed_out" or attempts >= max_attempts:
        return outcome, None
    return "queued", min(60, 2 ** attempts)


def public_job(row):
    result = None
    if row.get("result_text"):
        result = json.loads(row["result_text"])
    return {
        "id": row["id"],
        "deviceId": row["device_id"],
        "operation": row["operation"],
        "status": row["status"],
        "attempts": row["attempts"],
        "error": row.get("error_message"),
        "result": result,
        "createdAt": stamp(row.get("created_at")),
        "startedAt": stamp(row.get("started_at")),
        "finishedAt": stamp(row.get("finished_at")),
    }


def stamp(value):
    if value is None:
        return None
    return value.isoformat(sep=" ") if hasattr(value, "isoformat") else str(value)


def enqueue(cursor, client_id, device_id, operation, request_text=None):
    if operation not in READ_ONLY and operation not in SWITCH:
        raise JobError(403, "Router configuration changes stay closed. Discovery is read-only.")
    cursor.execute(
        """
        SELECT * FROM isp_router_jobs
        WHERE client_id = %s AND device_id = %s AND operation = %s AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (client_id, device_id, operation),
    )
    existing = cursor.fetchone()
    if existing:
        return public_job(existing), False
    job_id = str(uuid.uuid4())
    attempts = 1 if operation in SWITCH else 3
    cursor.execute(
        """
        INSERT INTO isp_router_jobs (id, client_id, device_id, operation, status, max_attempts, request_text)
        VALUES (%s, %s, %s, %s, 'queued', %s, %s)
        """,
        (job_id, client_id, device_id, operation, attempts, request_text),
    )
    cursor.execute("SELECT * FROM isp_router_jobs WHERE id = %s", (job_id,))
    return public_job(cursor.fetchone()), True


def read_job(cursor, client_id, job_id):
    cursor.execute(
        "SELECT * FROM isp_router_jobs WHERE id = %s AND client_id = %s",
        (job_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        raise JobError(404, "That job was not found.")
    return public_job(row)


def cancel(cursor, client_id, job_id):
    cursor.execute(
        "SELECT * FROM isp_router_jobs WHERE id = %s AND client_id = %s",
        (job_id, client_id),
    )
    row = cursor.fetchone()
    if not row:
        raise JobError(404, "That job was not found.")
    if row["operation"] != "switch-uplink":
        raise JobError(403, "Only a queued uplink switch can be cancelled.")
    if row["status"] != "queued":
        raise JobError(409, "This switch has already started, so it can no longer be cancelled.")
    cursor.execute(
        """
        UPDATE isp_router_jobs
        SET status = 'failed', error_message = 'The administrator cancelled this switch before it started.', finished_at = CURRENT_TIMESTAMP
        WHERE id = %s AND status = 'queued'
        """,
        (job_id,),
    )
    cursor.execute("SELECT * FROM isp_router_jobs WHERE id = %s", (job_id,))
    return public_job(cursor.fetchone())


def claim_next(cursor):
    cursor.execute("START TRANSACTION")
    cursor.execute(
        """
        SELECT * FROM isp_router_jobs
        WHERE status = 'queued' AND (run_after IS NULL OR run_after <= CURRENT_TIMESTAMP)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE
        """
    )
    row = cursor.fetchone()
    if not row:
        cursor.execute("COMMIT")
        return None
    cursor.execute(
        """
        UPDATE isp_router_jobs
        SET status = 'running', attempts = attempts + 1, started_at = CURRENT_TIMESTAMP, finished_at = NULL, error_message = NULL
        WHERE id = %s
        """,
        (row["id"],),
    )
    cursor.execute("COMMIT")
    row["attempts"] = row["attempts"] + 1
    row["status"] = "running"
    return row


def finish_job(cursor, row, outcome, message, result):
    status, delay = classify_retry(row["operation"], outcome, row["attempts"], row["max_attempts"])
    stored = (message or "")[:240]
    cursor.execute(
        """
        UPDATE isp_router_jobs
        SET status = %s,
            error_message = %s,
            result_text = %s,
            finished_at = IF(%s = 'queued', NULL, CURRENT_TIMESTAMP),
            run_after = IF(%s = 'queued', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL %s SECOND), NULL)
        WHERE id = %s
        """,
        (status, stored, json.dumps(result) if result is not None else None, status, status, delay or 0, row["id"]),
    )
    return status


def execute_claimed(row, device, writer=None):
    if row["operation"] == "switch-uplink":
        import wan_switch

        request = json.loads(row.get("request_text") or "{}")
        return wan_switch.execute(request, device, writer or wan_switch.unavailable_writer)
    if row["operation"] != "discover":
        return "failed", "That router operation is not available.", None
    if device is None:
        return "failed", "That router was not found.", None
    result = discover_result(device)
    return "failed", result["message"], result


def process_once(connect):
    db = connect()
    row = None
    try:
        db.autocommit(False)
        with db.cursor() as cursor:
            row = claim_next(cursor)
        if row is None:
            return None
        with db.cursor() as cursor:
            cursor.execute(
                "SELECT id, name, routeros_version, tunnel_status, tunnel_ip, api_secret FROM isp_mikrotik_devices WHERE id = %s AND client_id = %s",
                (row["device_id"], row["client_id"]),
            )
            device = cursor.fetchone()
        outcome, message, result = run_with_timeout(lambda: execute_claimed(row, device, uplink_writer(device)))
        with db.cursor() as cursor:
            if outcome == "succeeded" and isinstance(result, dict) and result.get("commitActive"):
                cursor.execute(
                    "UPDATE isp_wan_uplinks SET active = CASE WHEN interface_name = %s THEN 1 ELSE 0 END WHERE client_id = %s AND device_id = %s",
                    (result.get("target"), row["client_id"], row["device_id"]),
                )
            if row["operation"] == "switch-uplink" and isinstance(result, dict):
                cursor.execute(
                    """
                    INSERT INTO isp_wan_audit (
                      id, client_id, device_id, job_id, previous_uplink, requested_uplink, outcome, detail_text
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(uuid.uuid4()),
                        row["client_id"],
                        row["device_id"],
                        row["id"],
                        (result.get("source") or "")[:32],
                        (result.get("target") or "")[:32],
                        outcome,
                        json.dumps(
                            {
                                "warning": result.get("warning"),
                                "impact": result.get("impact"),
                                "changes": result.get("changes"),
                                "verification": result.get("verification"),
                                "needsManualRecovery": result.get("needsManualRecovery"),
                            }
                        ),
                    ),
                )
            status = finish_job(cursor, row, outcome, message, result)
        db.commit()
        log_job(row["id"], row["operation"], status, message)
        return row["id"]
    except Exception:
        db.rollback()
        if row is not None:
            release_running(connect, row["id"])
        log_job(row["id"] if row else None, "worker", "failed", "A queued router job could not be updated.")
        return None
    finally:
        db.close()


def release_running(connect, job_id):
    db = connect()
    try:
        with db.cursor() as cursor:
            cursor.execute(
                """
                UPDATE isp_router_jobs
                SET status = 'failed', error_message = 'The router check failed.', finished_at = CURRENT_TIMESTAMP
                WHERE id = %s AND status = 'running'
                """,
                (job_id,),
            )
        db.commit()
    finally:
        db.close()


def run_with_timeout(work):
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(work)
    try:
        return future.result(timeout=job_timeout())
    except FuturesTimeout:
        return "timed_out", "The router check exceeded its time limit.", None
    except Exception:
        return "failed", "The router check failed.", None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def log_job(job_id, operation, status, message):
    print(f"event=job id={job_id or '-'} operation={operation} status={status} detail={message}", flush=True)


def uplink_writer(device):
    import routeros_api
    import wan_switch

    def writer(commands):
        if not device or not device.get("api_secret") or not device.get("tunnel_ip"):
            return wan_switch.unavailable_writer(commands)
        try:
            password = routeros_api.open_password(device["api_secret"])
            return routeros_api.apply_uplink_plan(device["tunnel_ip"], password, commands)
        except routeros_api.RouterError:
            return wan_switch.unavailable_writer(commands)

    return writer


def worker_loop(connect, stop):
    while not stop.is_set():
        worked = False
        for _ in range(concurrency()):
            job_id = process_once(connect)
            worked = worked or bool(job_id)
        if not worked:
            stop.wait(poll_seconds())


def release_stale_running(connect):
    """A restart strands jobs that were 'running' when the process died; the
    worker only claims 'queued' rows so they would sit forever. Close them as
    timed_out instead of re-running — re-executing a half-applied change such
    as an uplink switch could flap a live router."""
    db = connect()
    try:
        with db.cursor() as cursor:
            cursor.execute(
                """
                UPDATE isp_router_jobs
                SET status = 'timed_out',
                    error_message = 'The service restarted while this job was running.',
                    finished_at = CURRENT_TIMESTAMP
                WHERE status = 'running'
                """
            )
            if cursor.rowcount:
                print(f"event=router-jobs stale-running={cursor.rowcount} status=timed_out", flush=True)
        db.commit()
    except Exception as error:
        print(f"event=router-jobs stale-running error={error}", flush=True)
    finally:
        db.close()


def start_worker(connect):
    release_stale_running(connect)
    stop = threading.Event()
    for index in range(concurrency()):
        thread = threading.Thread(
            target=worker_loop,
            args=(connect, stop),
            name=f"router-jobs-{index}",
            daemon=True,
        )
        thread.start()
    return stop
