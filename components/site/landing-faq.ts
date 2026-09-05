/**
 * The landing page FAQ.
 *
 * One source for two consumers: the markup in LandingFaq and the FAQPage
 * JSON-LD on the landing page. Keeping them in the same array is the only way
 * the structured data cannot quietly drift from what a visitor actually reads,
 * which is the thing Google penalises.
 *
 * Answers are plain strings rather than nodes, because JSON-LD needs text. If
 * an answer ever needs a link, send the reader to a page that has one instead.
 */
export type LandingFaqItem = { question: string; answer: string };

export const LANDING_FAQ: readonly LandingFaqItem[] = [
  {
    question: "What is a Steam backlog manager?",
    answer:
      "A Steam backlog manager helps you organise the games you own and decide what to play next. VaultShuffle imports your public library, lets you track game statuses and collections, and suggests a game based on your available time, mood and goal."
  },
  {
    question: "How does VaultShuffle pick a game?",
    answer:
      "VaultShuffle applies your filters and game statuses, then ranks eligible games using your session, mood, goal and game data. A guided draw builds a deck of up to 64 matches and makes a weighted choice from the strongest candidates, with reasons shown alongside the result."
  },
  {
    question: "How is this different from hitting shuffle on my Steam library?",
    answer:
      "A guided draw ranks games before choosing one. Your filters and saved statuses determine what is eligible, while session, mood and goal help decide what fits best. It favours stronger matches without giving you the same result every time."
  },
  {
    question: "Is VaultShuffle free?",
    answer:
      "Yes. VaultShuffle has no paid tier, subscription or payment-card requirement."
  },
  {
    question: "Do I have to sign in with Steam?",
    answer:
      "No. Try guest mode with a sample library, or import a public Steam profile using its URL, custom profile name or SteamID. Public-profile imports save your choices in a separate VaultShuffle profile accessed through this browser's session. Steam sign-in verifies that the Steam account is yours."
  },
  {
    question: "Is it safe to sign in with Steam?",
    answer:
      "Sign-in happens on Steam's website through OpenID. VaultShuffle receives confirmation of your SteamID and reads public profile and library data. It never receives your Steam password, payment details or permission to change your Steam account."
  }
] as const;
