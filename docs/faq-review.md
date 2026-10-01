# FAQ review

Reviewed 29 September 2026 against the current local app, including work already present in the checkout. This is a source and local UI review, not confirmation of a production deployment.

The full FAQ now has 18 questions. The landing page keeps five introductory questions. Every previous topic was considered; overlapping questions were combined rather than losing their useful information. Answers use current control names and avoid unnecessary technical detail or dash punctuation.

## Existing full FAQ

| Previous question | Decision and reason |
| --- | --- |
| What is VaultShuffle? | Keep and combine with pricing. Explain the product and that it is free in one answer. |
| How does VaultShuffle pick a game? | Keep. Explain the three choices and the random alternative in plain language. |
| Is it just a random Steam game picker? | Combine with the selection answer. A second explanation of ranking adds little. |
| How do I import my Steam library? | Keep. Include public Game details and hidden playtime, which affect actual imports. |
| Is signing in with Steam safe? | Keep. Explain the access granted without OpenID or API terminology. |
| Do I have to sign in with Steam? | Keep and correct. Public URL access is reusable across devices, does not verify ownership and is available to anyone with that URL. Remove the retired linking promise. |
| What do Session, Mood and Goal mean? | Combine with the selection answer. No separate glossary is needed. |
| What is ruled out before a draw? | Reframe around an empty draw. Use Blacklist, explain the Finish Something requirement and point to Vault Lens. |
| Does VaultShuffle work for Steam Deck, Mac and Linux? | Keep. Clarify that these are compatibility filters and distinguish native Linux support from Proton. |
| Does VaultShuffle support Steam Families? | Keep. Explain where to add profiles, estimated sharing eligibility and unavailable personal playtime. |
| What can I do after VaultShuffle picks a game? | Keep and rewrite around Play now, View on Steam, Save for later, Playing Next, Reroll and Blacklist. Remove retired pin and snooze instructions. |
| Does VaultShuffle learn what I like? | Keep with qualified wording. Personal learning is conditional and does not apply to random draws. |
| Why is a game missing from my library? | Keep and include stale playtime. Give the actual Refresh from Steam menu action and practical checks. |
| Is VaultShuffle free? | Combine with the introduction. Preserve the answer without a separate disclosure. |
| Can I delete my VaultShuffle data? | Keep. Direct readers to Contact and distinguish deletion from signing out. |

## Added questions

| Topic | Why it belongs | Implementation checked |
| --- | --- | --- |
| Returning on another device | Prevents users switching access methods and expecting their choices to transfer. Also explains guest wishlist storage. | `lib/auth.ts`, manual profile creation route, Steam callback, `components/wishlist/useWishlist.ts` |
| Reactivating a game | Makes Blacklist and Complete reversible and distinguishes them from changing Steam ownership. | `components/library/LibraryGameActions.tsx`, Library page and restore action |
| Collections | Explains an entire navigation destination, smart shelves and Collection Draw. | Collections page, `lib/smart-collections.ts`, `lib/vault.ts` |
| Completion and progress | Prevents estimated playtime progress being mistaken for knowledge of the player's save file. | Completion check page, `lib/completion-check.ts`, `lib/game-duration.ts` |
| Wishlist and Steam | Explains discovery, import, separate saves and regional price limitations. | Wishlist page and hooks, wishlist API routes, `docs/wishlist.md` |
| Dashboard value | Prevents store price estimates being mistaken for actual spending or money recovered. | `lib/backlog-stats.ts`, Dashboard page, LibraryOverview and ValueDial |

Account copy was checked against `create_or_resume_manual_profile_session` and the retired secure profile route. Recommendation copy was checked against `lib/vault.ts`, the Vault page, global filters and `components/vault/useGenreLearning.ts`. Family copy was checked against the Family Library component and sharing rules. Deletion guidance follows the existing Contact and Steam Data pages.

## Existing landing FAQ

| Previous question | Decision |
| --- | --- |
| What is a Steam backlog manager? | Make it specific to VaultShuffle and include free access. |
| How does VaultShuffle pick a game? | Keep, removing the 64 game deck implementation detail. |
| How is this different from hitting shuffle on my Steam library? | Combine with how picks work. Use the freed space for device compatibility. |
| Do I have to sign in with Steam? | Keep as a trial question and correct the public URL access explanation. |
| Is it safe to sign in with Steam? | Keep, using the same wording as the full FAQ. |

Both pages still generate their FAQ structured data from their displayed answers. The sitemap dates reflect this content update. Existing disclosure components and page styling are preserved.

## Validation

Type checking and the theme check passed. Full lint passed with no errors and 22 existing warnings outside the changed files. Browser checks at 1440px and 390px verified all 18 full FAQ entries and all five landing entries against their structured data, opened every answer, checked keyboard focus and stationary hover, and found no horizontal overflow or clipped landing answers. Screenshots were visually reviewed with the actual styles loaded from localhost. No application behavior or production data was changed.
