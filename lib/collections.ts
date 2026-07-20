import { getSupabaseAdmin } from "@/lib/supabase";
import { matchesSmartPreset } from "@/lib/smart-collections";
import type { Collection, CollectionGame, Game, SmartCollectionPreset } from "@/lib/types";

type CollectionInput = { name: string; description?: string; kind?: "custom" | "smart"; rules?: { preset: SmartCollectionPreset } };

export async function listCollections(userId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("collections")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  const collections = (data ?? []) as Collection[];
  if (!collections.length) return [];

  const customIds = collections.filter((collection) => collection.kind !== "smart").map((collection) => collection.id);
  const { data: links, error: linkError } = customIds.length ? await supabase
    .from("collection_games")
    .select("collection_id")
    .in("collection_id", customIds) : { data: [], error: null };

  if (linkError) throw linkError;
  const counts = new Map<string, number>();
  for (const link of links ?? []) {
    counts.set(link.collection_id, (counts.get(link.collection_id) ?? 0) + 1);
  }

  const smartCollections = collections.filter((collection) => collection.kind === "smart");
  if (smartCollections.length) {
    const { data: games, error: gameError } = await supabase.from("games").select("*").eq("user_id", userId).eq("ownership", "Owned");
    if (gameError) throw gameError;
    for (const collection of smartCollections) {
      const preset = collection.rules?.preset;
      counts.set(collection.id, preset ? (games as Game[]).filter((game) => matchesSmartPreset(game, preset)).length : 0);
    }
  }

  return collections.map((collection) => ({ ...collection, game_count: counts.get(collection.id) ?? 0 }));
}

export async function createCollection(userId: string, payload: CollectionInput) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("collections")
    .insert({
      user_id: userId,
      name: payload.name,
      description: payload.description || null,
      kind: payload.kind || "custom",
      rules: payload.kind === "smart" ? payload.rules : {}
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as Collection;
}

export async function updateCollection(userId: string, collectionId: string, payload: Partial<CollectionInput>) {
  const existing = await assertCollection(userId, collectionId);
  const update: Record<string, unknown> = {};
  if (payload.name !== undefined) update.name = payload.name;
  if (payload.description !== undefined) update.description = payload.description || null;
  if (payload.kind !== undefined) update.kind = payload.kind;
  if (payload.rules !== undefined) update.rules = payload.rules;
  if (payload.kind === "custom") update.rules = {};
  if ((payload.kind ?? existing.kind) === "smart" && !(payload.rules?.preset ?? existing.rules?.preset)) {
    throw new Error("Choose a rule for this smart collection.");
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("collections")
    .update(update)
    .eq("id", collectionId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  if (existing.kind === "custom" && payload.kind === "smart") {
    const { error: linkError } = await supabase.from("collection_games").delete().eq("collection_id", collectionId);
    if (linkError) throw linkError;
  }
  return data as Collection | null;
}

export async function deleteCollection(userId: string, collectionId: string) {
  await assertCollection(userId, collectionId);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("collections").delete().eq("id", collectionId).eq("user_id", userId);
  if (error) throw error;
}

export async function getCollectionWithGames(userId: string, collectionId: string) {
  const collection = await assertCollection(userId, collectionId);
  const supabase = getSupabaseAdmin();
  if (collection.kind === "smart") {
    const preset = collection.rules?.preset;
    const { data, error } = await supabase.from("games").select("*").eq("user_id", userId).eq("ownership", "Owned").order("title");
    if (error) throw error;
    const matched = preset ? (data as Game[]).filter((game) => matchesSmartPreset(game, preset)) : [];
    return { collection, games: matched.map((game, position) => ({ collection_id: collection.id, game_id: game.id, notes: null, position, created_at: collection.created_at, game })) };
  }
  const { data, error } = await supabase
    .from("collection_games")
    .select("collection_id, game_id, notes, position, created_at, games(*)")
    .eq("collection_id", collectionId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw error;

  const games = (data ?? []).map((row) => {
    const item = row as unknown as CollectionGame & { games?: Game };
    return {
      collection_id: item.collection_id,
      game_id: item.game_id,
      notes: item.notes,
      position: item.position,
      created_at: item.created_at,
      game: item.games
    };
  });

  return { collection, games };
}

export async function addGameToCollection(
  userId: string,
  collectionId: string,
  payload: { game_id: string; notes?: string; position?: number }
) {
  const collection = await assertCollection(userId, collectionId);
  if (collection.kind === "smart") throw new Error("Smart collection membership is automatic.");
  await assertGame(userId, payload.game_id);

  const supabase = getSupabaseAdmin();
  const position = payload.position ?? await nextPosition(collectionId);
  const { data, error } = await supabase
    .from("collection_games")
    .upsert({
      collection_id: collectionId,
      game_id: payload.game_id,
      notes: payload.notes || null,
      position
    }, { onConflict: "collection_id,game_id" })
    .select("*")
    .single();

  if (error) throw error;
  await touchCollection(collectionId);
  return data as CollectionGame;
}

export async function removeGameFromCollection(userId: string, collectionId: string, gameId: string) {
  const collection = await assertCollection(userId, collectionId);
  if (collection.kind === "smart") throw new Error("Smart collection membership is automatic.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("collection_games")
    .delete()
    .eq("collection_id", collectionId)
    .eq("game_id", gameId);

  if (error) throw error;
  await touchCollection(collectionId);
}

async function assertCollection(userId: string, collectionId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("collections")
    .select("*")
    .eq("id", collectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Collection not found.");
  return data as Collection;
}

async function assertGame(userId: string, gameId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Game not found.");
}

async function nextPosition(collectionId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("collection_games")
    .select("position")
    .eq("collection_id", collectionId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Number(data?.position ?? -1) + 1;
}

async function touchCollection(collectionId: string) {
  const supabase = getSupabaseAdmin();
  await supabase.from("collections").update({ updated_at: new Date().toISOString() }).eq("id", collectionId);
}
