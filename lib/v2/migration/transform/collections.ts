import {
  compareNullableBigint,
  compareNumber,
  compareTimestamp,
  compareUuid,
  freezeArray,
  integerText,
  jsonSizeAdvisory,
  m3AccountMap,
  m3Cell,
  m3CheckRowIdentity,
  m3ConflictCollector,
  m3Failure,
  m3Integer,
  m3JsonDocument,
  m3LibraryRowMap,
  m3LookupAccount,
  m3NullableCell,
  m3NullableText,
  m3Object,
  m3OptionalCell,
  m3RunIdentity,
  m3Rows,
  m3Timestamp,
  m3Uuid,
  m3BtrimBoundedText,
  sameTenant,
  STAGING_RETENTION_CLASS,
  TARGET_BIGINT_MAX,
  TARGET_INTEGER_MAX,
  type ConflictRecord,
  type JsonSizeAdvisory,
  type CollectionMapRecord,
  type LibraryRowMapRecord,
  type M3GCell,
  type M3GRunIdentity,
  type M3GSourceRunTag,
  type PgTimestamp,
} from "./commitments-shared.ts";

/**
 * `public.collections` and `public.collection_games`.
 *
 * Two properties drive everything in this module.
 *
 * The first is that a collection UUID is browser-visible, so it is retained
 * verbatim in `app.collections.public_id` and the bigint identity is minted
 * beside it.  The identity is assigned from a deterministic order *before* any
 * child is resolved, so the same input produces the same numbering however the
 * input rows were shuffled.
 *
 * The second is coordinator ruling 9.  Position GAPS are legal under the new
 * `unique (account_id, collection_id, position)` constraint and are carried
 * through unchanged; dense renumbering is withdrawn because it would destroy
 * real ordering evidence the constraint permits.  Only DUPLICATE positions are
 * resolved, by a stable deterministic order, and every member is retained with
 * its original position recorded in `legacy_position`, in `legacy_order` and in
 * the membership evidence archive.
 */

const COLLECTIONS = "collections";
const COLLECTION_GAMES = "collection_games";

const DEFAULT_MAX_COLLECTIONS = 5_000_000;
const DEFAULT_MAX_MEMBERS = 20_000_000;

/** `app.collections.name`: `length(btrim(name)) between 1 and 200` (M1:347). */
const MAX_NAME_BTRIM_LENGTH = 200;
/** `app.collections.description`: `length(description) <= 2000` (M1:348). */
const MAX_DESCRIPTION_LENGTH = 2000;
/** `app.collection_games.note`: `length(note) <= 10000` (M1:366). */
const MAX_NOTE_LENGTH = 10_000;
/** `pg_column_size(rules) <= 16384` (M1:357). Confirmed by SQL, not here. */
const RULES_PG_COLUMN_SIZE_BOUND = 16_384;
/** A hard character bound on the rules cell, four times the byte bound. */
const MAX_RULES_TEXT_LENGTH = 65_536;

export type CollectionKind = "custom" | "smart";
export type PositionResolution = "source" | "stable_reorder" | "conflict";

export type CollectionSourceRow = Readonly<{
  id: M3GCell;
  user_id: M3GCell;
  name: M3GCell;
  description: M3GCell;
  created_at: M3GCell;
  updated_at: M3GCell;
  kind: M3GCell;
  rules: M3GCell;
}> &
  M3GSourceRunTag;

export type CollectionMembershipSourceRow = Readonly<{
  collection_id: M3GCell;
  game_id: M3GCell;
  notes: M3GCell;
  position: M3GCell;
  created_at: M3GCell;
  /**
   * Optional recorded original-order evidence, exported alongside the row.
   *
   * The source relation has no ordering column beyond `position`, so this is
   * supplied only when the export captured one (a stable source ordinal). It
   * is evidence for the duplicate tie-break and is retained in
   * `app.collection_games.legacy_order`; it is never invented when absent.
   */
  source_order?: M3GCell;
}> &
  M3GSourceRunTag;

/** `app.collections`. Target columns only; `revision` keeps its default. */
export type CollectionRecord = Readonly<{
  id: number;
  public_id: string;
  account_id: number;
  collection_kind: CollectionKind;
  name: string;
  description: string | null;
  /** Opaque source JSONB text, cast by the loader and never re-serialised. */
  rules: string | null;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
}>;

/** `app.collection_games`, including the M3 preservation extension. */
export type CollectionGameRecord = Readonly<{
  account_id: number;
  collection_id: number;
  game_id: number;
  position: number;
  note: string | null;
  legacy_position: number;
  legacy_created_at: PgTimestamp;
  /** Exact bigint text, or null when the export supplied no order evidence. */
  legacy_order: string | null;
  position_resolution: PositionResolution;
}>;

/** `migration.legacy_collection_membership_evidence`. Staging, not durable. */
export type CollectionMembershipEvidenceRecord = Readonly<{
  account_id: number;
  source_collection_id: string;
  source_game_id: string;
  collection_id: number;
  source_position: number;
  source_created_at: PgTimestamp;
  source_notes: string | null;
  position_resolution: PositionResolution;
  conflict_group: string | null;
  source_snapshot_hash: string;
  retention_class: typeof STAGING_RETENTION_CLASS;
}>;

export type CollectionTransformInput = Readonly<{
  runIdentity: M3GRunIdentity;
  accountMap: unknown;
  libraryRowMap: readonly LibraryRowMapRecord[] | unknown;
  collections: readonly CollectionSourceRow[];
  collectionGames: readonly CollectionMembershipSourceRow[];
}>;

export type CollectionTransformOptions = Readonly<{
  maxCollections?: number;
  maxMembers?: number;
  /** First minted `app.collections.id`. Defaults to 1. */
  startCollectionId?: number;
}>;

export type CollectionTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  collections: readonly CollectionRecord[];
  collection_map: readonly CollectionMapRecord[];
  collection_games: readonly CollectionGameRecord[];
  membership_evidence: readonly CollectionMembershipEvidenceRecord[];
  size_advisories: readonly JsonSizeAdvisory[];
  conflicts: readonly ConflictRecord[];
}>;

type StagedCollection = Readonly<{
  publicId: string;
  canonicalId: string;
  accountId: number;
  kind: CollectionKind;
  name: string;
  description: string | null;
  rules: string | null;
  rulesBytes: number | null;
  createdAt: PgTimestamp;
  updatedAt: PgTimestamp;
}>;

type StagedMember = Readonly<{
  canonicalCollectionId: string;
  sourceCollectionId: string;
  sourceGameId: string;
  canonicalGameId: string;
  accountId: number;
  gameId: number;
  sourcePosition: number;
  legacyOrder: bigint | null;
  note: string | null;
  sourceNotes: string | null;
  createdAt: PgTimestamp;
}>;

function boundedOption(value: number | undefined, fallback: number, relation: string, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) m3Failure("m3g_input_invalid", relation, field);
  return value;
}

/**
 * Read `public.collections` and `public.collection_games` into their targets.
 *
 * Ownership is never consulted: a collection member is retained because the
 * user put it there, not because the library still reports the game as owned.
 * The only question asked of the library-row map is identity, and the only
 * question asked of the account is tenancy.
 */
export function transformCollections(
  input: CollectionTransformInput,
  options: CollectionTransformOptions = {},
): CollectionTransformResult {
  const root = m3Object(input, "collection_input");
  const run = m3RunIdentity(root.runIdentity);
  const maxCollections = boundedOption(options.maxCollections, DEFAULT_MAX_COLLECTIONS, COLLECTIONS, "maxCollections");
  const maxMembers = boundedOption(options.maxMembers, DEFAULT_MAX_MEMBERS, COLLECTION_GAMES, "maxMembers");
  const startCollectionId = boundedOption(options.startCollectionId, 1, COLLECTIONS, "startCollectionId");
  if (startCollectionId < 1) m3Failure("m3g_input_invalid", COLLECTIONS, "startCollectionId");

  const accountMap = m3AccountMap(root.accountMap, run);
  const libraryRowMap = m3LibraryRowMap(root.libraryRowMap, run);
  const conflicts = m3ConflictCollector();
  const advisories: JsonSizeAdvisory[] = [];

  const collectionRows = m3Rows(root.collections, COLLECTIONS, maxCollections);
  const staged: StagedCollection[] = [];
  const seenCollectionIds = new Set<string>();

  for (const raw of collectionRows) {
    const row = m3Object(raw, COLLECTIONS);
    m3CheckRowIdentity(row, run, COLLECTIONS);

    const publicId = m3Uuid(m3Cell(row, "id", COLLECTIONS), COLLECTIONS, "id");
    if (seenCollectionIds.has(publicId.canonical)) m3Failure("m3g_duplicate_identity", COLLECTIONS, "id");
    seenCollectionIds.add(publicId.canonical);

    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", COLLECTIONS), COLLECTIONS, "user_id");

    const kindText = m3Cell(row, "kind", COLLECTIONS);
    if (kindText !== "custom" && kindText !== "smart") m3Failure("m3g_invalid_enum", COLLECTIONS, "kind");
    const kind: CollectionKind = kindText;

    const name = m3BtrimBoundedText(m3Cell(row, "name", COLLECTIONS), COLLECTIONS, "name", MAX_NAME_BTRIM_LENGTH);
    const description = m3NullableText(
      m3NullableCell(row, "description", COLLECTIONS),
      COLLECTIONS,
      "description",
      MAX_DESCRIPTION_LENGTH,
      true,
    );

    const rulesCell = m3NullableCell(row, "rules", COLLECTIONS);
    let rules: string | null = null;
    let rulesBytes: number | null = null;
    if (rulesCell === null) {
      // The source column is NOT NULL and the target requires rules for a
      // smart collection, so a missing document is unloadable there and
      // merely reportable for a custom one.
      if (kind === "smart") m3Failure("m3g_smart_collection_without_rules", COLLECTIONS, "rules");
      conflicts.record({
        conflict_class: "collection_rules_missing",
        source_relation: COLLECTIONS,
        source_column: "rules",
        decision: "A custom collection with no rules document is loaded with NULL rules; the source column is NOT NULL, so the absence is reported.",
      });
    } else {
      const document = m3JsonDocument(rulesCell, COLLECTIONS, "rules", "object", MAX_RULES_TEXT_LENGTH);
      rules = document.sourceText;
      rulesBytes = document.utf8Bytes;
      if (document.utf8Bytes > RULES_PG_COLUMN_SIZE_BOUND) {
        advisories.push(
          jsonSizeAdvisory(
            "app.collections",
            "rules",
            publicId.original,
            document,
            RULES_PG_COLUMN_SIZE_BOUND,
            "M1:357 check (rules is null or pg_column_size(rules) <= 16384)",
          ),
        );
        conflicts.record({
          conflict_class: "collection_rules_size_advisory",
          source_relation: COLLECTIONS,
          source_column: "rules",
          decision:
            "The rules document exceeds the physical byte bound when measured as UTF-8 text. pg_column_size measures the stored jsonb datum, so the load gate decides; this transform reports and does not trim.",
          details: { pg_column_size_bound: RULES_PG_COLUMN_SIZE_BOUND, requires_sql_validation: true },
        });
      }
    }

    staged.push(
      Object.freeze({
        publicId: publicId.original,
        canonicalId: publicId.canonical,
        accountId,
        kind,
        name,
        description,
        rules,
        rulesBytes,
        createdAt: m3Timestamp(m3Cell(row, "created_at", COLLECTIONS), COLLECTIONS, "created_at"),
        updatedAt: m3Timestamp(m3Cell(row, "updated_at", COLLECTIONS), COLLECTIONS, "updated_at"),
      }),
    );
  }

  // Deterministic identity: account, then the creation instant, then the
  // canonical UUID. Shuffled input cannot change the numbering.
  staged.sort((left, right) => {
    if (left.accountId !== right.accountId) return compareNumber(left.accountId, right.accountId);
    const byCreated = compareTimestamp(left.createdAt, right.createdAt);
    if (byCreated !== 0) return byCreated;
    return compareUuid(left.canonicalId, right.canonicalId);
  });

  const collections: CollectionRecord[] = [];
  const collectionMap: CollectionMapRecord[] = [];
  const byCanonicalId = new Map<string, { id: number; accountId: number }>();

  staged.forEach((collection, index) => {
    const id = startCollectionId + index;
    if (!Number.isSafeInteger(id) || BigInt(id) > TARGET_BIGINT_MAX) {
      m3Failure("m3g_target_overflow", COLLECTIONS, "id");
    }
    collections.push(
      Object.freeze({
        id,
        public_id: collection.publicId,
        account_id: collection.accountId,
        collection_kind: collection.kind,
        name: collection.name,
        description: collection.description,
        rules: collection.rules,
        created_at: collection.createdAt,
        updated_at: collection.updatedAt,
      }),
    );
    collectionMap.push(
      Object.freeze({
        legacy_id: collection.publicId,
        account_id: collection.accountId,
        collection_id: id,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
    byCanonicalId.set(collection.canonicalId, { id, accountId: collection.accountId });
  });

  const memberRows = m3Rows(root.collectionGames, COLLECTION_GAMES, maxMembers);
  const members: StagedMember[] = [];
  const seenMembership = new Set<string>();

  for (const raw of memberRows) {
    const row = m3Object(raw, COLLECTION_GAMES);
    m3CheckRowIdentity(row, run, COLLECTION_GAMES);

    const sourceCollection = m3Uuid(m3Cell(row, "collection_id", COLLECTION_GAMES), COLLECTION_GAMES, "collection_id");
    const owner = byCanonicalId.get(sourceCollection.canonical);
    if (owner === undefined) m3Failure("m3g_collection_unmapped", COLLECTION_GAMES, "collection_id");

    const sourceGame = m3Uuid(m3Cell(row, "game_id", COLLECTION_GAMES), COLLECTION_GAMES, "game_id");
    const membershipKey = `${sourceCollection.canonical}/${sourceGame.canonical}`;
    if (seenMembership.has(membershipKey)) m3Failure("m3g_duplicate_identity", COLLECTION_GAMES, "game_id");
    seenMembership.add(membershipKey);

    const libraryRow = libraryRowMap.lookup(sourceGame.original);
    sameTenant(owner.accountId, libraryRow.account_id, COLLECTION_GAMES, "game_id");

    const sourcePosition = Number(
      m3Integer(m3Cell(row, "position", COLLECTION_GAMES), COLLECTION_GAMES, "position", BigInt(0), TARGET_INTEGER_MAX),
    );

    const orderCell = m3OptionalCell(row, "source_order", COLLECTION_GAMES);
    const legacyOrder =
      orderCell === null
        ? null
        : m3Integer(orderCell, COLLECTION_GAMES, "source_order", BigInt(0), TARGET_BIGINT_MAX);

    const sourceNotes = m3NullableCell(row, "notes", COLLECTION_GAMES);
    // Ruling 9: a nonempty note is never truncated. The target bounds it to
    // 10000 characters and the only other destination is 30-day staging, so an
    // over-length note has no durable home and is a reconciliation blocker.
    const note = m3NullableText(sourceNotes, COLLECTION_GAMES, "notes", MAX_NOTE_LENGTH, true);

    members.push(
      Object.freeze({
        canonicalCollectionId: sourceCollection.canonical,
        sourceCollectionId: sourceCollection.original,
        sourceGameId: sourceGame.original,
        canonicalGameId: sourceGame.canonical,
        accountId: owner.accountId,
        gameId: libraryRow.game_id,
        sourcePosition,
        legacyOrder,
        note,
        sourceNotes,
        createdAt: m3Timestamp(m3Cell(row, "created_at", COLLECTION_GAMES), COLLECTION_GAMES, "created_at"),
      }),
    );
  }

  const grouped = new Map<string, StagedMember[]>();
  for (const member of members) {
    const bucket = grouped.get(member.canonicalCollectionId);
    if (bucket === undefined) grouped.set(member.canonicalCollectionId, [member]);
    else bucket.push(member);
  }

  const collectionGames: CollectionGameRecord[] = [];
  const membershipEvidence: CollectionMembershipEvidenceRecord[] = [];

  for (const [canonicalCollectionId, bucket] of grouped) {
    const owner = byCanonicalId.get(canonicalCollectionId);
    if (owner === undefined) m3Failure("m3g_collection_unmapped", COLLECTION_GAMES, "collection_id");
    const resolved = resolveMemberPositions(bucket, conflicts);
    const claimedGames = new Set<number>();
    for (const entry of resolved) {
      if (claimedGames.has(entry.member.gameId)) {
        // Two distinct library UUIDs resolving to one catalogue game would
        // collapse two memberships onto one target primary key.
        m3Failure("m3g_duplicate_identity", COLLECTION_GAMES, "game_id");
      }
      claimedGames.add(entry.member.gameId);
      collectionGames.push(
        Object.freeze({
          account_id: owner.accountId,
          collection_id: owner.id,
          game_id: entry.member.gameId,
          position: entry.position,
          note: entry.member.note,
          legacy_position: entry.member.sourcePosition,
          legacy_created_at: entry.member.createdAt,
          legacy_order: entry.member.legacyOrder === null ? null : integerText(entry.member.legacyOrder),
          position_resolution: entry.resolution,
        }),
      );
      membershipEvidence.push(
        Object.freeze({
          account_id: owner.accountId,
          source_collection_id: entry.member.sourceCollectionId,
          source_game_id: entry.member.sourceGameId,
          collection_id: owner.id,
          source_position: entry.member.sourcePosition,
          source_created_at: entry.member.createdAt,
          source_notes: entry.member.sourceNotes,
          position_resolution: entry.resolution,
          conflict_group: entry.conflictGroup,
          source_snapshot_hash: run.snapshotHash,
          retention_class: STAGING_RETENTION_CLASS,
        }),
      );
    }
  }

  collectionGames.sort((left, right) => {
    if (left.collection_id !== right.collection_id) return compareNumber(left.collection_id, right.collection_id);
    return compareNumber(left.position, right.position);
  });
  membershipEvidence.sort((left, right) => {
    if (left.collection_id !== right.collection_id) return compareNumber(left.collection_id, right.collection_id);
    const byPosition = compareNumber(left.source_position, right.source_position);
    if (byPosition !== 0) return byPosition;
    return compareUuid(left.source_game_id.toLowerCase(), right.source_game_id.toLowerCase());
  });
  advisories.sort((left, right) => compareUuid(left.public_id.toLowerCase(), right.public_id.toLowerCase()));

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    collections: freezeArray(collections),
    collection_map: freezeArray(collectionMap),
    collection_games: freezeArray(collectionGames),
    membership_evidence: freezeArray(membershipEvidence),
    size_advisories: freezeArray(advisories),
    conflicts: conflicts.toRecords(),
  });
}

type ResolvedMember = Readonly<{
  member: StagedMember;
  position: number;
  resolution: PositionResolution;
  conflictGroup: string | null;
}>;

/**
 * Resolve one collection's positions under coordinator ruling 9.
 *
 * A member whose position nobody duplicates keeps that position exactly, so no
 * dense renumbering happens and the gaps the constraint permits survive in the
 * loaded rows. Within a duplicate group the stable order is source position,
 * then the recorded original-order evidence, then the canonical legacy game
 * UUID; the first member keeps the source position and each later one takes the
 * nearest integer above it that no member claims as a source position and that
 * nothing has already been assigned.
 *
 * A displaced duplicate can land in a gap. That is deliberate: the nearest free
 * integer keeps the member closest to the place the user chose, and the gap
 * itself is not lost, because every row carries its original position in
 * `legacy_position` and in the evidence archive. Only duplicates move, nothing
 * is dropped, and the before/after pair is recorded on every row.
 */
function resolveMemberPositions(
  members: readonly StagedMember[],
  conflicts: ReturnType<typeof m3ConflictCollector>,
): readonly ResolvedMember[] {
  const ordered = [...members].sort((left, right) => {
    const byPosition = compareNumber(left.sourcePosition, right.sourcePosition);
    if (byPosition !== 0) return byPosition;
    const byOrder = compareNullableBigint(left.legacyOrder, right.legacyOrder);
    if (byOrder !== 0) return byOrder;
    return compareUuid(left.canonicalGameId, right.canonicalGameId);
  });

  const sourcePositions = new Set<number>();
  const occurrences = new Map<number, number>();
  for (const member of ordered) {
    sourcePositions.add(member.sourcePosition);
    occurrences.set(member.sourcePosition, (occurrences.get(member.sourcePosition) ?? 0) + 1);
  }

  const assigned = new Set<number>();
  const resolved: ResolvedMember[] = [];
  // A free slot always exists within one probe per member, because at most
  // `ordered.length` integers above a position can be occupied.
  const probeBound = ordered.length + 1;

  for (const member of ordered) {
    const duplicated = (occurrences.get(member.sourcePosition) ?? 0) > 1;
    const conflictGroup = duplicated ? `position:${member.sourcePosition}` : null;
    if (!assigned.has(member.sourcePosition)) {
      assigned.add(member.sourcePosition);
      resolved.push(Object.freeze({ member, position: member.sourcePosition, resolution: "source", conflictGroup }));
      continue;
    }
    let candidate = member.sourcePosition;
    let probes = 0;
    for (;;) {
      candidate += 1;
      probes += 1;
      if (probes > probeBound) m3Failure("m3g_position_unresolvable", COLLECTION_GAMES, "position");
      if (BigInt(candidate) > TARGET_INTEGER_MAX) m3Failure("m3g_target_overflow", COLLECTION_GAMES, "position");
      if (!sourcePositions.has(candidate) && !assigned.has(candidate)) break;
    }
    assigned.add(candidate);
    resolved.push(Object.freeze({ member, position: candidate, resolution: "stable_reorder", conflictGroup }));
    conflicts.record({
      conflict_class: "collection_duplicate_position",
      source_relation: COLLECTION_GAMES,
      source_column: "position",
      decision:
        "Duplicate source positions are resolved by a stable deterministic order (source position, recorded original order, then legacy game identity). The first member keeps its source position; each later member takes the nearest integer above it that no member claims and nothing has been assigned, which keeps it closest to the place the user chose. Members with unique positions are never renumbered, so no dense renumbering happens, and every original position is retained in legacy_position, in legacy_order and in the membership evidence archive. No member is dropped.",
    });
  }

  return Object.freeze(resolved);
}

