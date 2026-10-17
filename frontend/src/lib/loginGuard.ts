const GUARD_KEY = "isp-centric-login-guard";
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

type GuardEntry = {
  failures: number;
  lockedUntil: number;
};

type Portal = "client" | "employee";

function storageKey(portal: Portal, loginCode: string) {
  return `${portal}:${loginCode.trim()}`;
}

function readGuard(): Record<string, GuardEntry> {
  try {
    const raw = localStorage.getItem(GUARD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, GuardEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGuard(guard: Record<string, GuardEntry>) {
  try {
    localStorage.setItem(GUARD_KEY, JSON.stringify(guard));
  } catch {
    // A blocked store should not turn into an open sign-in path.
  }
}

export function assertLoginAllowed(portal: Portal, loginCode: string) {
  const entry = readGuard()[storageKey(portal, loginCode)];
  if (!entry || entry.lockedUntil <= Date.now()) return;
  const minutes = Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 60000));
  throw new Error(`Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
}

export function recordLoginFailure(portal: Portal, loginCode: string) {
  const guard = readGuard();
  const key = storageKey(portal, loginCode);
  const current = guard[key] ?? { failures: 0, lockedUntil: 0 };
  const failures = current.failures + 1;
  guard[key] = failures >= MAX_FAILURES
    ? { failures: 0, lockedUntil: Date.now() + LOCK_MS }
    : { failures, lockedUntil: 0 };
  writeGuard(guard);
}

export function clearLoginFailures(portal: Portal, loginCode: string) {
  const guard = readGuard();
  delete guard[storageKey(portal, loginCode)];
  writeGuard(guard);
}
