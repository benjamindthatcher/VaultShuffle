import { getSupabaseAdmin } from "@/lib/supabase";

const SETTING_KEYS = {
  pinnedIds: "vault_pinned_ids",
  snoozedIds: "vault_snoozed_ids",
  currentPickId: "vault_current_pick_id"
} as const;

export type VaultAction = "drawn" | "pinned" | "unpinned" | "snoozed" | "unsnoozed";

export type VaultState = {
  pinnedIds: string[];
  snoozedIds: string[];
  currentPickId: string | null;
};

export async function getVaultState(userId: string): Promise<VaultState> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .eq("user_id", userId)
    .in("key", Object.values(SETTING_KEYS));

  if (error) throw error;
  const values = new Map((data ?? []).map((row) => [String(row.key), String(row.value)]));

  return {
    pinnedIds: parseIdList(values.get(SETTING_KEYS.pinnedIds)),
    snoozedIds: parseIdList(values.get(SETTING_KEYS.snoozedIds)),
    currentPickId: cleanId(values.get(SETTING_KEYS.currentPickId))
  };
}

export async function recordVaultAction(
  userId: string,
  action: VaultAction,
  gameId: string,
  context: Record<string, unknown> = {}
) {
  const supabase = getSupabaseAdmin();
  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .eq("user_id", userId)
    .maybeSingle();

  if (gameError) throw gameError;
  if (!game) throw new Error("Game not found in your library.");

  const state = await getVaultState(userId);
  const next = reduceVaultState(state, action, gameId);
  const rows = [
    settingRow(userId, SETTING_KEYS.pinnedIds, JSON.stringify(next.pinnedIds)),
    settingRow(userId, SETTING_KEYS.snoozedIds, JSON.stringify(next.snoozedIds)),
    settingRow(userId, SETTING_KEYS.currentPickId, next.currentPickId ?? "")
  ];

  const { error: settingError } = await supabase
    .from("app_settings")
    .upsert(rows, { onConflict: "user_id,key" });
  if (settingError) throw settingError;

  const { error: eventError } = await supabase.from("vault_events").insert({
    user_id: userId,
    game_id: gameId,
    action,
    context
  });
  if (eventError) throw eventError;

  return next;
}

function reduceVaultState(state: VaultState, action: VaultAction, gameId: string): VaultState {
  const pinned = new Set(state.pinnedIds);
  const snoozed = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned") pinned.add(gameId);
  if (action === "unpinned") pinned.delete(gameId);
  if (action === "snoozed") {
    snoozed.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozed.delete(gameId);

  return { pinnedIds: [...pinned], snoozedIds: [...snoozed], currentPickId };
}

function settingRow(userId: string, key: string, value: string) {
  return { user_id: userId, key, value, updated_at: new Date().toISOString() };
}

function parseIdList(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanId(value: string | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}
