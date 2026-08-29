"use client";

import { useEffect, useState } from "react";
import { steamLaunchUrl, steamStoreUrl } from "@/lib/steam-images";

/**
 * Where "play this" should actually go on this device.
 *
 * steam://run/<appid> needs the desktop Steam client to be installed. On a phone
 * nothing handles it, so the button does nothing at all - and 59% of the people
 * drawing from the Vault are on a phone. Over a day, 22 signed-in people drew a
 * game and exactly one launched one; guests, who were sent to the store page all
 * along, had a button that worked.
 *
 * A coarse-only pointer means no mouse and no trackpad, which in practice means
 * no Steam client. Those devices get the store page, which the Steam app opens
 * properly. Everything else keeps the direct launch.
 *
 * Starts as false so the server and the first client render agree, and so the
 * safe link is what exists if the check never runs. It resolves on mount, before
 * anybody has drawn anything.
 */
export function useCanLaunchSteam() {
  const [canLaunch, setCanLaunch] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    setCanLaunch(window.matchMedia("(pointer: fine)").matches);
  }, []);

  return canLaunch;
}

/** The launch URL where that can work, and the store page where it cannot. */
export function useSteamPlayUrl(appId: number | string | null | undefined) {
  const canLaunch = useCanLaunchSteam();
  if (!appId) return null;
  return canLaunch ? steamLaunchUrl(appId) : steamStoreUrl(appId);
}
