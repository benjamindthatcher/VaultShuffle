# On-page growth plan — how VaultShuffle gets found

Written 2026-09-17, cut down the same day. The companion to
[seo-outreach-pack.md](seo-outreach-pack.md), which covers links and
communities. This one covers pages.

The short version: **the plan is a blog, and the blog should be able to pull
game lists out of Supabase.** Everything else that was in the first draft of
this document was cut, and §5 records why so it does not get re-proposed.

---

## 1. Where we are

Vercel Web Analytics, 31 days to 2026-09-17 (31 days is all the hobby plan
retains, so there is no trend line — start snapshotting this monthly).

| Referrer | Visitors |
|---|---|
| none / direct | 2,806 |
| Reddit (all clients) | 1,175 |
| steamcommunity.com | 739 |
| **google.com** | **49** |
| duckduckgo / brave / ecosia / android | 18 |

**Organic search is 67 visitors a month — about 1.4% of traffic.** Everything
else is the outreach pack working, and that decays the moment posting stops.

Every public page except the landing page gets a rounding error: `/steam-data`
27, `/privacy` 20, `/terms` 15, `/contact` 12, `/faq` 11, `/releases` 9. There
is one door into this site.

### Technical SEO is done

Nothing here needs redoing, which is why the fix list below is empty:

- Canonical host clean — `www` → apex and `http` → `https` both 308.
- `metadataBase`, per-page canonicals, and the `pageOpenGraph`/`pageTwitter`
  helpers in [lib/site.ts](../lib/site.ts) that stop Next's shallow metadata
  merge stripping `og:type` and `og:image` off subpages.
- JSON-LD on `/`: `WebSite`, `Organization`, `WebApplication`, `FAQPage`, with
  the FAQ graph built from the same `LANDING_FAQ` array the page renders, so the
  structured data cannot drift from the visible answers.
- `robots.ts` sane; `sitemap.ts` keeps honest hand-maintained `lastmod` and
  correctly omits `changefreq`/`priority`.
- Product routes `noindex` in one place, `app/(product)/layout.tsx`.
- Landing page server-renders ~2,400 words despite the interactive Vault.
- 1.6 MB hero PNG is served as a 53 KB WebP at 1920w.
- Google Search Console is verified by DNS TXT on the apex. The
  `GOOGLE_SITE_VERIFICATION` env var in [layout.tsx](../app/layout.tsx) is unset
  and redundant; leave it.

**The problem is not hygiene. It is that there are seven indexable pages.**

---

## 2. What the competition is doing

Two groups, and only one of them matters.

**Tools with no content** — `pickaga.me`, `getrollplay.com`,
`steam-roulette.com`, `steamrandomizer.com`, `thewheelhaus.com`,
`randomgamepicker.com`, `whatshouldisteam.com`, `gamegauntlets.com`. One-page
apps. pickaga.me is feature-rich but hash-routed with nothing indexable;
RollPlay launched recently with a $3.99/mo tier and ships a landing page plus
`/privacy` and `/terms`. We are level with this group, not behind it.

**Content plays** — this is where the traffic is:

| Site | What they've built |
|---|---|
| `steam-backlog.com` → `backlog.rip` | 50,000+ game pages, `/games/[genre]` archives, `/browse`, `/tools/when-is-the-next-steam-sale` |
| `backlogshuffle.com` | Closest rival. `/blog` (7 posts), `/faq`, `/release-notes` |
| `backlogcoach.com` | Pure content, no tool worth speaking of. Ranks for "too many steam games", "how to beat steam backlog" |
| `vaulted.games` | Price tracker with `/games`, `/blog`, `/subscriptions/compare` |

BacklogCoach is the proof that a blog alone is enough to rank in this niche.

### The detail the plan turns on

BacklogShuffle's two best posts are *"7 Short-Session Steam Deck Games You Can
Beat in Under 10 Hours (All Metacritic 85+)"* and *"5 Best 30-Minute Games for
Your Steam Deck Commute"*. Hand-written, from memory, about seven games and five
games, stale on publication.

We hold **1,233 Steam-Deck-Verified games with a HowLongToBeat main story
between five and ten hours**. They found the query, and we can answer it at a
scale a hand-written listicle cannot.

### The correction that matters, though

**Ziff Davis owns HowLongToBeat, and Ziff Davis owns IGN.** 14,705 of our 16,279
durations come from HLTB, so on the question "how long is this game" we are
republishing IGN's own data, from a domain with no authority, against a company
that owns the source. IGN Playlist already ships HLTB estimates with backlog
tracking attached; see §2's note on it.

So duration is table stakes, not a moat. Everyone in this space has it, and the
people who own it have it best.

What nobody else has is **383,663 owned rows across 667 libraries**: playtime,
completion status, and the median hours a real player logs before stopping. That
is the difference between *how long a game takes* and *what people actually do
with it*, and only the second one is ours.

The practical consequence for every list post: the duration is the filter, not
the finding. The finding is that Celeste is an eight hour game the typical
player leaves after three, that INSIDE is finished by almost half of everyone
who starts it, and that A Short Hike gets played past its own ending. Lead with
those, and let HLTB be the thing that decided which games made the list.

---

## 3. The plan: a blog that can read the database

**Status: built on 2026-09-17.** What follows describes the shipped thing, not a
proposal. §6 records what it looks like on disk and what is left to decide.

The blog is happening regardless. The only real decision was whether a post can
render a list from `catalog_games`, and that had to be settled before the post
pipeline existed, because adding it afterwards is a rewrite.

### 3a. The component

One query helper plus one table component. A post declares a filter; the table
renders at build time.

```
<GameList
  filter={{ deck: "verified", durationKind: "finite",
            mainStoryHours: [1, 10], minReviews: 500, minPositive: 0.85 }}
  limit={40}
/>
```

Rendering right now, that gives: Portal 2 (8.6h, 99% of 465k), The Binding of
Isaac: Rebirth (5.6h, 97%), PEAK (6.1h, 95%), Balatro (7.7h, 98%), Stray (5.2h,
97%), Celeste (8.3h, 97%), Hotline Miami (5.2h, 97%), Little Nightmares (3.6h,
95%) — out of 714 qualifying games. (1,233 is the Deck-Verified count in the
five-to-ten-hour band alone; 714 is what survives once the post's review floors
are applied, and it is the number the page prints.)

Requirements:

- **Build-time, not request-time.** Static with ISR.
  [vercel-proxy-cpu-constraints](vercel-proxy-cpu-constraints.md) is a standing
  reason to keep work out of the request path.
- **`duration_kind = 'finite'`** on any "games you can finish" list, or the list
  fills up with Counter-Strike. Nobody else has this classification; it is the
  thing that makes our version correct and theirs not.
- **Exclude the quarantine.** Per
  [catalogue-quarantine.md](catalogue-quarantine.md) roughly 1,900 DLC, demos
  and utilities sit in the catalogue with `steam_type = 'game'`. A list that
  includes soundtracks is worse than no list.
- **Normalise genres first** *if* a post filters on them — `Free To Play` and
  `Free to Play` are stored as two genres and two rows carry malformed
  slash-joined values. Not needed for duration/Deck/tag filters.
- Rows link to Steam. One CTA under the table, phrased at the reader's actual
  question: *"Own some of these? VaultShuffle will tell you which one fits
  tonight."*

### 3b. Posts the component makes possible

Each is a normal post — a title, 150 words you write, a live table. These are
the queries BacklogShuffle and BacklogCoach are already ranking for.

- Every Steam Deck Verified game you can finish in under 10 hours — 714 games
- Steam games you can beat in under 2 hours — 3,374
- Steam games you can finish in a weekend (5–10h) — 3,876
- Short co-op games on Steam
- Short horror games you can finish in one sitting
- Best cosy games under 5 hours

Floor: **12+ qualifying games or the post doesn't exist.** A five-row generated
table is thin content.

### 3c. Posts that need no component

Straight writing. Two of these are link bait and should be pitched, not just
published — they are statistics nobody else can produce.

1. **"How long does the average Steam game actually take to finish?"** — from
   16,279 HowLongToBeat durations. Lead with this one.
2. **"What percentage of a Steam library goes unplayed?"** — RollPlay quotes 51%
   from someone else's research; we have 24,836 games with real import counts.
3. **"Finite vs endless: which of your games can actually be finished?"** — the
   `duration_kind` story.
4. **"Why your backlog isn't a moral failing"** — the r/patientgamers angle the
   outreach pack already half-drafts.
5. **"How VaultShuffle picks a game"** — the
   [vault-recommender](vault-recommender.md) scoring written for readers.
   Answers "is it just random?", which is the objection in every Reddit thread.

### 3d. Blog plumbing

- `/blog` and `/blog/[slug]`, both added to [app/sitemap.ts](../app/sitemap.ts).
  The hand-kept `routes` array is fine at this scale — keep the honest
  `lastModified` discipline the file's comment already argues for.
- `BlogPosting` JSON-LD per post; `BreadcrumbList` for the SERP real estate.
- Titles with the number visible. *"Every Steam Deck Verified Game You Can Beat
  in Under 10 Hours"* beats *"Short Steam Deck Games"* because the answer shows
  before the click. Under ~60 characters.
- Guest mode is the conversion weapon and is currently invisible to search
  traffic. A reader landing on a post should be one click from a working demo
  with no Steam account.

---

## 4. Measuring it

One number: **organic search visitors per month, currently 67.**

Google Search Console is the only instrument that shows *queries* — Vercel
Analytics cannot. Open it before the first post so there is a baseline.

- **Performance → Queries** weekly. The first real signal is the long-tail
  query count growing, not position on "steam backlog manager". A post ranking
  at position 12 across forty queries with no clicks is a title problem, not a
  content problem, and this is the only place that distinction is visible.
- **Indexing → Pages** — confirm posts are actually getting indexed.

The outreach pack cites GSC data ("9 not-indexed pages at last look"). If that
was not checked first-hand, treat the number as unverified.

Snapshot Vercel's referrer and path splits monthly somewhere durable, or there
will be no baseline to point at in March.

### Expectations

Six to eight weeks before anything moves. Blog-only is a real strategy —
BacklogCoach proves it — but it is a long-tail strategy, and from a base of 67
visitors a month the early numbers will look like nothing. Reddit will keep
outperforming search for a while. That is the reason to start now rather than
after the next Reddit post decays, not a reason to skip it.

---

## 5. What was cut, and why

Recorded so it does not come back around in three months.

| Cut | Reason |
|---|---|
| **Per-game pages** (`/game/[appid]-[slug]`, ~11k–20k URLs) | Rejected 2026-09-17. It was the highest-volume query family available — "how long to beat X", "is X Deck verified" — and losing it lowers the ceiling. It was also the entire scaled-content-abuse risk in the plan, and by far the most work. Cutting it makes the rest safer and smaller. |
| **`/about`, `/features`, `/how-it-works`** | `/faq` already covers the content and pulls 11 visitors a month; a second explainer would pull fewer. The 404s are 4 visitors in 31 days — noise, not a leak. The justification was directory and listicle authors, which is an outreach argument and a weak one. |
| **A separate "list pages" phase** | Not separate. Folded into §3a as a blog capability. Same URLs, same intros, same work — just not a second workstream. |
| **A separate "CTR/conversion" phase** | Was never a phase, just a checklist. The two real items — number-forward titles, guest mode reachable from search traffic — are in §3d. |
| **Genre hub pages** | Least differentiated thing available; backlog.rip already owns it. |

### Still outstanding

- **Strike `/how-it-works` from [seo-outreach-pack.md](seo-outreach-pack.md).**
  It instructs you to request indexing for a page that will not exist. One-line
  edit.
- That pack's closing claim that on-page work "is now done" was true of seven
  pages and is the assumption this document exists to correct.

---

## 6. What shipped

Built 2026-09-17. `npm run typecheck`, `npm run lint` and `npm run build` all
pass; the new files add no lint findings.

### Scheduling

Posts are staggered by date, not by deploy. `published` in the registry is a
`YYYY-MM-DD`; a post whose date has not arrived is committed and reviewable but
absent from the index, the sitemap and `generateStaticParams`, and its own route
404s.

Nothing has to be deployed on the day. `/blog`, `/blog/[slug]` and
`/sitemap.xml` each carry `revalidate = 3600`, and `dynamicParams` is left at
its default, so the first request after a post's date renders it on demand and
the index and sitemap pick it up within the hour. No cron, no schema change.

Scheduled posts are visible in `next dev` with a "Scheduled — not public" badge
so they can be proofed, and carry `noindex, nofollow` as a second line of
defence. The branch is on `NODE_ENV`, so production cannot leak one. Verified:
4 cards in dev with 2 badged, 404 in the production build.

### Files

| Path | What it is |
|---|---|
| `lib/blog/posts.ts` | The registry and the schedule. Add a post here. |
| `lib/blog/game-lists.ts` | Live catalogue queries for `<GameList>`. |
| `lib/blog/stats.ts` | Typed loader for the precomputed aggregates. |
| `data/blog/stats.json` | The aggregates. Refresh per [blog-stats-refresh.md](blog-stats-refresh.md). |
| `components/blog/BlogIndex.tsx` | The index: image-led, lead post plus two per row. Its own layout, like `/releases` has its own. |
| `components/blog/GameList.tsx` | The data-backed table. |
| `components/blog/BlogPieces.tsx` | `StatGrid`, `DataTable`, `BarRow`, `PostCta`, `Aside`. |
| `components/blog/posts/*.tsx` | The four post bodies. |
| `app/blog/page.tsx`, `app/blog/[slug]/page.tsx` | Index and post pages. Thin wrappers over `InfoPage`. |

Posts are TSX modules rather than MDX: a `<GameList>` inside a post needs to be
a real component, and MDX would have meant a new dependency and a config change
to get there. The registry gives the same authoring ergonomics with type safety.

**The blog has no layout CSS of its own.** Both pages are thin wrappers over
`InfoPage`, the same component privacy, FAQ, releases and steam-data use, inside
`SharedInformationShell`. A post's content is therefore shaped as InfoPage takes
it — an `overview` panel plus `sections`, one per former h2. `PostContent` in
`lib/blog/posts.ts` is that shape.

`InfoPage` gained a third variant, `"article"`, alongside `"document"` and
`"release"`. The existing variants render sections as `<details>`, which is
right for a legal page — nobody reads a privacy policy in order, they arrive
looking for one clause, so collapsing the rest is a service. A post is the
opposite: it is read top to bottom, and a dropdown between every heading is an
obstacle. The article variant renders the same sections as a heading plus prose,
keeping the overview panel, the body rules, the link colours and the 72ch cap,
and dropping only the card chrome and the chevron. It also does not inset the
prose the way `documentPage` does, because an inset measures from a card edge
and there is no card — so headings and paragraphs line up with the h1.

The change is strictly additive and was regression-checked: `/privacy`, `/terms`,
`/faq`, `/releases` and `/steam-data` still render the same page classes and the
same `<details>` counts (8, 9, 15, 2, 8) as before it.

The first attempt did have its own stylesheet, and it was wrong in a way worth
recording: `SharedInformationShell` centres a `--vault-list-width`
(`min(1040px, 100%)`) container, and the information pages fill it. Constraining
the prose to `--vault-prose-width` without an auto margin pinned every blog page
to the left of that container with a ~350px gutter on the right, which is what
made them look like a different site. Deleting the stylesheet and using
`InfoPage` fixed it exactly: article left 41px, width 942px, h1 and brand both
at 41px — pixel-identical to `/privacy` at the same viewport.

The new CSS that remains is the `.articlePage` variant block appended to
`InfoPage.module.css`, and the in-content pieces — the game and data tables and
the stat cards — which build from the existing `--vault-*` tokens and the
information pages' surface ramp. There is no separate blog stylesheet.

Verified at 1024px: article left 41px, width 942px, brand, h1 and prose all at
41px, prose 16px/1.8 capped to 72ch, zero `<details>` on any blog page. At 375px
the game table becomes stacked cards with no horizontal overflow.

### Two things worth knowing about the queries

**`tags` is only selected when a filter needs it.** Selecting the jsonb column
pushed the row width from 162 to 510 and the same query from 588ms to over two
seconds, which then failed the build on PostgREST's 8s statement timeout. There
is no index serving these filter combinations, so every list query is a
sequential scan of the catalogue — about 130ms, which is the floor and is fine
at build time.

**`countGameList` returns `{ count, capped }`.** It has no `ORDER BY`, so above
a 2,000-row ceiling the rows that come back are an arbitrary subset and `count`
is a floor. A post must print "over N" in that case. The Deck post does.

### Still outstanding

- **Genre normalisation** — not done, and not needed until a post filters on
  genre. `Free To Play` and `Free to Play` are two genres; two rows carry
  malformed slash-joined values.
- **The quarantine filter** — the review-count floor happens to exclude DLC and
  demos in practice, because they do not accumulate 500 Steam reviews. It is not
  the same thing as reading the quarantine rule, and a post with a low review
  floor would expose that.
- **The privacy policy** — says nothing about aggregate or anonymised data. Not
  a blocker, but it should say so before a post quoting library statistics goes
  out.
- **Not pushed.** Everything is local and uncommitted.

---

## Sequence

| | Work |
|---|---|
| **Before the blog exists** | Decide §3a. Build the query helper and table component with the MDX pipeline, not after it. |
| **First** | Posts 1 and 2 from §3c — the statistics posts. Pitch them; they are the link magnets. |
| **Then** | The Deck-Verified-under-10-hours post from §3b, as the first real test of the component. |
| **Then** | Remaining posts, paced. Check GSC Queries weekly. |
| **Throughout** | Outreach pack Tier 1 and 2, in parallel. |

The outreach pack is right that links are the constraint on head terms. It is
the wrong constraint for the long tail, which needs pages first. Run both.
