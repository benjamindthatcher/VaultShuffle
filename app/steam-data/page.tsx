import type { Metadata } from "next";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Steam Data", description: "What Steam data VaultShuffle syncs, how it is used, and how to request corrections or deletion.", alternates: { canonical: "/steam-data" }, openGraph: { url: "/steam-data" } };
export default function SteamDataPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Data · Updated 25 July 2026"
        title="Steam Data"
        intro="This page describes the Steam information VaultShuffle requests, how each field is used, and what can prevent a complete sync."
        sections={[
          {
            title: "Sign-in data",
            body: "Steam OpenID confirms your SteamID and returns you to VaultShuffle after authentication. We may then read public profile details such as display name and avatar. Steam handles your credentials directly; VaultShuffle never receives or stores your Steam password."
          },
          {
            title: "Owned library fields",
            body: "For each visible owned app, Steam may provide an app ID, title, total playtime and last-played timestamp. VaultShuffle combines those fields with store and catalogue metadata such as genres, artwork, release information, pricing and estimated duration. Your own status, notes, progress, pins and collections are VaultShuffle data rather than Steam data."
          },
          {
            title: "What the data powers",
            body: "App IDs identify games consistently. Total playtime and last-played timestamps power Library sorting, recent activity, Purge eligibility and progress estimates. Genres, duration and your Session, Mood and Goal choices help narrow Vault draws. Store metadata supports artwork and wishlist price displays."
          },
          {
            title: "Privacy settings and missing games",
            body: "Steam can only return fields available through your account's privacy settings and its APIs. Private game details, family-shared titles, removed apps, demos, tools, dedicated servers or test applications may be absent or deliberately quarantined. A sync can therefore differ from the desktop Steam client."
          },
          {
            title: "Refreshes and corrections",
            body: "VaultShuffle refreshes changing metadata periodically and may refresh your owned-library data after sign-in or a manual sync. Steam remains the source for owned-game playtime and last-played values. If a Steam value is wrong, first confirm it in Steam; if VaultShuffle has not caught up, sign in again or contact support."
          },
          {
            title: "Deletion and disconnection",
            body: "You can stop further Steam syncing by signing out and not reconnecting. To request deletion of your VaultShuffle account, Steam identifiers, library copy and associated preferences, contact support@vaultshuffle.com or use Contact Us. Deleting VaultShuffle data does not alter your Steam account."
          },
          {
            title: "Independent service",
            body: "VaultShuffle is not affiliated with or endorsed by Valve. Steam names, artwork and data remain the property of their respective owners and are subject to Steam's availability, privacy controls and terms."
          }
        ]}
      />
    </SharedInformationShell>
  );
}
