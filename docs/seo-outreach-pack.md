# Off-page pack — everything to post, and what to say

Nothing here is automated and nothing is posted on your behalf. This is the list,
the copy, and the rules that apply to each place.

**The one rule that matters:** every competitor ahead of us in search has links
pointing at them from places Google already trusts. We have almost none. That —
not the wording on the landing page — is the gap. These submissions are how it
closes.

**Do not mass-post in one day.** Spread it over two or three weeks. A brand-new
domain that suddenly appears in fifteen directories in one afternoon looks
exactly like what it looks like.

---

## Tier 1 — Directories (highest value, lowest effort)

These rank well themselves, so a listing both passes a link and gets found
directly. Do these first.

### 1. AlternativeTo — the single most valuable one
- **Submit:** https://alternativeto.net/manage/add-item/
- **Why it matters:** their pages outrank most products for "<competitor>
  alternatives". Competitors are all on it; we are not.
- **Category:** Game Library Managers
- **Also do this:** on each of these pages, use "Suggest an alternative" to add
  VaultShuffle. This is where the actual traffic comes from:
  - https://alternativeto.net/software/backloggd/
  - https://alternativeto.net/software/backloggery/about/
  - https://alternativeto.net/software/ggapp/
  - backlog.rip / Steam Backlog
- **Description to use (edit freely):**
  > VaultShuffle is a free Steam backlog manager that decides what you should
  > play tonight. Connect Steam (or paste a public profile URL), answer three
  > questions — how long you have, what mood you're in, what you want from the
  > session — and it scores the games you already own, then picks one and
  > explains why. Includes global filters, Steam Deck/Mac/Linux device modes,
  > Steam Families support, collections and progress tracking. No paid tier.
- **Tags:** steam, backlog, game-library, recommendations, free

### 2. SaaSHub
- **Submit:** https://www.saashub.com/submit/list
- **Also:** "Suggest an alternative" on https://www.saashub.com/backlog-rip-alternatives
- Same description as above.

### 3. Product Hunt
- **Submit:** https://www.producthunt.com/posts/new
- **Timing matters:** launch 12:01am PT, and pick a Tuesday–Thursday.
- **Tagline (60 char limit):** `Stop scrolling your Steam backlog. Get told what to play.`
- Prepare 3–4 screenshots plus the OG image before you start the submission.
- Have the "maker's first comment" ready — that is where the honest story goes
  (solo build, university project, real users, what it does not do yet).

### 4. Smaller directories — worth an hour total
- Indie Hackers — https://www.indiehackers.com/products (product page + a build log)
- BetaList — https://betalist.com/submit
- SideProjectors / Uneed / Tiny Startups — low effort, small but real
- **awesome-steam** on GitHub — open a PR adding VaultShuffle. Search GitHub for
  `awesome steam` lists and check each one's contributing rules first.

---

## Tier 2 — Communities (higher value, needs care)

**Read each subreddit's self-promotion rule before posting.** Several of these
will remove a post that is purely a link drop, and a removal costs more than the
post was worth. The pattern that works: lead with the problem, be honest that you
built it, invite criticism.

### Reddit — in rough priority order
| Subreddit | Angle | Notes |
|---|---|---|
| r/Steam | "I built a free tool that picks what to play from your backlog" | Big reach, strict on self-promo — check rules |
| r/patientgamers | Backlog culture is the whole subreddit's identity | Best audience/attitude fit |
| r/gamingsuggestions | Directly on-topic | Naturally welcoming to tools |
| r/SteamDeck | Lead with the Deck device mode | Specific, useful hook |
| r/SideProject | Honest build story | Easiest, friendliest |
| r/webdev / r/nextjs | The engineering, not the product | Link the README's engineering notes |
| r/InternetIsBeautiful | Only if guest mode impresses cold | Very strict rules |

**Draft post — r/patientgamers (edit heavily, make it yours):**
> **I got tired of spending 20 minutes picking a game and then playing nothing**
>
> I own far more games than I will ever finish, and the actual cost of that isn't
> money — it's opening Steam, scrolling, and giving up.
>
> So I built VaultShuffle. It imports your Steam library and asks three things:
> how long you've got, what headspace you're in, and whether you want to start
> something or finish something. Then it scores what you own against that and
> gives you one game, with the reasons attached. Finished, abandoned and snoozed
> games are out before it picks, so it isn't a random spin through everything.
>
> It's free, there's no paid tier, and you can try it in guest mode without
> connecting anything.
>
> It's a solo university side project and there are rough edges — I'd genuinely
> like it broken by people with weird libraries.

**Rules of engagement:** post from an account with real history, reply to every
comment, and if someone reports a bug, fix it and say you did. That thread is
the link.

### Steam Community
- Groups worth joining and posting in *as a participant first*:
  - `BacklogAddictsAnonymous`
  - `backlog-rip`
  - `Backlog Approved`
- There are existing Steam Discussions threads asking for exactly this tool.
  Answering those honestly is the highest-quality placement available — search
  Steam Discussions for "random game picker" and "pick from my backlog".

### Hacker News
- **Show HN:** `Show HN: VaultShuffle – a Steam backlog manager that tells you what to play tonight`
- Post Tue–Thu, ~8–10am ET. Be in the thread to answer.
- HN responds well to the engineering story — the delisted-games and stale
  schema-cache problems in the README are the interesting part to them.

---

## Tier 3 — Get into the listicles

The single query we most want is "best steam backlog manager", and that SERP is
owned by listicles — including one a competitor wrote about itself.

- **backlogcoach.com/blog/best-steam-backlog-manager-tools** — a rival's own
  post. Not realistic to get added; know it exists and that it is why they rank.
- Find the neutral ones instead: search `best steam backlog manager 2026`,
  `steam library organizer tools` and email the authors. A short, specific,
  non-templated email offering the tool for testing works occasionally; a mass
  mail-merge never does.
- **Alternative that actually works:** get onto AlternativeTo and SaaSHub first
  (Tier 1). Listicle writers source their entries from those pages.

---

## What to do after posting

1. In Search Console, use **URL Inspection → Request indexing** for `/`,
   `/how-it-works` and `/releases` once these ship.
2. Watch **Performance → Queries** weekly. The first sign this is working is not
   ranking for "steam backlog manager" — it is picking up dozens of long-tail
   queries you never targeted.
3. Check **Indexing → Pages**. There were 9 not-indexed pages at last look; most
   will be the correctly noindexed product routes, but it is worth confirming
   nothing public is stuck.

## Realistic expectations

Long-tail queries: a few weeks. "Steam backlog manager": three to six months,
and only if Tier 1 and Tier 2 actually happen. On-page work alone will not do it
— that part is now done, and it is the smaller half of the problem.
