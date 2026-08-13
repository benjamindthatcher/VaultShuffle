import type { Metadata } from "next";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Terms of Use", description: "The terms and service rules for using VaultShuffle.", alternates: { canonical: "/terms" }, openGraph: { url: "/terms" } };
export default function TermsPage() {
  return (
    <SharedInformationShell>
      <InfoPage
        eyebrow="Legal · Updated 13 August 2026"
        title="Terms of Use"
        intro="These terms apply when you access VaultShuffle, create an account, sync Steam data or use its library, recommendation, collection and purge tools."
        sections={[
          {
            title: "Your account",
            body: "You must use a Steam account you are entitled to access and keep your browser session secure. Information you submit must be accurate enough for the feature being used. You are responsible for activity performed through your active session and should sign out on a shared device."
          },
          {
            title: "Acceptable use",
            body: "Use VaultShuffle lawfully and for its intended personal game-management purpose. Do not probe or bypass access controls, automate abusive traffic, interfere with other users, upload unlawful or malicious content, reverse engineer protected parts of the service, or use the service to violate another person's rights."
          },
          {
            title: "Your content",
            body: "You retain responsibility for notes, collection names, feedback and other content you submit. You give VaultShuffle permission to store, process and display that content back to you and to use feedback to operate and improve the service. Do not submit confidential material you are not authorised to share."
          },
          {
            title: "Steam, IGDB and other third parties",
            body: "VaultShuffle is an independent service and is not endorsed by Valve. Steam sign-in, store data, game artwork and IGDB metadata remain subject to their owners' terms and availability. Links to Steam and third-party services are provided for convenience; purchases and third-party accounts are between you and that provider."
          },
          {
            title: "Recommendations and metadata",
            body: "Vault draws, progress estimates, completion suggestions, prices, discounts and how-long-to-beat values are informational estimates. They may be incomplete, delayed or inaccurate and are not a promise that a game will suit you, remain available or keep a displayed price. Check the relevant store before acting."
          },
          {
            title: "Availability and changes",
            body: "VaultShuffle is evolving and may add, change, suspend or remove features, correct data, impose reasonable usage limits or perform maintenance. We aim to keep the service available but do not guarantee uninterrupted or error-free operation. You may stop using the service at any time."
          },
          {
            title: "Suspension and termination",
            body: "We may restrict or end access where reasonably necessary to protect the service, users or providers, respond to legal requirements, or address a material breach of these terms. You may request account and associated-data deletion through Contact Us, subject to limited records we must retain for security or legal reasons."
          },
          {
            title: "Liability",
            body: "Nothing in these terms excludes liability that cannot legally be excluded. To the extent permitted by law, VaultShuffle is provided as available and we are not responsible for indirect loss, lost opportunities, third-party services or decisions based solely on generated recommendations or metadata."
          },
          {
            title: "Questions and changes to these terms",
            body: "Questions can be sent to support@vaultshuffle.com. We may update these terms as the service changes; the date above identifies the current version. Continued use after a clearly notified material update means the updated terms apply."
          }
        ]}
      />
    </SharedInformationShell>
  );
}
