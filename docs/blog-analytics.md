# Blog analytics

The blog uses the existing PostHog client and analytics setting. No second SDK or automatic click capture is added.

| Event | Meaning | Properties |
| --- | --- | --- |
| `$pageview` | Existing route view, enriched for blog routes | `app_area: blog`, `blog_page_type`, article `post_slug` |
| `blog_link_clicked` | Article opened from index, Steam link, FAQ or return to index | `action`, `post_slug`, `topic`, `blog_page_type`, optional `game_appid` |
| `blog_cta_clicked` | Reader chooses Try it as a guest | `action: try_guest`, `post_slug`, `topic`, `blog_page_type` |
| `blog_article_engaged` | At least 30 seconds with the article visible and at least halfway reached | `post_slug`, `topic`, `visible_seconds`, `article_progress` |

Engagement is a reading signal, not proof of completion. It fires at most once per mounted article visit. Hidden tabs, time spent outside the article and long suspended timer gaps do not count. Disabling analytics clears accumulated engagement time. Navigation events use immediate beacon transport. Blog context is attached per event rather than registered globally, so it does not label later app pages as blog visits.

Suggested funnel: article `$pageview` → `blog_article_engaged` → `blog_cta_clicked` → existing `vault_draw_requested` / `vault_pick_launched`. Readers may convert without reaching the engagement threshold, so also inspect the direct pageview to CTA funnel.

Local verification: `node --experimental-strip-types --test lib/blog-analytics.test.ts`. The SDK is mocked, so tests do not add synthetic events to the live project. Production ingestion must be checked after deployment; this work is local only.

SDK reference: [PostHog JavaScript event capture](https://posthog.com/docs/libraries/js/usage).
