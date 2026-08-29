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

/**
 * Everything an anchor needs to send someone to a game, including where it opens.
 *
 * The two cases want opposite things. steam://run hands off to the Steam client
 * and never navigates the page, so it has to stay in the same tab or the browser
 * is left sitting on a blank one. A store page is an ordinary web page, and
 * opening it in the same tab throws away whatever the person was in the middle
 * of - on a phone that means answering the three questions again, which is
 * exactly what someone reported.
 *
 * Returned together so the href and the target cannot disagree, which is how
 * two of the three links ended up sending people to the store page in the same
 * tab.
 */
export function useSteamPlayLink(
  appId: number | string | null | undefined,
  { forceStore = false }: { forceStore?: boolean } = {}
) {
  const canLaunch = useCanLaunchSteam();
  const launching = canLaunch && !forceStore;
  return {
    href: appId ? (launching ? steamLaunchUrl(appId) : steamStoreUrl(appId)) : "",
    target: launching ? undefined : "_blank",
    rel: launching ? undefined : "noreferrer",
    // So a button can say where it is actually going. "Play on Steam" pointing
    // at a store page is a small lie that costs a tap to find out.
    launching
  } as const;
}
