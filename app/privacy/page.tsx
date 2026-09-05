import type { Metadata } from "next";
import Link from "next/link";
import { AnalyticsSettingsLink } from "@/components/site/AnalyticsSettingsLink";
import { InfoPage } from "@/components/site/InfoPage";
import infoStyles from "@/components/site/InfoPage.module.css";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "VaultShuffle's privacy policy: how Steam account and library data, analytics, support messages, cookies, retention, and deletion requests are handled.";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description,
  alternates: { canonical: "/privacy" },
  openGraph: pageOpenGraph({ url: "/privacy", title: "Privacy Policy", description }),
  twitter: pageTwitter({ title: "Privacy Policy", description })
};

export default function PrivacyPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Legal · Updated 4 September 2026"
        title="Privacy Policy"
        intro="What VaultShuffle collects, how it is used and how to manage your data."
        icon="privacy"
        overview={{
          title: "Privacy at a glance",
          body: (
            <>
              <p>
                VaultShuffle stores profile details, a copy of your imported library and the choices you save in the app.
                This supports recommendations, collections and progress tracking. Steam handles sign-in; VaultShuffle
                never receives your Steam password or changes your Steam account.
              </p>
              <p>
                Product analytics and session replay are enabled by default. You can turn them off in <AnalyticsSettingsLink className={infoStyles.inlineAction} />.
                You can also ask to access, correct or delete your VaultShuffle data through <Link href="/contact">Contact Us</Link>.
              </p>
            </>
          )
        }}
        sections={[
          {
            title: "Who to contact",
            open: true,
            body: (
              <p>
                VaultShuffle is responsible for the personal data described in this policy. Send privacy questions or
                requests to access, correct or delete data to{" "}
                <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or through{" "}
                <Link href="/contact">Contact Us</Link>.
              </p>
            )
          },
          {
            title: "Account and Steam data",
            body: (
              <>
                <p>
                  Steam OpenID confirms your SteamID when you sign in. We then use Steam&apos;s API to read public profile
                  details, including your name and avatar, and visible library data such as game IDs, titles, playtime
                  and last-played dates. We do not receive your Steam password.
                </p>
                <p>
                  If you import a public profile without signing in, we store a separate, unverified VaultShuffle profile
                  on the server. A session cookie gives this browser access to it. Entering a public profile does not
                  prove ownership of, or give access to, the Steam account.
                </p>
                <p>
                  We also store the collections, notes, progress, pins and game statuses you save. If you add family
                  profiles, we store their public profile details and library information used to identify potentially
                  shared games. The <Link href="/steam-data">Steam Data</Link> page explains these imports.
                </p>
              </>
            )
          },
          {
            title: "How we use data",
            body: (
              <>
                <p>We use account and game data to:</p>
                <ul>
                  <li>maintain your VaultShuffle profile, browser session and library</li>
                  <li>estimate progress and personalise game recommendations</li>
                  <li>save game statuses, notes, pins and collections</li>
                  <li>prevent abuse and diagnose faults</li>
                  <li>respond to support requests and understand usage when product analytics are enabled</li>
                </ul>
                <p>
                  We process account and library data to provide the service you request. Security and reliability
                  work also supports our legitimate interests in keeping the service safe and functional.
                </p>
              </>
            )
          },
          {
            title: "Cookies, analytics and session replay",
            body: (
              <>
                <p>
                  Cookies and browser storage maintain your session, remember preferences and save your analytics choice.
                  Vercel Web Analytics and Speed Insights separately collect site-usage and performance information.
                  The PostHog setting below does not disable those services.
                </p>
                <p>
                  PostHog product analytics are enabled by default, with a notice on your first visit. They use cookies
                  and local storage to associate visits. When you connect a library, analytics can be linked to your
                  VaultShuffle user ID, account type, verification status, SteamID, display name, profile URL and avatar.
                  Analytics identities may be joined when you verify and link a public-profile account through Steam.
                </p>
                <p>
                  PostHog records selected usage events, errors and session replays to help us understand problems and
                  improve the app. Input values are masked in replays, but visible page content and interactions may be
                  recorded. Heatmap collection is disabled.
                </p>
                <p>
                  You can turn PostHog analytics off at any time in{" "}
                  <AnalyticsSettingsLink className={infoStyles.inlineAction} />.
                </p>
              </>
            )
          },
          {
            title: "Service providers",
            body: (
              <>
                <p>Providers used by VaultShuffle include:</p>
                <ul>
                  <li><strong>Steam</strong> — optional sign-in, public profile and game data</li>
                  <li><strong>Supabase</strong> — database and session infrastructure</li>
                  <li><strong>Vercel</strong> — hosting, site analytics and performance monitoring</li>
                  <li><strong>IGDB</strong> — game metadata</li>
                  <li><strong>PostHog</strong> — product analytics, when analytics are enabled</li>
                </ul>
                <p>
                  These providers process data to deliver their services, either on our behalf or under their own
                  terms. Processing may take place in countries other than the one where you live.
                </p>
              </>
            )
          },
          {
            title: "Messages, retention and security",
            body: (
              <>
                <p>
                  Contact and feedback submissions are stored as private support records. They can include your message,
                  contact details, page information and browser details used to investigate an issue. We retain account
                  and library data while your account is active. Support, analytics and operational records are retained
                  as needed for support, service improvement, security, legal obligations and backups.
                </p>
                <p>
                  We use encrypted connections and provider access controls to protect data. No online service can
                  guarantee complete security. Signing out ends this browser&apos;s session; it does not delete stored data.
                </p>
              </>
            )
          },
          {
            title: "Your choices and rights",
            open: true,
            body: (
              <>
                <p>Depending on your location, you may ask for:</p>
                <ul>
                  <li>a copy of your personal data</li>
                  <li>correction of anything inaccurate</li>
                  <li>deletion, restriction or portability</li>
                  <li>the ability to object to certain uses of your data</li>
                </ul>
                <p>
                  You may turn PostHog analytics off at any time in{" "}
                  <AnalyticsSettingsLink className={infoStyles.inlineAction} />. To exercise any other right, or if you
                  would like help doing so, email{" "}
                  <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or use{" "}
                  <Link href="/contact">Contact Us</Link>.
                </p>
              </>
            )
          },
          {
            title: "Age limits and policy updates",
            body: (
              <p>
                VaultShuffle is not directed to children under 13. We may update this policy as the service changes and
                will make significant changes reasonably prominent. The date above identifies this version. Our{" "}
                <Link href="/terms">Terms of Use</Link> also apply.
              </p>
            )
          }
        ]}
      />
    </SharedInformationShell>
  );
}
