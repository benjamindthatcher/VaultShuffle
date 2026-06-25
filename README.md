# Vault Shuffle

[Vault Shuffle](https://www.vaultshuffle.com) is a Steam backlog companion that helps players stop staring at a giant library and actually pick something to play.

Sign in with Steam, import your owned games, filter by status or playtime, and let the shuffle view recommend a sensible next pick. Visitors can also open the app in preview mode and try the interface before connecting a Steam account.

## What It Does

- Steam OpenID sign-in with an HTTP-only app session
- Steam library import using the Steam Web API
- Steam store search for adding individual games
- Supabase-backed game data, statuses, recommendations, and user records
- Filters for status, ownership, vibe, playtime, completed games, and sorting
- Smart shuffle recommendations for unfinished backlog games
- Temporary browser-only preview mode for guests
- Responsive blue/purple interface built for a hosted web app

## Why I Built It

This started as a first-year Python backlog tracker, then grew into a hosted web product. The current version is built around a real deployment flow: GitHub for source control, Vercel for hosting, Supabase for data, and Steam for identity and library import.

The main design goal is simple: make a large Steam library feel less overwhelming.

## Tech Highlights

- **Next.js App Router** for the site, app shell, and server route handlers
- **Supabase Postgres** for persistent user and game data
- **Steam OpenID** for authentication without handling Steam passwords
- **Steam Web API** for library import and profile details
- **Cached Steam store search** to keep API usage sensible
- **Vercel** production deployment at [vaultshuffle.com](https://www.vaultshuffle.com)

## Privacy Notes

Vault Shuffle does not ask for or store Steam passwords. Steam confirms the user through OpenID, then the app stores the SteamID, profile display details, imported game metadata, and any edits made inside Vault Shuffle.

Guest preview games stay in the browser's local storage and are not synced to Supabase.

## Status

The site is live and under active development. Current focus areas are polishing the dashboard experience, improving imported Steam metadata, and making recommendations feel more personal.
