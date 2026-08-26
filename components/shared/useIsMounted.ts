"use client";

import { useEffect, useState } from "react";

/**
 * Whether the component has mounted in the browser.
 *
 * Every portal in the app needs this: document.body does not exist while the
 * server renders, and starting from `typeof window !== "undefined"` instead
 * would make the first client render disagree with the server's and break
 * hydration. Setting a flag in a mount effect is the documented way to do it.
 *
 * That trips react-hooks/set-state-in-effect, which is right to be suspicious
 * of state written from an effect - it is usually a sign that something could be
 * derived instead. Here it cannot be, so the exception lives in one place with
 * one explanation rather than repeated in five components.
 */
export function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: there is no render-time answer to "is this the browser yet".
  useEffect(() => setMounted(true), []);
  return mounted;
}
