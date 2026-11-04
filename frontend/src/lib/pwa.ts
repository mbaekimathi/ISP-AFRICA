/* PWA plumbing: registers the service worker, applies updates the moment a
   new build activates (controllerchange → one reload), and exposes the
   browser's install prompt to the UI. */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type PwaSnapshot = {
  canInstall: boolean;
  installed: boolean;
  ios: boolean;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = detectInstalled();
let registered = false;
const listeners = new Set<() => void>();

function detectInstalled() {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// useSyncExternalStore compares snapshots by identity — return one stable
// object and only replace it inside emit(), or React re-renders forever.
let current: PwaSnapshot = { canInstall: false, installed, ios: typeof navigator === "undefined" ? false : isIos() };

function emit() {
  current = { canInstall: deferredPrompt !== null, installed, ios: isIos() };
  listeners.forEach((listener) => listener());
}

export function subscribePwa(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPwa(): PwaSnapshot {
  return current;
}

export async function installPwa(): Promise<boolean> {
  if (!deferredPrompt) return false;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  emit();
  return choice.outcome === "accepted";
}

export function registerPwa() {
  if (registered || !("serviceWorker" in navigator)) return;
  registered = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });

  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    emit();
  });

  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // A new worker took over: a fresh deploy just activated. Reload once so
    // the page runs the new bundle — but never on the very first install.
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register("/push-sw.js")
    .then((registration) => {
      registration.update().catch(() => {});
      window.setInterval(() => registration.update().catch(() => {}), 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") registration.update().catch(() => {});
      });
    })
    .catch(() => {});
}
