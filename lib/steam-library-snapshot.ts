import type { GamePayload } from "./types.ts";
import { diagnosticId } from "./diagnostics.ts";

// Temporary handoff, not an ownership credential. The random ID is included in
// the signed lookup token; every read also checks the verified token's Steam ID.
export const SNAPSHOT_TTL_SECONDS = 15 * 60;
const CHUNK_SIZE = 500;
export type SnapshotCache = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options: { ttl: number; name: string }) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};
type Manifest = { version: 1; steamId: string; count: number; chunks: number; expiresAt: number };
const keyFor = (id: string) => `steam-setup-v1:${id}`;

export async function saveLibrarySnapshot(cache: SnapshotCache, steamId: string, games: GamePayload[], now = Date.now()) {
  const id = crypto.randomUUID();
  const options = { ttl: SNAPSHOT_TTL_SECONDS, name: "Steam setup handoff" };
  const chunks = Math.ceil(games.length / CHUNK_SIZE);
  if (!games.length || chunks > 100) throw new Error("Library snapshot size unsupported.");
  // Bounded groups avoid a burst when importing a very large library.
  for (let i = 0; i < chunks; i += 4) {
    await Promise.all(Array.from({ length: Math.min(4, chunks - i) }, (_, offset) => {
      const part = i + offset;
      return cache.set(`${keyFor(id)}:${part}`, games.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE), options);
    }));
  }
  // Published last: partial writes can never be mistaken for a complete library.
  await cache.set(keyFor(id), { version: 1, steamId, count: games.length, chunks, expiresAt: now + SNAPSHOT_TTL_SECONDS * 1000 } satisfies Manifest, options);
  return id;
}

export async function readLibrarySnapshot(cache: SnapshotCache, id: string | undefined, steamId: string, now = Date.now()): Promise<GamePayload[] | null> {
  if (!diagnosticId(id)) return null;
  const manifest = await cache.get(keyFor(id!)) as Manifest | undefined;
  if (!manifest || manifest.version !== 1 || manifest.steamId !== steamId || manifest.expiresAt <= now
    || !Number.isInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > 100) return null;
  const games: GamePayload[] = [];
  for (let i = 0; i < manifest.chunks; i += 4) {
    const parts = await Promise.all(Array.from({ length: Math.min(4, manifest.chunks - i) }, (_, offset) => cache.get(`${keyFor(id!)}:${i + offset}`)));
    if (parts.some((part) => !Array.isArray(part))) return null;
    for (const part of parts) games.push(...part as GamePayload[]);
  }
  return games.length === manifest.count ? games : null;
}

export async function deleteLibrarySnapshot(cache: SnapshotCache, id: string, count: number) {
  if (!diagnosticId(id)) return;
  await cache.delete(keyFor(id));
  for (let i = 0; i < Math.min(100, Math.ceil(count / CHUNK_SIZE)); i += 1) await cache.delete(`${keyFor(id)}:${i}`);
}
