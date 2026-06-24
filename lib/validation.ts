import { z } from "zod";

export const gamePayloadSchema = z.object({
  title: z.string().trim().min(1).max(220),
  genre: z.string().trim().default("Unknown"),
  store: z.string().trim().default("Steam"),
  ownership: z.enum(["Owned", "Wishlist", "Game pass"]).default("Owned"),
  status: z.enum(["Not Started", "In Progress", "Completed"]).default("Not Started"),
  rating: z.coerce.number().int().min(0).max(10).default(0),
  hours_played: z.coerce.number().min(0).default(0),
  completion_percentage: z.coerce.number().int().min(0).max(100).default(0),
  priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
  date_added: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()),
  last_played_at: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()),
  notes: z.string().trim().default(""),
  steam_appid: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable())
});

export const patchGameSchema = gamePayloadSchema.partial();

export const steamKeySchema = z.object({
  api_key: z.string().trim().min(10)
});
