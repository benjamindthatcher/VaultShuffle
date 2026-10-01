# VaultShuffle button standard

Updated 28 September 2026, incorporating the user's decisions in **Button redesign** and the later **Update landing page preview flow** task (`01a0cdf5-16e9-7721-b31d-761a3a4b0c4f`). This is the shared reference for future button work across the repo.

Use this guide and [app/controls.css](../app/controls.css) when migrating a page. The landing page is the refined reference implementation. `/button-lab` remains a playground and can contain earlier experiments; those experiments must not override the accepted direction below. Update this guide when the user approves a new shared direction.

## Core feel

Buttons respond through colour, light, borders and inset shading. **The button, label and ordinary icons stay stationary on hover and press.** No bounce, upward lift, translation, scale-down press or sliding arrows. Decorative light may travel across the surface; a loading spinner may rotate and a disclosure chevron may indicate expanded state.

Use the approved [VaultShuffle Purple surroundings](theme-standard.md) and distinct semantic colours. A global standard means consistent meaning and interaction, not identical dimensions everywhere. Preserve useful component layout, typography and spacing while sharing the control treatment.

## Filled actions: meaning determines colour

All five variants below receive the full primary-style gradient, sweep and inset press. Gold, coral and mint are actions in their own right; do not flatten them into subdued secondary buttons merely because their hue differs from purple.

| `data-vault-control` | Meaning and examples | Resting gradient colours → settled hover fill |
| --- | --- | --- |
| `primary` | VaultShuffle/general action: Draw from Vault, Reroll, Try guest mode, preview-banner Create profile | Violet/indigo `#934ee9`, `#7535d8`, `#514ac9` → solid violet `#783abb` |
| `steam` | Steam-related entry or launch: Continue with Steam, Use profile URL, Play now | Steam blue `#1d587e`, `#1a4b6f`, `#173e60` → solid navy `#142b49` |
| `play-later` | Save for later / add to Playing Next | Warm gold `#f4c56a`, `#e6ae59`, `#d79748` → deep gold `#86551e` |
| `blacklist` | Blacklist / exclusion | Coral `#ff9aa7`, `#ee7f92`, `#dd647d` → deep coral `#a93e57` |
| `success` | Complete / completion or success action | Mint `#91e3bc`, `#6fccad`, `#4db59e` → deep green `#237254` |

These are the current shared CSS values, not a separate palette proposal. Reuse the stylesheet instead of copying gradients into each module. `amber` remains a legacy variant; use `play-later` for new or migrated queue actions.

- Start with a visible gradient within the action's colour family. Sweep **left to right**, settle into a **fully solid** fill while hovered, then smoothly return on pointer exit. Prism must finish fully violet, not retain an indigo stripe.
- All five coloured actions share direction, gradient layout and timing. Do not substitute a centre-out fill for one colour.
- Gold, coral and mint finish noticeably darker. Preserve their brighter resting colours: darkening the entire resting button was an explicitly rejected interpretation.
- Steam starts blue and finishes navy. Avoid a grey/charcoal resting surface or a brighter blue hover endpoint.
- Purple and Steam have white text. Gold, coral and mint have dark text at rest and white text on hover. Check that nested labels and icons remain legible and do not retain conflicting legacy colours.
- Current shared timing: background position 400ms, travelling light 600ms, colour 180ms, border/shadow 220ms, press 80ms. The gradient uses `250% 100%` background size and a solid endpoint from the 48% stop. Keep these rules shared so variants stay synchronised.

**Preview banners:** “Create profile” always uses the standard violet `primary` treatment on every page. `GuestPreviewNotice` owns this rule; do not introduce page-specific secondary overrides.

## Supporting controls also get feedback

| Variant | Use | Interaction |
| --- | --- | --- |
| `secondary` | Supporting actions, including Roll the dice, Edit and Refresh | Narrow lavender sheen travels left to right; richer violet hover fill, luminous rim and soft glow; inset press |
| `tertiary` | Quiet alternatives, Undo, Dismiss | Soft surface tint and expanding underline; shorter, brighter underline on press |
| `text` | Inline navigation | Underline response without full button sizing |
| `disclosure` | FAQ and collapsible headings | Soft surface response, inset press and internal focus ring; expose expanded state |
| `selection` | Session, mood, goal and filter choices | Restrained hover; persistent violet selected surface and a non-colour selected cue |

Secondary buttons keep their quiet outlined resting face. Their satin sheen travels across in 650ms, leaving a solid muted violet hover fill (`#4b2d70`), a pale lavender edge (`#dcc0ff`) and restrained glow. It returns on pointer exit; only the decorative sheen moves. This replaces the earlier top-centred bloom. Press hides the sheen and adds inset shading; reduced motion removes the moving sheen while retaining immediate colour feedback.

The secondary treatment and tertiary underline remain distinct from the stronger filled primary actions. The five semantic filled variants still share their own matching gradient layout and timing.

Inline links that need prominence use `data-vault-control="text" data-control-emphasis="strong"`: brighter ink and a visible resting underline that expands on hover. Keep any directional arrow stationary. This is the landing preview's inline “Try guest mode” treatment.

## App navigation

**Original navigation retained, 27 September 2026:** The user clarified that they want the original navigation from before the navigation redesigns. Restore and preserve that original header styling, including the profile pill. The experimental subtle-glow treatment and Violet tile (option 2) are not approved for the app. Keep alternatives in Button Studio until explicitly selected.

The original header is implemented in [AppHeader.module.css](../components/app-shell/AppHeader.module.css), with routing and semantics in [AppHeader.tsx](../components/app-shell/AppHeader.tsx). Navigation is its own family; do not apply a filled action-button variant to the app's destination links.

- Rest: the existing muted text colour on a transparent surface.
- Hover: brighter text and the original faint violet background tint; labels stay stationary. No experimental hover underline or filled tile.
- Current page: the original rounded violet gradient underline and its existing shadow, 5px on desktop and 3px on mobile. Retain `aria-current="page"` and parent-route indication for nested routes.
- Guest/profile pill: the original dark outlined pill and inset highlight. Preserve its native menu behaviour and keyboard access.
- Preserve the original responsive geometry. Future proposals must be compared against this original header in context before rollout.

The studio remains an interactive state comparison; the app header uses real route links and account actions.

## Choices: Short / Evening / Weekend and similar

These are selection controls, not primary/secondary/tertiary commands. Use `selection` and `aria-pressed` for the existing button-based choice groups.

Vault choices use `data-control-hover="secondary"` alongside `selection`: the same satin sweep, lavender edge and violet hover fill as secondary buttons, while preserving persistent selection. Draw-mode tabs use `aria-selected`; genre chips and draw modes use the inset bar indicator. Session/mood/goal choices retain their existing selection check and step summaries. Hover styling must never replace the selected-state semantics.

- Unselected: dark, calm surface, visible border and restrained hover illumination.
- Selected: persistent violet fill, stronger edge, white label and clear checkmark. This state survives pointer exit and differs visibly from hover.
- Dashboard global filters are an explicit exception to the checkmark: the user requested no ticks. Use `data-control-indicator="bar"` with `selection` for a persistent inset bottom marker and violet selected surface. Keep `aria-pressed`, fixed label positions and the live filtered count. This also applies to the dashboard's exclusion chips.
- Wishlist recommendation filters also use the inset bar with no ticks. Size desktop filters to their text with balanced horizontal padding; the saved wishlist shares the three-column card grid.
- Reserve space for selection marks so labels do not jump. Keep icons recognisable and labels readable at compact widths.
- The open question should command attention. Completed steps collapse into editable summaries showing the selected value plus a checkmark; unanswered summaries consistently say “Choose one”.
- Closed sections stay dark and quiet rather than becoming large purple slabs. Violet emphasises the active question and selected options.
- In the landing flow, an answer collapses its step and advances to the next; the final answer moves focus to Draw from Vault. Preserve editing via the disclosure heading.

Landing-specific sizing: option tiles have a 56px minimum height on desktop (`min-width: 720px`) and 64px on smaller screens; summary headings have a 62px minimum. The accepted desktop change reduced the original 64px by 12.5%; an earlier 88–96px enlargement was rejected. These contextual dimensions are not a requirement to shrink every choice across the app.

## Loading, disabled and completed states

Dashboard game cards use `data-vault-card="interactive"` for a restrained travelling sheen, richer violet hover surface, pale edge and inset press. For a transparent button covering a card, put `data-vault-card-trigger` on that button; never give it an action-button fill. Keep artwork, labels and card geometry stationary. Completion-history rows use the same treatment, with keyboard focus and reduced-motion support. Family Library uses a secondary Re-check action, primary Add person action, quiet coral removal affordance and an explicit coral confirmation. Show the spinner only on the operation currently running, and disable conflicting actions until it finishes.

A changed label alone is insufficient loading feedback. An asynchronous action should set `aria-busy="true"`, show a meaningful progress label and the shared `data-control-spinner`, prevent repeat activation, and use the muted busy surface and wait cursor. Suppress the decorative sweep. Use native `disabled` for action buttons during the operation; `aria-busy` alone does not disable anything. Expose the outcome or error and restore the appropriate state when the operation ends.

The landing Play now preview changes to **“Launching steam”**, swaps the Steam icon for a spinner and disables repeat activation. Steam keeps a muted navy busy surface. Reroll uses **“Drawing…”**. Keep the layout stable across text/icon changes and preserve status text when reduced motion stops the spinner.

Disabled, busy, selected and completed are different states. A locked choice that opens an explanation remains operable and explains its requirement.

Use **“Save for later”** for the action and **“Playing Next”** for queue membership. Do not call queue membership game completion or automatically turn it into a mint completion button. The interactive landing draw replaces Save for later with a non-interactive Playing Next status after saving. The smaller worked-example card demonstrates a local toggle instead; preserve each context's actual behaviour.

In the interactive landing draw, Blacklist excludes and replaces the game and offers Undo; Reroll preserves the chosen draw mode. A visual migration must preserve these behaviours and their feedback.

## Icons and layout

- Reuse existing icon components. Playing Next uses the next-track symbol (`ActionIcon kind="next"`); Blacklist uses the minus inside a rounded square (`ActionIcon kind="blacklist"`). Do not restore the old pin/moon icons for these actions.
- Steam uses the Steam mark. The landing Play now action does not need an additional external-link icon.
- Pair semantic colour with a clear label/icon; colour alone must not communicate meaning or state.
- Both landing Steam entry buttons have matching height, left padding, icon alignment, label alignment and chevron placement. Both use `steam`, including Use profile URL even though its first destination is internal. Guest entry uses `primary`, not tertiary.
- The hero currently uses 50px minimum-height entry buttons and a centred guest CTA at 54% width, with a minimum width constrained to fit its container. This compact composition is specific to the hero, not all CTA groups.
- Keep helper copy readable and close to its action. The guest prompt, button and explanation form one group.
- Draw from Vault is the prominent violet action, with the secondary **Roll the dice** action below. Avoid a second heavy purple box around the button that competes with it.
- Align and size actions consistently within each group. Stack result actions at narrow widths without clipping labels or horizontal overflow.

Landing recommendation controls are interactive demonstrations: Steam launch is simulated and save/blacklist changes stay in preview state. Preserve that boundary. Do not carry simulated behaviour or relaxed preview access rules into real product actions.

## Implementation contract

[app/controls.css](../app/controls.css) is imported by [app/layout.tsx](../app/layout.tsx). The shared treatment applies site-wide: annotate actual controls with `data-vault-control`. Existing `data-vault-controls="standard"` page markers may remain but are no longer needed to activate it.

```tsx
<main data-vault-controls="standard">
  <button type="button" data-vault-control="primary" onClick={draw}>
    Draw from Vault
  </button>
  <button type="button" data-vault-control="play-later" onClick={save}>
    <ActionIcon kind="next" /> Save for later
  </button>
  <button type="button" data-vault-control="selection" aria-pressed={selected} onClick={select}>
    Evening
    <span aria-hidden="true" className={styles.checkSlot}>{selected ? "✓" : ""}</span>
  </button>
</main>
```

This is an attribute sketch; use existing component geometry and reserve checkmark space in the component's CSS.

- `body [data-vault-control]` reaches annotated shared footers and portalled dialogs on every route. Check shared surfaces whenever editing controls.
- Component CSS owns layout and typography; shared CSS owns colour, interaction and focus. Default minimum height is 44px and default radius is 10px, with variant exceptions. Use `--control-min-height` and `--control-radius` for deliberate contextual sizing; a plain lower `min-height` may lose to the shared selector.
- Use links for navigation and buttons for actions. Preserve destinations, analytics, form semantics and handlers.
- Icon-only buttons use `data-control-size="icon"` and an accessible label. Absolutely positioned close buttons also use `data-control-position="floating"`.
- Non-interactive examples use non-interactive markup and, if styled as a control, `data-control-static="true"`. A working demo is not static merely because it does not persist data.
- Never annotate a modal backdrop. Preserve full-card artwork and click-target geometry.
- Shared paint rules currently use `!important` to bridge legacy global hover overrides. Avoid competing page-specific hover systems; remove legacy blanket rules only after their remaining consumers have migrated.

## Verification and rollout

- Inspect rest, early hover, settled hover, pointer exit and held press. Confirm the correct solid endpoint and no button/label movement.
- Check supporting controls, disclosures, selections and icon buttons as well as primary CTAs. Include dialogs, footer and saved/loading/error states where present.
- Check keyboard focus and activation. The shared focus ring is 2px pale violet with a 3px offset; disclosures use an internal ring. Keep it visible and unclipped.
- Check mobile/touch layouts, long labels and loading labels. Maintain usable targets, normally at least the shared 44px size; inline text links have a separate treatment.
- Respect `prefers-reduced-motion`: no animated sweep, transitions or spinning loader. Hover animation only applies to hover-capable devices; touch users must not depend on it.
- Check actual text/icon contrast at rest, during transition, on hover and while busy, including helper text. These palette values are not a blanket accessibility certification.
- Verify action outcomes and relevant existing checks. [e2e/landing-preview.spec.ts](../e2e/landing-preview.spec.ts) covers draw/reroll, queue status, blacklist/Undo, mobile layout and preview isolation.
- Work locally and migrate page by page unless the user requests a broader rollout. A local preview request does not include deployment.

## Reference files and existing coverage

- [Shared controls](../app/controls.css): palette, animation and state rules.
- [Landing CTAs](../components/site/LandingCtas.tsx) and [layout styles](../components/site/landing-experience.module.css): Steam/profile/guest grouping.
- [Interactive landing draw](../components/site/LandingVaultDraw.tsx): selection progression, action states and preview behaviour.
- [Worked example](../components/site/LandingResultDemo.tsx): compact semantic actions and loading demo.
- [Choice component](../components/vault/VaultOptionGroup.tsx) and [choice styles](../components/vault/VaultOptionGroup.module.css): selection/disclosure roles and contextual sizing.
- [Action icons](../components/library/LibraryGameActions.tsx): shared queue and Blacklist symbols.

Landing coverage includes hero/closing CTAs, worked-example actions, guided/quick draw, choices, FAQ controls, inline links, footer and annotated dialogs. Dashboard coverage includes entry links, Playing Next controls, View library, filters, Family Library actions, completion-history disclosure and detail-drawer actions. VaultShuffle Purple now supplies the global structural palette. Inspect the current route and its shared components when extending interaction coverage.

Vault coverage includes setup choices, genre filters, draw-mode tabs, collection picker, Lens/History controls, pool cards, removable filters, result actions, Undo/Dismiss and guest prompts. Supporting tools use secondary; quiet recovery and menu actions use tertiary. Preserve the actual draw, save, launch, blacklist and Undo behaviour. Keep pool arrows inside the rail's clipping boundary and small artwork controls on opaque surfaces. The Vault deck has no three-dot menus; open a game for its details and actions. Gold/coral result labels, icons and helper text inherit the parent control colour so they remain readable through hover.

Library coverage includes status tabs, Filters/Sort/Select, sort direction, grid/list switches, filter choices, game-card details, semantic card and bulk actions, drawer actions and completion/Undo feedback. Use secondary satin hover for toolbar actions and selection choices. Tabs and progress/length choices retain an inset selected bar; multi-select genres retain a check. The library view switch is one secondary button showing the destination view (List or Grid); clicking alternates the layout. Keep its width stable between states and let the desktop search field take the freed space. Reverse sort and the sort dropdown form one joined control under the Sort label, with a shared divider and separate accessible targets. Sort options preserve listbox keyboard navigation and a visible focused option. Card details use the shared interactive-card treatment without moving artwork or labels; keep action buttons separate. Preserve selection checkboxes, counts, search/sort/filter behaviour and local preview boundaries.


Collections coverage includes collection cards and their persistent Selected label, create/edit/delete actions, ready-made shelves, carousel arrows, and the Add Games dialog. Selection and hover are distinct; asynchronous saves show the spinner only on the action in progress.

Wishlist coverage includes Steam imports/store links, search, recommendation choices, saved toggles, shuffle/retry/load-more controls and the guest banner. Store destinations use Steam blue, supporting actions use secondary, and choices retain `aria-pressed` plus a visible selected cue. Pending feedback belongs to the specific import, save or load operation.

All footer destinations (Blog and articles, FAQ, Releases, Privacy, Terms, Steam Data and Contact) opt into the shared controls via `SharedInformationShell`. Document disclosures retain native details/summary behaviour. Blog CTAs use primary/secondary and post cards use stationary interactive-card feedback. Contact uses primary Send, secondary Feedback and inline Analytics Settings uses text. Preserve readable inline prose links without imposing button dimensions.

The account dropdown uses Steam blue for sign-in, secondary for Create profile and Refresh, and a quiet coral Sign out. Preserve the original profile pill and main navigation. Loading refreshes have a spinner and cannot be activated twice.

### Vault refinements, 27 September 2026

- Playing Next appears for both live accounts and guests with saved games. Queue membership outranks global filters.
- Steam actions are a joined full-width footer on Playing Next cards: square top corners, rounded bottom corners, no gap. Set `--control-radius` in component CSS so the shared default cannot detach the action visually. Keep desktop Play now and store-link fallback behaviour.
- Session, Mood and Goal cannot close themselves. Selecting a choice advances to the next unanswered step, then Genre filters. Until all three choices are selected, one required step must remain open even when optional filters are opened or closed. Filters alone may close; reopening a required step keeps it open until another step is chosen. Restored completed setup keeps its answers but starts on Session with filters closed. Restored incomplete setup opens the first unanswered question. Filters opens automatically only after a choice completes the setup, or when explicitly opened.
- Keep Vault Draw / Collection Draw, Vault Lens / Draw History, and the stacked Draw from Vault / Roll the dice actions together inside one pane, matching the live layout. Actions sit on the right on desktop and stack inside the same pane on mobile.
- The quick-draw action is **Roll the dice**, using `secondary`, never tertiary.
- The Vault deck does not show three-dot action menus.
- Vault result actions use two rows of two: Steam and Save for later above Reroll and Blacklist. Keep the compact match reasons and spacing.


## Card and image-pane hover standard — 28 September 2026

Use the shared paint in `app/controls.css` for image panes as well as buttons. Hover adds a restrained left-to-right sheen, a pale lavender edge and a muted violet surface. The pane, image, label, icon and arrow stay fixed: no lift, tilt, zoom or image brightness filter. Reduced motion removes the travelling sheen while retaining colour feedback. Disabled cards do not sweep.

- `data-vault-card="interactive"`: a real clickable card or card action. Preserve native button/link semantics, keyboard focus, inset press and any persistent selection cue. For a transparent full-card overlay, use `data-vault-card-trigger` on its button.
- `data-vault-card="surface"`: an informational image pane or card. It shares the hover paint but gains no button role, tab stop, pointer cursor or press behaviour. Collections' game articles and the landing recommendation-flow steps are examples.
- Apply the treatment once at the appropriate enclosing pane, not to every nested thumbnail. Keep artwork aspect ratio, crop, labels and overlays intact. Do not annotate a bare image: its wrapper owns the sheen pseudo-element. Reserve `::after` for that sheen; retain existing masks on `::before` or a dedicated layer.
- Selection remains visible after pointer exit. Collection selectors keep their Selected label/bar, and Add Games tiles retain their selected check. Hover is not selection.
- Plain logos, avatars, decorative backgrounds, article covers and game-detail artwork that has no hover affordance can remain neutral. Do not turn them into fake actions.

### Page audit coverage

| Surface | Shared treatment / decision |
| --- | --- |
| Landing | Stationary recommendation-flow steps; worked-example and drawn-game image panes; action colours preserved |
| Dashboard | Value cards, recently finished, completion-history rows and Playing Next use interactive cards |
| Vault | Deck/history cards and Playing Next use interactive cards; result image uses surface; Roll the dice is secondary |
| Library | Grid/list details use interactive cards; artwork stays fixed; detail drawer remains neutral |
| Collections | Collection selectors and Add Games tiles use interactive cards; game articles use surface (previously missed) |
| Wishlist | Clickable cards use interactive feedback and open the Library-style details popup; store and save buttons retain their own interactions |
| Completion check | Stationary rows, keyboard checkbox outline and persistent selection; mint Finished, secondary Not yet, operation-specific bulk spinners and shared empty-state actions |
| Blog / articles | Post links use interactive cards; editorial game picks use surface; covers and table thumbnails stay neutral |
| FAQ / Releases / Privacy / Terms / Steam Data / Contact | Shared disclosures and actions; no image-card hover to migrate |
| Profile setup | Steam-blue library lookup, violet profile creation / enter Vault, tertiary profile switching and explicit busy spinners; decorative artwork stays neutral |
| Legacy Stats / Purge / Play Next | Redirects to current pages; no separate rendered card surface |
| Duration review | Internal review artwork has no hover behaviour; remains neutral |
| Button Studio | Approved buttons and image-pane section uses the actual shared CSS; earlier directions remain experiments |

Audit route consumers and reusable components together when making future changes. In particular, Collections' static `GameCard` articles differ from clickable Library cards. A page-level no-transform override alone is insufficient: the pane must receive the shared hover treatment.

Shared recovery controls also follow this standard: Steam import retry/resume uses Steam blue with operation-specific busy feedback; its completed handoff uses primary Choose what to play and secondary library cleanup. Cooldown dismissals use a tertiary icon target and never show a loading spinner while merely waiting. Shared carousel arrows use secondary icon buttons. Completion-review banners use interactive-card feedback.
