"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { RequestFailure } from "@/lib/request-failure";
import { libraryGame } from "@/lib/v2/library-view-model";
import type { LibraryCard, LibraryPage } from "@/lib/v2/repositories/library-core";
import type { DemoGame } from "@/lib/demo-data";

/** One cursor chain per filter/revision; obsolete requests cannot mix rowsets. */
export function useV2Library(enabled: boolean, params: string, revision: string, path = "/api/v2/library") {
  const [retry, setRetry] = useState(0);
  const scope = `${path}:${params}`;
  const key = `${path}:${params}:${revision}:${retry}`;
  const [state, setState] = useState<{key:string; scope:string; retry:number; page:LibraryPage|null; pending:boolean; error:string|null}>({key:"",scope:"",retry:0,page:null,pending:false,error:null});
  const latest=useRef(state);
  useEffect(()=>{latest.current=state;},[state]);
  const [detail, setDetail] = useState<DemoGame | null>(null);
  const [detailPending, setDetailPending] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const morePending = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    morePending.current = false;
    const previous=latest.current;
    const keepDepth=previous.scope===scope&&previous.retry===retry;
    const depth=keepDepth?previous.page?.items.length??0:0;
    requestJson<LibraryPage>(`${path}?${params}`, {signal:abort.signal,cache:"no-store"})
      .then(async first => {
        let page=first;
        // Refresh only the pages the user already loaded, using fresh cursors.
        // Keeping the old rows until replacement avoids unmounting the grid.
        while(!abort.signal.aborted&&page.items.length<depth&&page.nextCursor) {
          const next=await requestJson<LibraryPage>(`${path}?${params}&cursor=${encodeURIComponent(page.nextCursor)}`,{signal:abort.signal,cache:"no-store"});
          page={...next,items:[...page.items,...next.items]};
        }
        if (!abort.signal.aborted) setState({key,scope,retry,page,pending:false,error:null});
      })
      .catch(error => {
        if(abort.signal.aborted)return;
        if(error instanceof RequestFailure&&error.status===409)setRetry(value=>value+1);
        else setState({key,scope,retry,page:keepDepth?previous.page:null,pending:false,error:"Your Library could not be loaded. Please retry."});
      });
    return () => abort.abort();
  }, [enabled, key, params, path, scope, retry]);
  useEffect(() => () => detailController.current?.abort(), []);

  const current = state.key === key ? state : {key,page:state.scope===scope&&state.retry===retry?state.page:null,pending:enabled,error:null};
  const games = useMemo(() => current.page?.items.map(libraryGame) ?? [], [current.page]);

  async function loadMore() {
    const abort = controller.current;
    if (!enabled || state.key!==key || current.error || !current.page?.nextCursor || morePending.current || !abort || abort.signal.aborted) return;
    const cursor = current.page.nextCursor;
    morePending.current = true;
    setState(previous => ({...previous,pending:true,error:null}));
    try {
      const page = await requestJson<LibraryPage>(`${path}?${params}&cursor=${encodeURIComponent(cursor)}`, {signal:abort.signal,cache:"no-store"});
      if (abort.signal.aborted) return;
      setState(previous => previous.key === key && previous.page?.nextCursor === cursor ? {
        ...previous,key,page:{...page,items:[...previous.page.items,...page.items]},pending:false,error:null,
      } : previous);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof RequestFailure && error.status === 409) setRetry(value => value+1);
      else setState(previous => previous.key === key ? {...previous,pending:false,error:"More games could not be loaded. Please retry."} : previous);
    } finally { if (controller.current === abort) morePending.current = false; }
  }

  async function openDetail(id: string) {
    detailController.current?.abort();
    const abort = new AbortController(); detailController.current = abort;
    setDetail(games.find(game => game.id === id) ?? null); setDetailPending(true); setDetailError(null);
    try {
      const card = await requestJson<LibraryCard>(`/api/v2/library/${encodeURIComponent(id)}`, {signal:abort.signal,cache:"no-store"});
      if (!abort.signal.aborted) setDetail(libraryGame(card));
    } catch {
      if (!abort.signal.aborted) { setDetail(null); setDetailError("Game details could not be loaded. Please retry."); }
    } finally { if (!abort.signal.aborted) setDetailPending(false); }
  }
  function closeDetail() { detailController.current?.abort(); setDetail(null); setDetailPending(false); setDetailError(null); }

  return {games,detail,detailPending,openDetail,closeDetail,loadMore,retry:()=>setRetry(value=>value+1),
    page:current.page,pending:current.pending,error:current.error ?? detailError};
}
