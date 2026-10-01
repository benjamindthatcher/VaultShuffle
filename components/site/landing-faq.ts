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
    question: "What is VaultShuffle, and is it free?",
    answer:
      "VaultShuffle is a free Steam backlog manager and game picker. It helps you choose what to play from your library, organise your games and keep track of what you finish. There is no paid tier or subscription."
  },
  {
    question: "How does VaultShuffle pick a game?",
    answer:
      "Choose your available time, mood and goal, and VaultShuffle picks from games that fit your library filters. A guided draw favours stronger matches and explains the result. For a random pick from eligible games, use Roll the dice."
  },
  {
    question: "Can I try it without signing in through Steam?",
    answer:
      "Yes. Explore guest mode with a sample catalogue, or use a public Steam profile URL to create a VaultShuffle profile for that library. Anyone with that public link can access the same profile. Steam login verifies ownership and uses a separate VaultShuffle profile."
  },
  {
    question: "Does it work with Steam Deck, Mac and Linux?",
    answer:
      "Yes. Device filters help you find games for Steam Deck, Mac and Linux. The Deck filter includes Playable and Verified games; Mac and Linux filters use native support. Check Steam for current compatibility with your setup."
  },
  {
    question: "Is it safe to sign in with Steam?",
    answer:
      "You sign in on Steam's own website. VaultShuffle receives confirmation of your SteamID and reads public profile and library data. It never receives your Steam password or permission to change your Steam account, games or purchases."
  }
] as const;
