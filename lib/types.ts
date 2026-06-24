export type Ownership = "Owned" | "Wishlist" | "Game pass";
export type GameStatus = "Not Started" | "In Progress" | "Completed";
export type Priority = "Low" | "Medium" | "High";

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

export type RecommendationPayload = {
  backlog: Game[];
  wishlist: Game[];
  random: Game | null;
};

export type SteamSearchResult = {
  appid: string;
  name: string;
  image: string;
  store_url: string;
};
