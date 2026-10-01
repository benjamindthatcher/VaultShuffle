"use client";

import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { WishlistLibraryContext } from "@/lib/wishlist";

export function useWishlistLibraryContext(enabled: boolean, revision: number) {
  const [attempt, setAttempt] = useState(0);
  const key = `${revision}:${attempt}`;
  const [state, setState] = useState<{key:string;context:WishlistLibraryContext|null;error:string|null}>({key:"",context:null,error:null});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    requestJson<WishlistLibraryContext>("/api/v2/wishlist/library-context", {signal:controller.signal,cache:"no-store"})
      .then(context => { if (!controller.signal.aborted) setState({key,context,error:null}); })
      .catch(() => { if (!controller.signal.aborted) setState({key,context:null,error:"Your library could not be checked. Retry to load personal picks."}); });
    return () => controller.abort();
  }, [enabled, key]);
  const current = state.key === key ? state : {context:null,error:null};
  return {context:current.context,error:current.error,pending:enabled&&!current.context&&!current.error,retry:()=>setAttempt(value=>value+1)};
}
