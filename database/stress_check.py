"""Local stress harness — measures latency/throughput of the running service.

Usage:  python stress_check.py [quick|full]

Only hits public, read-only endpoints. Each request uses a fresh TCP
connection (worst case). X-Forwarded-For is varied so per-IP rate limits do
not collapse the measurement into 429s on builds that enforce them.
"""

import http.client
import statistics
import sys
import threading
import time

API = ("127.0.0.1", 8765)
PORTAL = ("127.0.0.1", 8790)


def timed_request(addr, method, path, xff=None, body=None, headers=None, timeout=15):
    conn = http.client.HTTPConnection(addr[0], addr[1], timeout=timeout)
    started = time.perf_counter()
    try:
        all_headers = dict(headers or {})
        if xff:
            all_headers["X-Forwarded-For"] = xff
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        response.read()
        return time.perf_counter() - started, response.status
    except Exception:
        return time.perf_counter() - started, -1
    finally:
        conn.close()


def run(name, addr, method, path, workers, total, vary_xff=True, body=None):
    results = []
    lock = threading.Lock()
    counter = [0]

    def work():
        while True:
            with lock:
                index = counter[0]
                counter[0] += 1
            if index >= total:
                return
            xff = f"10.99.{index % 240}.{1 + index // 240}" if vary_xff else None
            results.append(timed_request(addr, method, path, xff=xff, body=body))

    threads = [threading.Thread(target=work, daemon=True) for _ in range(workers)]
    wall_start = time.perf_counter()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.perf_counter() - wall_start

    lat = sorted(item[0] * 1000 for item in results)
    statuses = {}
    for _ms, status in results:
        statuses[status] = statuses.get(status, 0) + 1
    if not lat:
        print(f"{name}: NO RESULTS")
        return

    def pct(fraction):
        return lat[min(len(lat) - 1, int(len(lat) * fraction))]

    errors = sum(count for status, count in statuses.items() if status < 0 or status >= 500)
    print(
        f"{name:<28} n={len(results):>4} rps={len(results) / wall:>6.0f} "
        f"p50={pct(0.5):>6.1f} p95={pct(0.95):>6.1f} p99={pct(0.99):>7.1f} "
        f"max={lat[-1]:>7.1f} 5xx/err={errors} status={statuses}"
    )
    return results


def burst(name, addr, method, path, workers, total):
    """Same source IP — exercises the real per-IP rate limit / lockout path."""
    return run(name, addr, method, path, workers, total, vary_xff=False)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "quick"
    print(f"== warm-up ==")
    run("health x8", API, "GET", "/api/health", 8, 40)
    print(f"== concurrency sweep (fresh TCP + DB connect per request) ==")
    for workers, total in ((1, 30), (10, 200), (30, 600), (60, 900), (100, 1200)):
        run(f"health c={workers}", API, "GET", "/api/health", workers, total)
    print(f"== static file (no DB) ==")
    run("static / c=30", API, "GET", "/", 30, 400)
    print(f"== unauthenticated api (no DB query) ==")
    run("session c=30", API, "GET", "/api/client/session", 30, 400)
    if mode == "full":
        print(f"== login attempt path (PBKDF2 cost) ==")
        body = b'{"loginCode":"999999","password":"stress-test-wrong"}'
        run("login c=10", API, "POST", "/api/client/login", 10, 60, body=body)
        print(f"== portal ==")
        run("portal / c=30", PORTAL, "GET", "/", 30, 300)
    print("done")


if __name__ == "__main__":
    main()
