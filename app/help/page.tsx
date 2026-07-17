import type { Metadata } from "next";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Help", alternates: { canonical: "/help" } };
export default function HelpPage(){return <SharedInformationShell><InfoPage eyebrow="Support" title="Help" intro="Quick guidance for getting the most from VaultShuffle." sections={[{title:"Syncing your library",body:"Sign in with Steam and use Sync Steam library from your account menu. Store metadata may continue filling in after the initial library import."},{title:"Vault draws",body:"Choose a session, mood and goal, then optionally narrow the deck by collection or genre before drawing."},{title:"Still need help?",body:"Use Contact Us for account, data or technical support. Use Feedback for a quick suggestion or bug report."}]}/></SharedInformationShell>}
