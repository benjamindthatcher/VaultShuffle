import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ButtonLab } from "./ButtonLab";

export const metadata: Metadata = {
  title: "Button studio",
  robots: { index: false, follow: false },
};

export default function ButtonLabPage() {
  // This design playground is intentionally unavailable in production builds.
  if (process.env.NODE_ENV !== "development") notFound();
  return <ButtonLab />;
}
