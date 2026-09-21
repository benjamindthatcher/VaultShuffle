"use client";

import { useCallback, useRef, useState, type SetStateAction } from "react";

/** Event handlers can read the latest optimistic state even before React renders. */
export function useImmediateState<T>(initial: T) {
  const [state, render] = useState(initial);
  const ref = useRef(state);
  const setState = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (previous: T) => T)(ref.current) : action;
    ref.current = next;
    render(next);
  }, []);
  return [state, setState, ref] as const;
}
