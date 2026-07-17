import type { Metadata } from "next";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
export const metadata: Metadata = { title: "Terms", alternates: { canonical: "/terms" } };
export default function TermsPage(){return <SharedInformationShell><InfoPage eyebrow="Legal" title="Terms" intro="These terms describe the basic rules for using VaultShuffle." sections={[{title:"Use of the service",body:"Use VaultShuffle lawfully and do not attempt to disrupt the service, bypass access controls or submit abusive content."},{title:"Steam and third parties",body:"Steam data and artwork remain subject to their respective owners and services."},{title:"Service changes",body:"Features may evolve while the preview is developed. We aim to protect stored user data and communicate material changes clearly."}]}/></SharedInformationShell>}
