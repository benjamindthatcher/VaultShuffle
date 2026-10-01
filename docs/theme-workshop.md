> **Superseded, 28 September 2026:** The user rejected Midnight Iris as too blue and requested the best of the old theme: dark navy background with purple content and panes. [theme-standard.md](theme-standard.md) and `app/theme.css` are authoritative. All three workshop directions below are historical experiments.

# VaultShuffle theme workshop

28 September 2026. **Proposal, not an approved global theme.**

Open `/theme-workshop` on the local development server. Like `/button-lab`, the route returns not found in production. Three presets use the same dashboard content, spacing and component structure. Buttons, arrows and a keyboard-accessible range input switch the whole replica. The URL retains the selection across reloads, for example `/theme-workshop?theme=velvet`.

The fixtures reproduce the existing local dashboard preview: Playing Next, library value, four summary statistics, global filters, family library, value-for-money games and recent completions. Figures are explicitly sample data. Filter chips demonstrate interaction states; they do not recalculate the fixed comparison fixtures. Playing Next and game dialogs use local component state. The workshop does not import the account data provider or mutate a real library.

## Directions

| Role | Midnight Iris | Velvet | Blue Hour |
| --- | --- | --- | --- |
| Ground | `#090e20` | `#140e23` | `#071426` |
| Chrome | `#0d1228` | `#1b132e` | `#0b1b31` |
| Surface | `#171c35` | `#281d3e` | `#142b46` |
| Feature | `#242344` | `#3a2856` | `#24365b` |
| Recess | `#10152c` | `#1d142f` | `#0d2038` |
| Border | `#383f61` | `#57416e` | `#3d5a79` |
| Violet | `#aa8aff` | `#d0a0ff` | `#b8a3ff` |
| Blue | `#729dff` | `#9ea8ff` | `#7abfff` |
| Text | `#f3f1ff` | `#fbf3ff` | `#f0f6ff` |
| Muted text | `#b3b9d1` | `#c7b7d8` | `#b0c5df` |

Midnight Iris was the original recommended starting point: a balanced navy/purple bridge between the public site and product. Velvet is deliberately warmer and more purple. Blue Hour is cooler, with a stronger blue surface hierarchy. These are choices for one global standard, not a proposal to give every page a different theme.

## Site-wide findings

Review covered the route inventory and shared CSS across product, marketing, editorial, information, onboarding and utility pages. Browser spot checks covered Dashboard, Vault, Library, Collections and Wishlist. This is a visual-system review, not an authenticated workflow audit.

| Area | Current inconsistency | Proposed standard |
| --- | --- | --- |
| Global foundation | `globals.css` uses the same `#221543` for surface, soft surface, sheet and card; comments describe conflicting section/sheet models. Product shell adds fixed radial washes. | Define one hierarchy: ground, chrome, surface, feature, recess. Explain nesting once and align comments with implementation. |
| Dashboard | `LibraryOverview` and `ValueDial` use their own hardcoded plum gradients, multiple glow layers and lavender text ramps, outside the shared tokens. | Quiet navy/purple panels, clear secondary text and one restrained feature treatment; keep game art in its native colours. |
| Vault | Draw setup, option groups, pool previews, lens and collection cards each own additional purple/blue gradients and borders. | Reuse the same surface and selection roles; selection remains distinct from hover, with a persistent non-colour cue. |
| Library, Collections, Wishlist | Solid purple game cards sit beside darker toolbars and menus; drawers and filter menus contain their own surface ramps. | Apply the chosen roles to cards, toolbar, popovers and dialogs together. Preserve existing semantic game actions. |
| Playing Next and Finished | These use additional lilac, gold, mint and blue values for statuses, accents and panels. | Separate semantic status colours from structural surface colours. Keep gold for queue actions and mint for completion. |
| Landing page | Near-black navy with blue/violet lighting establishes the brand, but density and panel colour differ from the product. | Share ground, chrome, text and accent roles; allow marketing imagery and composition to remain expressive. |
| Blog, FAQ, releases, legal, Steam Data and contact | Information and editorial modules repeat independent purple-to-navy gradients, often with luminous top edges. | Feature treatment for the lead section; regular content uses the shared surface/recess hierarchy and readable prose. |
| Profile setup, feedback and overlays | Setup art, dialogs and drawer surfaces use independent hardcoded paints. | Carry the same surface, border, text, focus and backdrop roles into overlays and forms. |
| Duration queue and legacy routes | Duration review has another purple ramp. `/stats`, `/purge` and secure-profile are redirects. | Include the internal queue when rolling out; redirects need no theme component. |
| Shared controls | `controls.css` already records approved semantic colours and stationary feedback. Legacy global hover rules still coexist. | Preserve the approved standard. Migrate consumers deliberately, then remove obsolete global overrides only after coverage is established. |

## Proposed global rules

- Ground fills the page; chrome frames it; surfaces contain information; a feature surface marks one leading block; recesses hold inputs or nested content. Section headings usually remain on the ground rather than inside another box.
- Use opaque, named text colours rather than stacking opacity on text and parent containers. Normal text should meet 4.5:1 against its actual surface; non-text focus/selection cues should remain visibly distinct.
- Keep existing sans-serif typography. Use a small hierarchy: 22–28px page titles, 17–18px section titles, 13–14px body, and 11–12px supporting metadata. The workshop deliberately keeps the compact dashboard density.
- Use 14px panel radii, 12px cards, 10px controls, 8px image wells, 24px panel padding and 24–30px section gaps as starting values. Mobile reduces padding, not control usability.
- Reserve violet for primary identity, action and selection. Blue supports information. Steam blue, gold, coral and mint keep the meanings in [button-standard.md](button-standard.md).
- Retain the original horizontal navigation and profile pill. Mobile navigation can scroll with readable spacing.
- No moving labels, lifting cards or press scaling. Reuse `app/controls.css` for sheen, inset press, focus, selection, disabled states and reduced motion.

## Implementation boundaries and rollout

All candidate paint is scoped to `app/theme-workshop/theme-workshop.module.css`. Palette data and sample fixtures live in `themes.ts`. The original workshop isolated its styles and account behaviour; the subsequent rollout uses the restored purple palette through shared production tokens. The outer site footer remains the existing shared footer; the candidate scope covers the dashboard replica, navigation and local game dialog.

“Export theme CSS” downloads a proposed mapping to existing `--vault-*` token names. It is a starting palette, **not a complete migration**: hardcoded gradients, derived selection values, overlay backgrounds and remaining text values must be migrated before global application.

After a direction is selected: refine the dashboard; approve the role mapping; migrate shared primitives and overlays; then migrate the remaining product, marketing and information pages. Check hover, focus, selection, disabled/loading, empty, error, mobile and reduced-motion states in each family. The subsequent user correction superseded Midnight Iris with the restored purple palette.

## Concept interpretation

The generated Midnight Iris reference informed the surface hierarchy, restrained ring, filter grouping and palette strip. The implementation intentionally preserves the repository's original brand/header, compact horizontal Playing Next layout, landscape game artwork and actual sample figures instead of the concept's invented logo, portrait artwork and altered numbers. These choices follow the request to replicate the existing dashboard and the approved button/navigation standard. The workshop adds direction descriptions, export and an expandable audit to support comparison.
