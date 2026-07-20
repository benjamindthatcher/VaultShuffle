import { z } from "zod";

const prioritySchema = z.enum(["Low", "Medium", "High", "Must Play"]);
export const smartCollectionPresetSchema = z.enum(["backlog", "in-progress", "must-play", "short", "unplayed"]);

export const gamePayloadSchema = z.object({
  title: z.string().trim().min(1).max(220),
  genre: z.string().trim().max(80).default("Unknown"),
  store: z.string().trim().max(80).default("Steam"),
  ownership: z.enum(["Owned", "Wishlist"]).default("Wishlist"),
  status: z.enum(["Not Started", "Sampled", "In Progress", "Slept", "Completed"]).default("Not Started"),
  rating: z.coerce.number().int().min(0).max(10).default(0),
  hours_played: z.coerce.number().min(0).default(0),
  completion_percentage: z.coerce.number().int().min(0).max(100).default(0),
  priority: prioritySchema.default("Medium"),
  date_added: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().max(64).nullable()),
  last_played_at: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().max(64).nullable()),
  notes: z.string().trim().max(5000).default(""),
  steam_appid: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().regex(/^\d{1,10}$/, "Steam App ID must be numeric.").nullable())
}).strict();

export const patchGameSchema = z.object({
  ownership: z.enum(["Owned", "Wishlist"]).optional(),
  status: z.enum(["Not Started", "Sampled", "In Progress", "Slept", "Completed"]).optional(),
  hours_played: z.coerce.number().min(0).optional(),
  completion_percentage: z.coerce.number().int().min(0).max(100).optional(),
  priority: prioritySchema.optional(),
  last_played_at: z.preprocess((value) => (value === undefined || value === "" ? null : value), z.string().trim().nullable()).optional(),
  notes: z.string().trim().max(5000).optional(),
  completed_at: z.string().datetime().nullable().optional(),
  slept_at: z.string().datetime().nullable().optional(),
  completion_suggestion_dismissed_at: z.string().datetime().nullable().optional(),
  completion_suggestion_dismissed_playtime: z.coerce.number().min(0).nullable().optional(),
  restore_active: z.boolean().optional()
}).strict();

export const collectionPayloadSchema = z.object({
  name: z.string().trim().min(1).max(90),
  description: z.string().trim().max(280).optional().default(""),
  kind: z.enum(["custom", "smart"]).optional().default("custom"),
  rules: z.object({ preset: smartCollectionPresetSchema }).optional()
}).superRefine((value, context) => {
  if (value.kind === "smart" && !value.rules?.preset) {
    context.addIssue({ code: "custom", message: "Choose a rule for this smart collection.", path: ["rules", "preset"] });
  }
});

export const collectionGamePayloadSchema = z.object({
  game_id: z.string().uuid(),
  notes: z.string().trim().max(500).optional().default(""),
  position: z.coerce.number().int().min(0).optional()
}).strict();

export const steamKeySchema = z.object({
  api_key: z.string().trim().min(10)
});

export const feedbackSubmissionSchema = z.object({
  feedback_type: z.enum(["improvement", "bug"]),
  message: z.string().trim().min(10, "Please add a little more detail.").max(2000),
  contact_allowed: z.boolean().default(false),
  contact_email: z.string().trim().email().max(320).optional().nullable(),
  route: z.string().trim().max(300).optional().nullable(),
  app_area: z.string().trim().max(80).optional().nullable(),
  client_context: z.object({
    viewport: z.enum(["mobile", "tablet", "desktop"]).optional(),
    browser: z.string().trim().max(120).optional(),
    submitted_at: z.string().datetime().optional(),
    source: z.string().trim().max(80).optional()
  }).strict().optional().nullable(),
  website: z.string().max(0).optional().default(""),
  form_started_at: z.number().int().positive()
}).superRefine((value, context) => {
  if (!value.contact_allowed && value.contact_email) {
    context.addIssue({ code: "custom", path: ["contact_email"], message: "Contact consent is required before including an email." });
  }
});

export const contactMessageSchema = z.object({
  enquiry_type: z.enum(["account", "steam-data", "privacy", "technical", "business", "other"]),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  subject: z.string().trim().min(3, "Add a subject.").max(150),
  message: z.string().trim().min(10, "Please add a little more detail.").max(5000),
  website: z.string().max(0).optional().default(""),
  form_started_at: z.number().int().positive()
}).strict();
