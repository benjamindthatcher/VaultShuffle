"use client";

import { useEffect, useState } from "react";

/**
 * True where the review queue should put its decisions on the cards themselves.
 *
 * Not a width test. The strip-and-panel layout fails on a device held in the
 * hands, and a Steam Deck is 1280 wide - the same as plenty of laptops - so
 * width alone puts a handheld on the layout built for a mouse.
 *
 * `pointer: coarse` asks the only question that matters: is the primary way of
 * pointing at this screen imprecise? A phone and a tablet answer yes. A laptop
 * answers no. A Deck answers yes in Gaming Mode, where the touchscreen is the
 * primary input, and no in Desktop Mode driving a trackpad - which is the right
 * answer both times, because that is exactly when its needs differ.
 *
 * The narrow-width arm stays for a small window on a desktop, where the two-part
 * layout runs out of room whatever is pointing at it.
 *
 * Starts false so the server and the first client render agree; the swap lands
 * during the queue's own loading state, before any card is on screen.
 */
export function useTouchLayout() {
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(pointer: coarse), (max-width: 760px)");
    const apply = () => setTouch(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  return touch;
}
