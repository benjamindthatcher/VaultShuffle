"use client";

import { useAnalyticsSettings } from "@/components/site/SiteExperience";

/**
 * The words "Analytics Settings" in the privacy policy, made to actually open
 * Analytics Settings. A button rather than a link, because it opens a dialog and
 * goes nowhere - it just reads as part of the sentence it sits in.
 */
export function AnalyticsSettingsLink({ className }: { className?: string }) {
  const { openAnalyticsSettings } = useAnalyticsSettings();
  return (
    <button type="button" className={className} onClick={openAnalyticsSettings}>
      Analytics Settings
    </button>
  );
}
