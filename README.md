# Vault Shuffle

[Vault Shuffle](https://www.vaultshuffle.com) is a Steam backlog companion that helps players stop staring at a huge library and actually choose something to play.

It started as a first-year Python backlog tracker and has grown into a hosted Next.js app with Steam sign-in, Supabase persistence, Steam metadata sync, and a purpose-built shuffle flow.

## What It Does

- Lets visitors preview the app before signing in.
- Uses Steam OpenID so users can connect without sharing a Steam password.
- Imports a Steam library with playtime, last-played dates, artwork, genres, and ratings where available.
- Stores user-specific game state in Supabase: ownership, playtime, progress, notes, and lifecycle decisions.
- Lets users add individual games from Steam search.
- Filters by status, library source, top-level genre, length, and free-text search.
- Draws random unfinished games from the current visible list through the Vault Shuffle flow.
- Persists the selected visual theme across the site.

## Live Project

- Production: [vaultshuffle.com](https://www.vaultshuffle.com)
- Hosting: Vercel
- Database: Supabase Postgres
- Source control: GitHub

## Architecture

```mermaid
flowchart LR
  Browser["Browser UI"] --> Next["Next.js App Router"]
  Next --> SteamOpenID["Steam OpenID"]
  Next --> SteamAPI["Steam Web API / Store Metadata"]
  Next --> Supabase["Supabase Postgres"]
  Next --> Vercel["Vercel Hosting"]
  Browser --> LocalStorage["Preview Mode Local Storage"]
```

## Data Model

The main hosted data lives in Supabase:

- `app_users`: Steam identity, display name, avatar, and account timestamps.
- `catalog_games`: one canonical row per Steam AppID containing shared titles, artwork, genres, tags, reviews, prices, and duration data.
- `user_games`: the mutable per-account ownership and progress record. Its stable UUID is referenced by Collections, Purge, pins, snoozes, and Vault state.
- `user_games_with_catalog`: the read model joining each ownership record to its canonical catalogue data.
- `sessions`: server-side session records used by the HTTP-only auth cookie.
- `vault_draws` and `vault_draw_events`: bounded draw history and follow-up actions.

Guest mode is read-only and draws from 250 popular records in the live canonical catalogue. It never creates ownership rows.

## Notable Implementation Details

- **Steam-first identity:** Steam confirms the account; Vault Shuffle never sees Steam passwords.
- **Canonical metadata:** Steam app details are stored once in the catalogue and refreshed in leased batches.
- **Top-level genre filters:** Games can keep detailed genre tags, but filtering is intentionally reduced to broad useful categories.
- **Shared game classification:** status, progress, length, and endless-game logic are centralised so the app and API agree.
- **Hosted environment:** secrets such as the Steam API key and Supabase service role key live in Vercel environment variables.


Local development is possible with the same variables, but the public project is intended to be reviewed through the live deployment.

## Quality Checks

The main safety check is the production build:

```bash
npm run build
```

The project is actively being tightened up with more extracted components, shared helpers, and future automated checks.

## Roadmap

- Polish the Vault Shuffle modal into the main memorable product moment.
- Improve length estimates with a better external source when permitted.
- Continue filling missing Steam genres, artwork, and ratings through cached background sync.
- Add stronger empty, loading, and error states around imports.
- Add lightweight automated checks once the UI settles.

## Ownership

This is a portfolio project by Ben Thatcher. Vault Shuffle is not affiliated with Valve, Steam, or any game publisher. Game names, artwork, store links, and Steam references belong to their respective owners.
