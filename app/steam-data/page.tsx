import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "What Steam account and library data VaultShuffle reads, how playtime and game details power recommendations, why games may be missing, and how to request deletion.";

export const metadata: Metadata = {
  title: "Steam Data",
  description,
  alternates: { canonical: "/steam-data" },
  openGraph: pageOpenGraph({ url: "/steam-data", title: "Steam Data", description }),
  twitter: pageTwitter({ title: "Steam Data", description })
};
export default function SteamDataPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Data · Updated 4 September 2026"
        title="Steam Data"
        intro="How VaultShuffle reads your Steam profile and library, and where that data has limits."
        icon="steam-data"
        overview={{
          title: "What comes from Steam",
          body: (
            <>
              <p>
                VaultShuffle uses public Steam profile and library data to import games and track owned-game playtime.
                It reads this information without changing your Steam account. If you sign in, Steam handles your
                password directly; VaultShuffle never receives it.
              </p>
              <p>
                Imports depend on Steam&apos;s privacy settings and API responses. Family libraries are added separately
                using members&apos; public profiles; they are not an exact copy of the games Steam lets you borrow.
              </p>
            </>
          )
        }}
        sections={[
          {
            title: "Sign-in and public-profile data",
            open: true,
            body: (
              <>
                <p>
                  Steam OpenID confirms your SteamID after you sign in on Steam&apos;s website. VaultShuffle then uses
                  Steam&apos;s API to read public profile details, including your display name, profile URL and avatar.
                  OpenID does not give VaultShuffle access to your password or payment information.
                </p>
                <p>
                  You can also enter a public profile URL, custom profile name or SteamID without signing in. This creates
                  a separate, unverified VaultShuffle profile with access through this browser&apos;s session. It does not
                  prove that you own the Steam account.
                </p>
              </>
            )
          },
          {
            title: "Owned-game data",
            open: true,
            body: (
              <>
                <p>Steam&apos;s library API provides the available fields for each visible owned game:</p>
                <ul>
                  <li>an app ID and title</li>
                  <li>total playtime</li>
                  <li>a last-played timestamp</li>
                </ul>
                <p>
                  VaultShuffle adds catalogue information such as artwork, genres, tags, release dates, compatibility
                  and estimated game length. Duration estimates do not come from your Steam library. Statuses, notes,
                  progress adjustments, pins and collections are saved in VaultShuffle, not written back to Steam.
                </p>
              </>
            )
          },
          {
            title: "How the information is used",
            body: (
              <ul>
                <li><strong>Game IDs</strong> match your library entries to the catalogue and avoid duplicates.</li>
                <li><strong>Playtime and last-played dates</strong> support sorting, activity tracking and recommendations.</li>
                <li><strong>Genres, tags and duration estimates</strong> help rank games for your Session, Mood and Goal.</li>
                <li><strong>Store and catalogue details</strong> supply artwork, compatibility and other game information.</li>
              </ul>
            )
          },
          {
            title: "Family libraries",
            body: (
              <>
                <p>
                  Add a family member&apos;s public Steam profile to import games estimated to be shareable from their
                  owned library. VaultShuffle uses public profile and game data, not a verified list of your Steam family
                  membership. Steam may block access to a game even when VaultShuffle lists it as shared.
                </p>
                <p>
                  Shared games are labelled with their source. Your playtime for those copies is not available, so
                  VaultShuffle does not use the owner&apos;s hours as yours or show a playtime-based completion estimate.
                  You can hide family libraries, remove a member or filter for owned games. If you buy a shared game,
                  a later owned-library refresh updates the existing entry.
                </p>
              </>
            )
          },
          {
            title: "Privacy settings and missing games",
            body: (
              <>
                <p>
                  Your Steam profile and game details need to be public for an import. Even then, the imported library
                  may differ from the Steam client. Common reasons include:
                </p>
                <ul>
                  <li>individual games or playtime hidden by privacy settings</li>
                  <li>an incomplete or unavailable Steam API response</li>
                  <li>removed apps or missing catalogue information</li>
                  <li>demos, tools, dedicated servers and test apps excluded from the game catalogue</li>
                </ul>
                <p>
                  A game can also be imported but hidden by your current Library filters or status selection. Check those
                  before refreshing. Family-shared games require an added family profile with visible game details.
                </p>
              </>
            )
          },
          {
            title: "Refreshes and corrections",
            body: (
              <p>
                Library refreshes update the owned-game data Steam returns. Pinned owned-game playtime also has a
                scheduled refresh and a manual refresh option on the Dashboard. Updates can be delayed by privacy settings,
                API failures or usage limits. Catalogue details are maintained separately. If a value differs from Steam,
                try refreshing; for a persistent problem, <Link href="/contact">contact support</Link>.
              </p>
            )
          },
          {
            title: "Signing out and deleting data",
            body: (
              <p>
                Signing out ends this browser&apos;s session but leaves your saved VaultShuffle data in place. To request
                profile deletion and stop future syncing, email{" "}
                <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or use{" "}
                <Link href="/contact">Contact Us</Link>. Deleting VaultShuffle data does not remove games or change your
                Steam account. The <Link href="/privacy">Privacy Policy</Link> explains storage, analytics and your rights.
              </p>
            )
          },
          {
            title: "Independent service",
            body: (
              <p>
                VaultShuffle is not affiliated with or endorsed by Valve. Steam names, game artwork and other third-party
                content belong to their respective owners. Steam controls its own data availability and access rules.
              </p>
            )
          }
        ]}
      />
    </SharedInformationShell>
  );
}
