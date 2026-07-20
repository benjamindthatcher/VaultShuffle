import { getSupabaseAdmin } from "@/lib/supabase";

const SETTING_KEYS = {
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
  const [{ data, error }, { data: pins, error: pinsError }] = await Promise.all([
    supabase
      .from("app_settings")
      .select("key, value")
      .eq("user_id", userId)
      .in("key", [SETTING_KEYS.snoozedIds, SETTING_KEYS.currentPickId]),
    supabase
      .from("user_game_pins")
      .select("game_id, slot")
      .eq("user_id", userId)
      .order("slot", { ascending: true })
  ]);

  if (error) throw error;
  if (pinsError) throw pinsError;
  const values = new Map((data ?? []).map((row) => [String(row.key), String(row.value)]));

  return {
    pinnedIds: (pins ?? []).map((pin) => String(pin.game_id)),
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
  let next = reduceVaultState(state, action, gameId, context);
  if (action === "pinned") {
    const replaceId = cleanId(String(context.replace_game_id ?? ""));
    const { data: pinnedIds, error: pinError } = await supabase.rpc("pin_user_game", {
      p_user_id: userId,
      p_game_id: gameId,
      p_replace_game_id: replaceId
    });
    if (pinError) throw pinError;
    next = { ...next, pinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] };
  }
  if (action === "unpinned") {
    const { data: pinnedIds, error: pinError } = await supabase.rpc("unpin_user_game", {
      p_user_id: userId,
      p_game_id: gameId
    });
    if (pinError) throw pinError;
    next = { ...next, pinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] };
  }
  const rows = [
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

function reduceVaultState(state: VaultState, action: VaultAction, gameId: string, context: Record<string, unknown>): VaultState {
  let pinnedIds = [...state.pinnedIds];
  const snoozed = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned" && !pinnedIds.includes(gameId)) pinnedIds.push(gameId);
  if (action === "unpinned") pinnedIds = pinnedIds.filter((id) => id !== gameId);
  if (action === "snoozed") {
    snoozed.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozed.delete(gameId);

  return { pinnedIds, snoozedIds: [...snoozed], currentPickId };
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
