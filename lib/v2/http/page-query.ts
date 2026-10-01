import { InvalidPageQueryError } from "../repositories/page-errors.ts";

function only(params: URLSearchParams, keys: readonly string[]) {
  if (params.toString().length > 4096) throw new InvalidPageQueryError();
  for (const key of params.keys()) {
    if (!keys.includes(key) || params.getAll(key).length !== 1) throw new InvalidPageQueryError();
  }
}

function integer(params: URLSearchParams, key: string, fallback: number, min: number, max: number) {
  const value = params.get(key);
  if (value === null) return fallback;
  if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) throw new InvalidPageQueryError();
  return Number(value);
}

export function collectionPageQuery(params: URLSearchParams) {
  only(params, ["cursor", "limit"]);
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && (!cursor.length || cursor.length > 2048)) throw new InvalidPageQueryError();
  return { cursor, limit: integer(params, "limit", 50, 1, 100) };
}

export function wishlistPageQuery(params: URLSearchParams) {
  only(params, ["offset", "limit"]);
  return { offset: integer(params, "offset", 0, 0, 100_000), limit: integer(params, "limit", 24, 1, 24) };
}

export function noPageQuery(params: URLSearchParams) { only(params, []); }
