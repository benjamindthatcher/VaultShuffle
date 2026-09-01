import "server-only";
import { createHash } from "node:crypto";
import { getCache } from "@vercel/functions";
import type { SnapshotCache } from "./steam-library-snapshot";

export function steamSetupCache(): SnapshotCache {
  const cache = getCache({ namespace: "steam-setup-v1", keyHashFunction: (key) => createHash("sha256").update(key).digest("hex") });
  // Cache trouble must not consume the whole sign-in function deadline.
  async function bounded<T>(work: Promise<T>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Setup cache timeout.")), 1500); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  return { get: (key) => bounded(cache.get(key)), set: (key, value, options) => bounded(cache.set(key, value, options)), delete: (key) => bounded(cache.delete(key)) };
}
