const changed = "staff-recovery-retry-changed";
export const subscribeRecoveryRetry = (notify: () => void) => {
  window.addEventListener(changed, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", notify);
  };
};
export function readRecoveryRetry(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return "unavailable";
  }
}
export function writeRecoveryRetry(key: string, value: object | null) {
  if (value) sessionStorage.setItem(key, JSON.stringify(value));
  else sessionStorage.removeItem(key);
  window.dispatchEvent(new Event(changed));
}
export async function recoveryDigest(body: Record<string, string>) {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.keys(body)
        .sort()
        .map((key) => [key, body[key]]),
    ),
  );
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(hash), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
