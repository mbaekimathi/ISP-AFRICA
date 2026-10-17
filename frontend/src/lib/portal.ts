export type Portal = "client" | "employee";

const storageKey = "isp-active-account";

export function rememberPortal(portal: Portal) {
  sessionStorage.setItem(storageKey, portal);
  window.dispatchEvent(new CustomEvent<Portal>("isp-active-account", { detail: portal }));
}

export function clearActivePortal() {
  sessionStorage.removeItem(storageKey);
  window.dispatchEvent(new CustomEvent("isp-active-account", { detail: "signed-out" }));
}

export function activePortal(): Portal | null {
  const value = sessionStorage.getItem(storageKey);
  return value === "client" || value === "employee" ? value : null;
}
