import type { Metadata } from "next";
import Link from "next/link";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { pageOpenGraph, pageTwitter } from "@/lib/site";

const description =
  "Terms of use for VaultShuffle, including accounts, Steam data, recommendations, acceptable use, availability, and account deletion.";

export const metadata: Metadata = {
  title: "Terms of Use",
  description,
  alternates: { canonical: "/terms" },
  openGraph: pageOpenGraph({ url: "/terms", title: "Terms of Use", description }),
  twitter: pageTwitter({ title: "Terms of Use", description })
};
export default function TermsPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Legal · Updated 4 September 2026"
        title="Terms of Use"
        intro="The terms that apply when you use VaultShuffle and connect a Steam library."
        icon="terms"
        overview={{
          title: "The short version",
          body: (
            <>
              <p>
                Use VaultShuffle responsibly and keep your browser session secure. Game recommendations and progress
                estimates are guidance, not guarantees. Steam and other providers control their own services and data.
              </p>
              <p>
                You are responsible for content you submit and can stop using VaultShuffle at any time. Questions or
                deletion requests can be sent through <Link href="/contact">Contact Us</Link>.
              </p>
            </>
          )
        }}
        sections={[
          {
            title: "Your account",
            open: true,
            body: (
              <p>
                Signing in through Steam verifies control of the Steam account. Importing a public profile does not;
                it creates a separate VaultShuffle profile from publicly available data. Do not use an unverified profile
                to misrepresent account ownership. You are responsible for activity through your active session, so sign
                out when using a shared device.
              </p>
            )
          },
          {
            title: "Acceptable use",
            body: (
              <>
                <p>Use VaultShuffle for lawful, personal game management. Do not:</p>
                <ul>
                  <li>attempt unauthorised access or bypass security controls</li>
                  <li>send abusive or excessive automated requests</li>
                  <li>disrupt the service or interfere with other users</li>
                  <li>upload unlawful or malicious content</li>
                  <li>reverse engineer protected parts of the service</li>
                  <li>use the service to violate another person&apos;s rights</li>
                </ul>
              </>
            )
          },
          {
            title: "Your content",
            body: (
              <p>
                You remain responsible for your notes, collection names, feedback and other submissions. You allow
                VaultShuffle to store and process them to provide the service, display your saved content to you and use
                feedback to improve the app. Do not submit confidential information you are not authorised to share.
              </p>
            )
          },
          {
            title: "Third-party services and content",
            body: (
              <p>
                VaultShuffle is independent and is not endorsed by Valve. Steam sign-in, game artwork, store information
                and IGDB metadata depend on their providers and remain subject to their terms. Purchases and accounts on
                linked services are between you and that provider. Read about library imports on the{" "}
                <Link href="/steam-data">Steam Data</Link> page.
              </p>
            )
          },
          {
            title: "Recommendations and game information",
            body: (
              <p>
                Recommendations, progress percentages and game-length estimates may not match your experience. Catalogue
                details, including prices and compatibility, can be incomplete or out of date. A shared-game listing is
                not confirmation that Steam will let you play it. Check Steam or the relevant provider before relying on
                availability, compatibility or a displayed price.
              </p>
            )
          },
          {
            title: "Availability and changes",
            body: (
              <p>
                We may update features, correct data, set reasonable usage limits or pause parts of the service for
                maintenance. We aim to keep VaultShuffle available, but cannot guarantee uninterrupted or error-free
                operation. You can stop using it at any time.
              </p>
            )
          },
          {
            title: "Access restrictions and deletion",
            body: (
              <p>
                We may restrict or end access when reasonably necessary to protect users or the service, meet legal
                requirements or address a serious breach of these terms. To request deletion of your account and
                associated data, use <Link href="/contact">Contact Us</Link>. Limited records may need to be retained for
                security or legal reasons.
              </p>
            )
          },
          {
            title: "Liability",
            body: (
              <p>
                Nothing in these terms limits liability that cannot legally be limited. Where the law permits,
                VaultShuffle is provided as available, and we are not responsible for indirect losses, lost opportunities,
                third-party services or decisions based solely on our recommendations or game information.
              </p>
            )
          },
          {
            title: "Contact and updates",
            body: (
              <p>
                Questions can be sent to <a href="mailto:support@vaultshuffle.com">support@vaultshuffle.com</a> or through{" "}
                <Link href="/contact">Contact Us</Link>. We may update these terms as VaultShuffle changes; the date above
                identifies this version. If we clearly notify you of a significant update, continued use means the updated
                terms apply. Our <Link href="/privacy">Privacy Policy</Link> explains how we handle personal data.
              </p>
            )
          }
        ]}
      />
    </SharedInformationShell>
  );
}
