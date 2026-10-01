"use client";
import { useEffect, useRef, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { VaultSetup, VaultPreview } from "@/lib/v2/vault";
import type { DemoGame } from "@/lib/demo-data";

export function useV2Vault(enabled: boolean, setup: VaultSetup, revision: number, remember: (games: DemoGame[]) => void) {
  const body = JSON.stringify(setup);
  const key = `${revision}|${body}`;
  const [retry,setRetry] = useState(0);
  const [state,setState] = useState<{key:string;retry:number;preview:VaultPreview|null;error:string|null}>({key:"",retry:0,preview:null,error:null});
  const rememberRef = useRef(remember);
  useEffect(() => { rememberRef.current = remember; }, [remember]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void requestJson<VaultPreview>("/api/v2/vault",{method:"PATCH",body,signal:controller.signal,cache:"no-store"})
      .then(preview => {
        if (controller.signal.aborted) return;
        rememberRef.current(preview.deck.map(entry => entry.game));
        setState({key,retry,preview,error:null});
      }).catch(() => {
        if (!controller.signal.aborted) setState({key,retry,preview:null,error:"Your Vault could not be loaded. Please retry."});
      });
    return () => controller.abort();
  }, [enabled,body,key,retry]);
  const current = state.key === key && state.retry === retry;
  return { preview:current ? state.preview : null,pending:enabled && !current,
    error:current ? state.error : null,retry:() => setRetry(value => value + 1) };
}
