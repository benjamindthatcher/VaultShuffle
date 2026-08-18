export type Ownership = "Owned";
export type GameStatus = "Not Started" | "Sampled" | "In Progress" | "Slept" | "Completed";
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
  completed_at?: string | null;
  previous_active_status?: "Not Started" | "Sampled" | "In Progress" | null;
  slept_at?: string | null;
  completion_suggestion_dismissed_at?: string | null;
  completion_suggestion_dismissed_playtime?: number | null;
  main_story_minutes?: number | null;
  main_extras_minutes?: number | null;
  completionist_minutes?: number | null;
  duration_source?: string | null;
  duration_source_updated_at?: string | null;
  duration_confidence?: "low" | "medium" | "high" | null;
  duration_kind?: "finite" | "endless" | "not-applicable" | "unknown" | null;
  /** Full weighted SteamSpy tag map from the shared catalogue. */
  steam_tags?: Record<string, number> | null;
  is_quarantined?: boolean;
  quarantine_reason?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type GameDurationEstimate = {
  mainStoryMinutes?: number | null;
  mainExtrasMinutes?: number | null;
  completionistMinutes?: number | null;
  source?: string | null;
  sourceUpdatedAt?: string | null;
  confidence?: "low" | "medium" | "high" | null;
  endless?: boolean;
};

export type GamePayload = Omit<
  Game,
  "id" | "user_id" | "created_at" | "updated_at" | "is_quarantined" | "quarantine_reason"
>;

export type StatsPayload = {
  total: number;
  completed: number;
  in_progress: number;
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
  user_id: string;
  steam_id: string;
  display_name: string;
  avatar_url: string;
  has_steam_key: boolean;
  steam_playtime_visible?: boolean | null;
  steam_last_played_visible?: boolean | null;
};

export type SteamPlayerSummary = {
  steam_id: string;
  display_name: string | null;
  avatar_url: string | null;
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

export type SmartCollectionPreset =
  | "nearly-finished"
  | "quick-wins"
  | "recently-played"
  | "fallen-off"
  | "long-haul"
  | "endless-rotation"
  | "untouched"
  // Kept so existing saved collections continue to work and can be edited.
  | "backlog"
  | "in-progress"
  | "must-play"
  | "short"
  | "unplayed";

export type CollectionGame = {
  collection_id: string;
  game_id: string;
  notes: string | null;
  position: number;
  created_at: string;
  game?: Game;
};
