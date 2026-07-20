import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Contact Us", description: "Contact VaultShuffle about account support, Steam data, privacy, technical issues, feedback, or partnerships.", alternates: { canonical: "/contact" }, openGraph: { url: "/contact" } };
export default function ContactLayout({ children }: { children: ReactNode }) { return children; }
