import { MarketingPage } from "@/components/site/MarketingPage";
import { getMarketingMetadata, marketingPages } from "@/lib/marketing-pages";

const page = marketingPages[4];
export const metadata = getMarketingMetadata(page);

export default function HowItWorksPage() {
  return <MarketingPage page={page} />;
}
