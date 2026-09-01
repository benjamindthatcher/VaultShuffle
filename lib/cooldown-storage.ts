import { CooldownError } from "./cooldown.ts";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SavedCooldown = { until: number; code: "rate_limited" | "steam_rate_limited" };
const prefix = "vault-steam-cooldown:";
export function readStoredCooldown(scope: string, storage?: StorageLike, now = Date.now()): SavedCooldown | null {
  try {
    const store = storage ?? window.sessionStorage;
    const item = JSON.parse(store.getItem(prefix + scope) ?? "null") as SavedCooldown | null;
    if (!item || !Number.isFinite(item.until) || item.until <= now || item.until > now + 86400_000
      || !["rate_limited", "steam_rate_limited"].includes(item.code)) { store.removeItem(prefix + scope); return null; }
    return item;
  } catch { return null; }
}
export function saveCooldown(scope: string, error: CooldownError, storage?: StorageLike, now = Date.now()) {
  const until = now + Math.min(86400, Math.max(1, error.retryAfterSeconds)) * 1000;
  try { (storage ?? window.sessionStorage).setItem(prefix + scope, JSON.stringify({ until, code: error.code })); } catch { /* Storage can be blocked. */ }
  return until;
}
export function storedCooldownError(saved: SavedCooldown, now = Date.now()) {
  return new CooldownError(Math.max(1, Math.ceil((saved.until - now) / 1000)), "Please give Steam a moment before trying again. Your profile has not been rejected.", saved.code);
}
