import { getSupabaseAdmin } from "@/lib/supabase";

export type VaultAction = "drawn" | "pinned" | "unpinned" | "snoozed" | "unsnoozed";

export type VaultState = {
  pinnedIds: string[];
  wishlistPinnedIds: string[];
  snoozedIds: string[];
  currentPickId: string | null;
};

export async function getVaultState(userId: string): Promise<VaultState> {
  const supabase = getSupabaseAdmin();
  const [
    { data: pins, error: pinsError },
    { data: snoozes, error: snoozeError },
    { data: vaultState, error: stateError }
  ] = await Promise.all([
    supabase
      .from("user_game_pins")
      .select("game_id, slot, scope")
      .eq("user_id", userId)
      .order("slot", { ascending: true }),
    supabase
      .from("user_game_snoozes")
      .select("game_id")
      .eq("user_id", userId)
      .or(`snoozed_until.is.null,snoozed_until.gt.${new Date().toISOString()}`),
    supabase
      .from("user_vault_state")
      .select("current_game_id")
      .eq("user_id", userId)
      .maybeSingle()
  ]);

  if (pinsError) throw pinsError;
  if (snoozeError) throw snoozeError;
  if (stateError) throw stateError;

  return {
    pinnedIds: (pins ?? []).filter((pin) => pin.scope === "library").map((pin) => String(pin.game_id)),
    wishlistPinnedIds: (pins ?? []).filter((pin) => pin.scope === "wishlist").map((pin) => String(pin.game_id)),
    snoozedIds: (snoozes ?? []).map((snooze) => String(snooze.game_id)),
    currentPickId: cleanId(String(vaultState?.current_game_id ?? ""))
  };
}

export async function recordVaultAction(
  userId: string,
  action: VaultAction,
  gameId: string,
  context: Record<string, unknown> = {}
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("apply_user_vault_action", {
    p_user_id: userId,
    p_action: action,
    p_game_id: gameId,
    p_context: context
  });
  if (error) throw error;
  const state = (data ?? {}) as Partial<VaultState>;
  return {
    pinnedIds: Array.isArray(state.pinnedIds) ? state.pinnedIds.map(String) : [],
    wishlistPinnedIds: Array.isArray(state.wishlistPinnedIds) ? state.wishlistPinnedIds.map(String) : [],
    snoozedIds: Array.isArray(state.snoozedIds) ? state.snoozedIds.map(String) : [],
    currentPickId: cleanId(state.currentPickId ?? null)
  };
}

function cleanId(value: string | null | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}
