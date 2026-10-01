<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Required site theme: VaultShuffle Purple

Before creating or changing any visible UI, read [docs/theme-standard.md](docs/theme-standard.md) and use [app/theme.css](app/theme.css). Use the previous purple surface ramp: dark navy page background, distinctly purple content panels and plum recesses. Midnight Iris was rejected as too blue. VaultShuffle Purple is the required standard for the entire site, including public pages, product pages, forms, overlays, loading/error states and metadata. Reuse named theme roles; do not add page-specific palettes, hardcoded UI colours or override the foundation tokens. Keep game artwork in its native colours. The workshop alternatives are experiments, not production themes.

Run `npm run theme:check` after UI changes (also included in lint). Check the affected UI on desktop and mobile, including focus, hover and selected states. Shared semantic action colours and stationary controls remain governed by the button standard below.

## Landing-page exception

The user explicitly restored the original landing-page presentation after approving the new theme elsewhere. Preserve the pre-rollout styling in `components/site/landing-experience.module.css` and `components/site/landing-vault-draw.module.css`; their local palette is an approved exception to the global colour rule. Keep the exception scoped to the landing page. All other routes and shared chrome retain VaultShuffle Purple. Do not migrate the landing page back to the app palette without a new user request. Shared semantic button behaviour still follows the button standard.

## VaultShuffle buttons and interactive controls

Before creating or changing buttons, links styled as actions, selection chips, disclosures, or card/image-pane hover effects, read [docs/button-standard.md](docs/button-standard.md). It records the approved landing-page refinements and shared colour, motion, loading, selection, and stationary surface-hover rules. Reuse `app/controls.css`; keep buttons and labels stationary on hover and press, and keep all pages aligned with the shared VaultShuffle Purple theme.
