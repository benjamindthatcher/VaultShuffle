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
  const pinScope = context.pin_scope === "wishlist" ? "wishlist" : "library";
  if (action === "pinned") {
    const replaceId = cleanId(String(context.replace_game_id ?? ""));
    const { data: pinnedIds, error: pinError } = await supabase.rpc("pin_scoped_user_game", {
      p_user_id: userId,
      p_game_id: gameId,
      p_scope: pinScope,
      p_replace_game_id: replaceId
    });
    if (pinError) throw pinError;
    next = pinScope === "library"
      ? { ...next, pinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] }
      : { ...next, wishlistPinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] };
  }
  if (action === "unpinned") {
    const { data: pinnedIds, error: pinError } = await supabase.rpc("unpin_scoped_user_game", {
      p_user_id: userId,
      p_game_id: gameId,
      p_scope: pinScope
    });
    if (pinError) throw pinError;
    next = pinScope === "library"
      ? { ...next, pinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] }
      : { ...next, wishlistPinnedIds: Array.isArray(pinnedIds) ? pinnedIds.map(String) : [] };
  }
  if (action === "drawn") {
    const { error } = await supabase
      .from("user_vault_state")
      .upsert({ user_id: userId, current_game_id: gameId, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw error;
  } else if (action === "snoozed") {
    const snoozedUntil = cleanSnoozeExpiry(context.snoozed_until);
    const [{ error: snoozeError }, { error: stateError }] = await Promise.all([
      supabase.from("user_game_snoozes").upsert(
        { user_id: userId, game_id: gameId, snoozed_until: snoozedUntil },
        { onConflict: "user_id,game_id" }
      ),
      supabase.from("user_vault_state").update({ current_game_id: null, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("current_game_id", gameId)
    ]);
    if (snoozeError) throw snoozeError;
    if (stateError) throw stateError;
  } else if (action === "unsnoozed") {
    const { error } = await supabase.from("user_game_snoozes")
      .delete().eq("user_id", userId).eq("game_id", gameId);
    if (error) throw error;
  }

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
  let wishlistPinnedIds = [...state.wishlistPinnedIds];
  const snoozed = new Set(state.snoozedIds);
  let currentPickId = state.currentPickId;
  const pinScope = context.pin_scope === "wishlist" ? "wishlist" : "library";

  if (action === "drawn") currentPickId = gameId;
  if (action === "pinned" && pinScope === "wishlist" && !wishlistPinnedIds.includes(gameId)) {
    const replaceId = cleanId(String(context.replace_game_id ?? ""));
    if (wishlistPinnedIds.length < 3) wishlistPinnedIds.push(gameId);
    else if (replaceId && wishlistPinnedIds.includes(replaceId)) wishlistPinnedIds[wishlistPinnedIds.indexOf(replaceId)] = gameId;
  }
  if (action === "unpinned" && pinScope === "wishlist") wishlistPinnedIds = wishlistPinnedIds.filter((id) => id !== gameId);
  if (action === "pinned" && pinScope === "library" && !pinnedIds.includes(gameId)) pinnedIds.push(gameId);
  if (action === "unpinned" && pinScope === "library") pinnedIds = pinnedIds.filter((id) => id !== gameId);
  if (action === "snoozed") {
    snoozed.add(gameId);
    if (currentPickId === gameId) currentPickId = null;
  }
  if (action === "unsnoozed") snoozed.delete(gameId);

  return { pinnedIds, wishlistPinnedIds, snoozedIds: [...snoozed], currentPickId };
}

function cleanId(value: string | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function cleanSnoozeExpiry(value: unknown) {
  const candidate = String(value ?? "").trim();
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
