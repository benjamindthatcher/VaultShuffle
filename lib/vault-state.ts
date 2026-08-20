import { getSupabaseAdmin } from "@/lib/supabase";

export type VaultAction = "drawn" | "pinned" | "unpinned" | "snoozed" | "unsnoozed";

/** A pin is a commitment, so it carries when it was made and the playtime it started from. */
export type VaultPin = {
  gameId: string;
  pinnedAt: string | null;
  hoursAtPin: number | null;
};

export type VaultState = {
  pinnedIds: string[];
  pins: VaultPin[];
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
      .select("game_id, slot, scope, pinned_at, hours_at_pin")
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
    pins: (pins ?? []).filter((pin) => pin.scope === "library").map((pin) => ({
      gameId: String(pin.game_id),
      pinnedAt: pin.pinned_at ? String(pin.pinned_at) : null,
      hoursAtPin: pin.hours_at_pin === null || pin.hours_at_pin === undefined ? null : Number(pin.hours_at_pin)
    })),
    snoozedIds: (snoozes ?? []).map((snooze) => String(snooze.game_id)),
    currentPickId: cleanId(String(vaultState?.current_game_id ?? ""))
  };
}

/**
 * Applies a vault action and returns the resulting state.
 *
 * The state is re-read rather than assembled from what the RPC hands back. The
 * RPC returns its own summary object, which silently lacked `pins` when that was
 * added here — so every pin, unpin or snooze replaced the client's state with one
 * missing a field the type promised, and the next render crashed on it. The
 * client casts this response to VaultState, so nothing in TypeScript was ever
 * going to catch the gap.
 *
 * One read, one definition of the shape, no way for the two to drift again.
 */
export async function recordVaultAction(
  userId: string,
  action: VaultAction,
  gameId: string,
  context: Record<string, unknown> = {}
): Promise<VaultState> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("apply_user_vault_action", {
    p_user_id: userId,
    p_action: action,
    p_game_id: gameId,
    p_context: context
  });
  if (error) throw error;
  return getVaultState(userId);
}

function cleanId(value: string | null | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}
