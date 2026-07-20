import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Wishlist",
  description: "Track Steam wishlist priorities, current prices, and discounts in one place.",
  alternates: { canonical: "/wishlist" },
  openGraph: { url: "/wishlist" }
};

export default function WishlistLayout({ children }: { children: ReactNode }) {
  return children;
}
