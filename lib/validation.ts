import { z } from "zod";

const prioritySchema = z.enum(["Low", "Medium", "High", "Must Play"]);

export const gamePayloadSchema = z.object({
  title: z.string().trim().min(1).max(220),
  genre: z.string().trim().default("Unknown"),
  store: z.string().trim().default("Steam"),
  ownership: z.enum(["Owned", "Wishlist"]).default("Wishlist"),
  status: z.enum(["Not Started", "Sampled", "In Progress", "Completed"]).default("Not Started"),
  rating: z.coerce.number().int().min(0).max(10).default(0),
  hours_played: z.coerce.number().min(0).default(0),
  completion_percentage: z.coerce.number().int().min(0).max(100).default(0),
  priority: prioritySchema.default("Medium"),
  date_added: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()),
  last_played_at: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()),
  notes: z.string().trim().default(""),
  steam_appid: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable())
});

export const patchGameSchema = z.object({
  ownership: z.enum(["Owned", "Wishlist"]).optional(),
  status: z.enum(["Not Started", "Sampled", "In Progress", "Completed"]).optional(),
  hours_played: z.coerce.number().min(0).optional(),
  completion_percentage: z.coerce.number().int().min(0).max(100).optional(),
  priority: prioritySchema.optional(),
  last_played_at: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()).optional(),
  notes: z.string().trim().optional()
}).strict();

export const collectionPayloadSchema = z.object({
  name: z.string().trim().min(1).max(90),
  description: z.string().trim().max(280).optional().default("")
});

export const collectionGamePayloadSchema = z.object({
  game_id: z.string().trim().min(1),
  notes: z.string().trim().max(500).optional().default(""),
  position: z.coerce.number().int().min(0).optional()
});

export const steamKeySchema = z.object({
  api_key: z.string().trim().min(10)
});
