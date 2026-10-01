# VaultShuffle Purple: required VaultShuffle theme

The user’s revised direction on 28 September 2026 is authoritative: **dark blue background; purple content and panes**, using the strongest version of the previous theme. Midnight Iris was rejected as too blue. This standard restores the old purple surface ramp across the entire site. Future UI work must follow this standard and the [button standard](button-standard.md).

## Landing-page exception

The user subsequently approved the new theme but asked to restore the landing page's previous appearance. The saved pre-rollout styles in `components/site/landing-experience.module.css` and `components/site/landing-vault-draw.module.css` are authoritative for the landing page. They retain the original dark panels, violet/blue lighting, gradients and text treatments. The landing root scopes its previous inherited palette for shared preview components. Preserve existing content, preview interactions and semantic action behaviour.

These two CSS modules are explicitly exempt from the raw-colour check; this is a user-requested restoration, not permission to introduce private palettes elsewhere. Shared chrome, dialogs and every other route keep VaultShuffle Purple. Do not remove this exception during future theme migrations unless the user requests it.

## Sources of truth

- `app/theme.css` owns the global palette and derived roles, imported by `app/globals.css`.
- `app/controls.css` owns shared control states and the previously approved semantic action gradients.
- `lib/theme.ts` mirrors the foundation for metadata, generated social images and the development workshop; `npm run theme:check` verifies parity.
- The development-only theme workshop retains alternative proposals for comparison. They must not leak into production styling.

## Colour roles

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Ground | `--vault-ink` | `#050716` | Page canvas |
| Chrome | `--vault-chrome` | `#080c20` | Navigation, framing |
| Surface | `--vault-surface` | `#221543` | Cards, panels, menus and dialogs |
| Feature | `--vault-feature-surface` | `#2c1b57` | Leading summary or highlighted panel |
| Recess | `--vault-well-surface` | `#120a24` | Inputs, nested content and artwork wells |
| Border | `--vault-border` | `#3a2866` | Quiet structural divisions |
| Lavender | `--vault-accent` | `#c9a6ff` | Readable emphasis, focus and active states |
| Blue | `--vault-accent-blue` | `#729dff` | Supporting information |
| Text | `--vault-text` | `#f5f1ff` | Primary text |
| Muted | `--vault-text-muted` | `#c4b5dd` | Secondary text and metadata |

The original saturated brand purple (`--vault-brand-violet`, `#a855f7`) is for decorative brand details; lavender keeps small text readable. Blue is reserved for supporting information and semantic Steam actions, never the fill of ordinary content panels.

Use `--vault-feature-gradient` for restrained feature panels and `--vault-brand-gradient` for brand details. Use `--vault-overlay` and `--vault-elevation-shadow` for overlays; dialogs still use an opaque shared surface. Do not create a new purple ramp or radial wash per component. Section headings usually sit directly on the page ground; avoid enclosing every nested group in another feature panel.

Use `--vault-selection-surface` and `--vault-selection-hover` through the shared selection controls. Selection persists after hover and includes the existing checkmark or inset bar. Disabled, busy, selected and completed states remain distinct. Focus uses `--vault-control-focus`.

Semantic colours retain meaning: Steam blue for Steam actions, gold for Playing Next, coral for exclusion/errors and mint for completion/success. Use the `--vault-success`, `--vault-warning` and `--vault-danger` status roles. Filled action gradients remain in `controls.css`; this is the deliberate exception to the foundation palette. Game artwork, screenshots and existing brand image assets retain their native colours.

## Layout and behaviour

Preserve the compact product density and existing typography. Default starting geometry is 14px panels, 12px cards, 10px controls and 8px artwork wells; contextual responsive dimensions can differ. Keep spacing consistent within each group. Reduce padding on mobile without making controls unusable.

Retain the original horizontal app navigation, active underline and profile pill. At narrow widths the navigation can scroll horizontally with readable labels. Buttons, labels and cards remain stationary on hover and press. Shared controls supply sheen, inset press, focus and reduced-motion behaviour. Do not add local brightness filters, lifted cards or scaled press effects.

Normal text must meet 4.5:1 against its actual background. The check validates the four foundation text/accent roles on all five opaque surfaces; opacity, gradients, artwork and semantic control states still need visual/contrast review. Avoid reducing opacity on supporting text or its parent.

## Implementation and enforcement

Use `var(--vault-…)` in CSS, including `color-mix()` for a restrained decorative tint. Component styles own geometry and typography, not a private palette. Do not redefine foundation tokens inside a component. Use `VAULT_THEME` only in renderers that cannot consume CSS variables, such as manifest metadata and the generated Open Graph image.

`npm run theme:check` scans production app/component CSS and literal JSX paint, rejects raw colour values and foundation overrides, verifies the metadata mirror and checks foundation text contrast. It is also part of `npm run lint` and therefore `npm run check`. Only the canonical theme, approved semantic controls, the two restored landing-page modules and isolated development experiments are exempt. Do not expand those exceptions to bypass a failure.

The rollout covers product pages (dashboard, Vault, library, collections, Playing Next, wishlist and finished), editorial/information pages (the landing page has the explicit exception above), contact and setup forms, duration review, shared headers/footers, menus, drawers, dialogs and loading/error components. Redirect routes inherit the destination theme.

For future changes:

1. Read this document and the button standard before editing visible UI.
2. Choose an existing semantic role. If a new role is necessary, define and document it centrally rather than adding a literal colour to a component.
3. Run `npm run theme:check`, typecheck and lint. Verify affected pages on desktop and mobile, including open menus/dialogs, focus, selection, loading and reduced motion where relevant.
4. Keep theme work separate from account data and action behaviour. A local styling change does not authorize deployment.
