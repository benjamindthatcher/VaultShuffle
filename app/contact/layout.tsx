import type { Metadata } from "next";
import type { ReactNode } from "react";
export const metadata: Metadata = { title: "Contact Us", description: "Contact VaultShuffle about account support, Steam data, privacy, technical issues or partnerships.", alternates: { canonical: "/contact" } };
export default function ContactLayout({ children }: { children: ReactNode }) { return children; }
