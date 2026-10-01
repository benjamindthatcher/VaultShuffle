import type { Metadata } from "next";
import { WishlistPage } from "@/components/wishlist/WishlistPage";

export const metadata: Metadata = { title: "Wishlist", description: "Discover what to buy next, save games for later and import your Steam wishlist." };

export default function Page() { return <WishlistPage />; }
