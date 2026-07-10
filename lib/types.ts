export type Ownership = "Owned" | "Wishlist";
export type GameStatus = "Not Started" | "Sampled" | "In Progress" | "Completed";
export type Priority = "Low" | "Medium" | "High" | "Must Play";

export type Game = {
  id: string;
  user_id: string;
  title: string;
  genre: string;
  store: string;
  ownership: Ownership;
  status: GameStatus;
  rating: number;
  hours_played: number;
  completion_percentage: number;
  priority: Priority;
  date_added: string | null;
  last_played_at: string | null;
  notes: string;
  steam_appid: string | null;
  capsule_url?: string | null;
  header_url?: string | null;
  price_currency?: string | null;
  price_initial?: number | null;
  price_final?: number | null;
  discount_percent?: number | null;
  is_free?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type GamePayload = Omit<Game, "id" | "user_id" | "created_at" | "updated_at">;

export type StatsPayload = {
  total: number;
  completed: number;
  in_progress: number;
  wishlist: number;
  hours: number;
  avg_rating: number;
  avg_completion: number;
};

export type AppUser = {
  id: string;
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type SessionPayload = {
  logged_in: boolean;
  steam_id: string;
  display_name: string;
  avatar_url: string;
  has_steam_key: boolean;
};

export type SteamPlayerSummary = {
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type SteamSearchResult = {
  appid: string;
  name: string;
  image: string;
  store_url: string;
  genre?: string;
};

export type Collection = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  kind: "custom" | "smart";
  rules: { preset?: SmartCollectionPreset };
  created_at: string;
  updated_at: string;
  game_count?: number;
};

export type SmartCollectionPreset = "backlog" | "in-progress" | "must-play" | "short" | "unplayed";

export type CollectionGame = {
  collection_id: string;
  game_id: string;
  notes: string | null;
  position: number;
  created_at: string;
  game?: Game;
};
