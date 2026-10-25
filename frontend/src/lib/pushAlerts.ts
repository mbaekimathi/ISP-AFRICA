export type PushState = "checking" | "unsupported" | "denied" | "off" | "on";

export function vapidBytes(value: string) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export async function subscribePush(registration: ServiceWorkerRegistration, publicKey: string) {
  const options = { userVisibleOnly: true, applicationServerKey: vapidBytes(publicKey) };
  try {
    return (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe(options));
  } catch {
    // A stale subscription or an inactive worker can wedge the browser's push
    // channel — clear it, refresh the worker, and retry once.
    const stale = await registration.pushManager.getSubscription();
    if (stale) await stale.unsubscribe().catch(() => {});
    await registration.update().catch(() => {});
    await navigator.serviceWorker.ready;
    return registration.pushManager.subscribe(options);
  }
}

export function playChime(context: AudioContext | null) {
  if (!context) return;
  [0, 0.18].forEach((offset, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = index === 0 ? 880 : 1174.66;
    gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, context.currentTime + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.16);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + offset + 0.2);
  });
}
