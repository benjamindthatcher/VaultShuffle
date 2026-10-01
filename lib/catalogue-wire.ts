/** Lossless public-catalogue transport: shared field names, defaults and tag labels. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, JsonValue>;
export type CompactCatalogue = {
  format: "compact-v1";
  columns: string[];
  defaults: Row;
  labels: string[];
  rows: JsonValue[][];
  missing?: [number, number][];
};
export type CataloguePayload<T> = CompactCatalogue | { games?: T[] };
const TAG_FIELDS = new Set(["tags", "steam_tags"]);
const LABEL_FIELDS = new Set(["genres", "steam_categories"]);

export function encodeCatalogue<T extends object>(games: readonly T[]): CompactCatalogue {
  // Match JSON transport semantics (in particular, omitted undefined properties).
  const records = games.map(game => JSON.parse(JSON.stringify(game)) as Row);
  const keys = [...new Set(records.flatMap(game => Object.keys(game)))];
  const defaults: Row = {};
  const columns: string[] = [];
  for (const key of keys) {
    const first = JSON.stringify(records[0][key]);
    if (records.every(game => Object.hasOwn(game, key) && JSON.stringify(game[key]) === first)) {
      Object.defineProperty(defaults, key, { value: records[0][key], enumerable: true });
    } else columns.push(key);
  }
  const labels: string[] = [];
  const ids = new Map<string, number>();
  function labelId(label: string) {
    let id = ids.get(label);
    if (id === undefined) { id = labels.length; ids.set(label, id); labels.push(label); }
    return id;
  }
  const missing: [number, number][] = [];
  const rows = records.map((game, row) => columns.map((key, column) => {
    if (!Object.hasOwn(game, key)) { missing.push([row, column]); return null; }
    const value = game[key];
    if (TAG_FIELDS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([label, weight]) => [labelId(label), weight]);
    }
    if (LABEL_FIELDS.has(key) && Array.isArray(value)) return value.map(label => labelId(String(label)));
    return value;
  }));
  return { format: "compact-v1", columns, defaults, labels, rows, ...(missing.length ? { missing } : {}) };
}

export function decodeCatalogue<T extends object>(payload: CataloguePayload<T>): T[] {
  // Old responses remain valid for cached pages and existing consumers.
  if ("games" in payload && Array.isArray(payload.games)) return payload.games;
  if (!("format" in payload) || payload.format !== "compact-v1") throw new Error("Unknown catalogue format.");
  const { columns, defaults, labels, rows, missing = [] } = payload;
  function label(id: JsonValue): string {
    if (typeof id !== "number" || !Number.isInteger(id) || typeof labels[id] !== "string") throw new Error("Invalid catalogue label.");
    return labels[id];
  }
  const records = rows.map(row => {
    if (row.length !== columns.length) throw new Error("Invalid catalogue row.");
    const fields = columns.map((key, column) => {
      const value = row[column];
      if (TAG_FIELDS.has(key) && Array.isArray(value)) {
        if (value.length % 2) throw new Error("Invalid catalogue tags.");
        const entries: [string, JsonValue][] = [];
        for (let i = 0; i < value.length; i += 2) entries.push([label(value[i]), value[i + 1]]);
        return [key, Object.fromEntries(entries)];
      }
      if (LABEL_FIELDS.has(key) && Array.isArray(value)) return [key, value.map(label)];
      return [key, value];
    });
    return { ...JSON.parse(JSON.stringify(defaults)), ...Object.fromEntries(fields) } as Row;
  });
  for (const [row, column] of missing) {
    if (!records[row] || columns[column] === undefined) throw new Error("Invalid catalogue missing field.");
    delete records[row][columns[column]];
  }
  return records as T[];
}
