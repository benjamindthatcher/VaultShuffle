# Publishing blog posts

The article registry is `lib/blog/posts.ts`; publication dates and draft flags
live in `lib/blog/schedule.ts`. Set `published` to a date in `YYYY-MM-DD`
format. It becomes eligible at midnight UTC on that date. Leave `draft: true`
only while a post must remain unpublished regardless of its date.

The next Steam game guide is scheduled for **28 September 2026 at 00:00 UTC**,
which is **01:00 British Summer Time**. It can be deployed beforehand.

Production excludes future posts from the blog index, related links, sitemap
and generated article pages. A direct request returns not found until the date
arrives. A lightweight request gate returns an uncached 404 before the
article route cache, so its `noindex` metadata cannot remain cached after
launch. Published articles still use ISR. Development shows a labelled preview with `noindex`.

The blog index, article pages and sitemap use hourly, request driven Next.js
revalidation. Publication does not require another deployment. A cached page
may briefly show its previous version on the first request after the cache
window expires while regeneration runs. This is a date based publishing
schedule, not a promise of an exact second launch.

Before release, run `node --experimental-strip-types --test lib/blog-*.test.ts`
and verify production pages omit the future post. The publication tests cover
both sides of the scheduled boundary and protection for explicit drafts.

Article metadata includes a canonical URL, description, author, social preview,
BlogPosting and breadcrumb structured data. Publication dates become visible
only once the article is public. Related links and sitemap entries follow the
same publication rules. Keep headline, description and page content consistent.

After changing a headline or adding a post with a `socialImage`, regenerate the
committed share cards with `node scripts/blog/render-social-images.mjs`.
