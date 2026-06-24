# Vault Shuffle

Vault Shuffle is now a Next.js app backed by Supabase Postgres, designed to be pushed to GitHub and deployed on Vercel.

It keeps the existing blue/purple Vault Shuffle UI, Steam sign-in, Steam artwork, Steam store search, smart shuffle, filters, game editing, and recommendation history.

The Supabase database starts empty. Games are created from the signed-in Steam account, not from bundled seed data.

## Tech Stack

- Next.js App Router
- React
- Supabase Postgres
- Steam OpenID sign-in
- Steam Web API owned-library import
- Vercel hosting

## Local Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create a Supabase project.

3. In Supabase, open the SQL editor and run the contents of:

```text
supabase/migrations/0001_initial_schema.sql
```

4. Copy the environment example:

```bash
cp .env.example .env.local
```

5. Fill in `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SITE_URL=http://localhost:8766
SESSION_SECRET=...
STEAM_WEB_API_KEY=...
```

Generate `SESSION_SECRET` with:

```bash
openssl rand -base64 32
```

6. Start the app:

```bash
pnpm dev
```

Open [http://localhost:8766](http://localhost:8766).

## Steam Sign-In

Supabase Auth does not provide a native Steam provider. Steam sign-in uses Steam OpenID 2.0 through Next.js route handlers:

- `/api/auth/steam`
- `/api/auth/steam/callback`

The callback creates an app user and session in Supabase. If `STEAM_WEB_API_KEY` is configured, the callback also imports or updates that Steam account's owned games. The browser receives an HTTP-only `vault_session` cookie.

For local development:

```bash
NEXT_PUBLIC_SITE_URL=http://localhost:8766
```

For Vercel:

```bash
NEXT_PUBLIC_SITE_URL=https://your-site.vercel.app
```

## Steam Web API Key

Steam store search works without a key. Owned-library import needs a Steam Web API key:

```bash
STEAM_WEB_API_KEY=...
```

The app deliberately does not save API keys from the browser. Keys belong in environment variables.

## Empty Database By Design

Do not seed the hosted database with local CSV data. A new Supabase project should contain no games until a real Steam user signs in.

On sign-in:

1. Steam confirms the user's SteamID64.
2. Vault Shuffle creates or updates the matching `app_users` row.
3. If `STEAM_WEB_API_KEY` is present, Vault Shuffle imports that account's owned Steam games into `games`.
4. The user can then edit statuses, priorities, notes, and completion data inside the app.

## Supabase Tables

The migration creates:

- `app_users`
- `sessions`
- `games`
- `recommendations`
- `app_settings`

Row Level Security is enabled on every table. No browser-access policies are created; the Next.js server uses the service role key, validates the Steam session cookie, and scopes every query to the signed-in app user.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Create a new Vercel project from the GitHub repo.
3. Add the environment variables from `.env.example`.
4. Set `NEXT_PUBLIC_SITE_URL` to the Vercel production URL or your custom domain.
5. Deploy.

The Vercel build command can stay as:

```bash
pnpm build
```

## Useful Commands

```bash
pnpm dev          # local development
pnpm build        # production build check
pnpm start        # run built app locally
-
```

## Legacy Local Files

Legacy Python, CSV, and SQLite files are ignored by Git. The hosted Next.js app does not use them.
