"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { RequestFailure } from "@/lib/request-failure";
import { collectionModel } from "@/lib/v2/collection-view-model";
import { libraryGame } from "@/lib/v2/library-view-model";
import type { CollectionSummary, CollectionMemberPage } from "@/lib/v2/repositories/collections-core";

export function useV2Collections(enabled:boolean,params:string,revision:number,id:string|null) {
  const [retry,setRetry]=useState(0),[memberRetry,setMemberRetry]=useState(0);
  const key=`${params}:${revision}:${retry}`,memberKey=`${id}:${key}:${memberRetry}`;
  const [metadata,setMetadata]=useState<{key:string;rows:readonly CollectionSummary[];error:string|null}>({key:"",rows:[],error:null});
  const [members,setMembers]=useState<{key:string;page:CollectionMemberPage|null;pending:boolean;error:string|null}>({key:"",page:null,pending:false,error:null});
  const controller=useRef<AbortController|null>(null),morePending=useRef(false);
  useEffect(()=>{
    if(!enabled)return;
    const abort=new AbortController();
    requestJson<{collections:CollectionSummary[]}>(`/api/v2/collections?${params}`,{signal:abort.signal,cache:"no-store"})
      .then(payload=>{if(!abort.signal.aborted)setMetadata({key,rows:payload.collections,error:null});})
      .catch(()=>{if(!abort.signal.aborted)setMetadata({key,rows:[],error:"Your collections could not be loaded. Please retry."});});
    return ()=>abort.abort();
  },[enabled,key,params]);
  useEffect(()=>{
    controller.current?.abort();morePending.current=false;
    if(!enabled||!id)return;
    const abort=new AbortController();controller.current=abort;
    requestJson<CollectionMemberPage>(`/api/v2/collections/${id}/games?limit=60&${params}`,{signal:abort.signal,cache:"no-store"})
      .then(page=>{if(!abort.signal.aborted)setMembers({key:memberKey,page,pending:false,error:null});})
      .catch(()=>{if(!abort.signal.aborted)setMembers({key:memberKey,page:null,pending:false,error:"This collection could not be loaded. Please retry."});});
    return ()=>abort.abort();
  },[enabled,id,memberKey,params]);
  const currentMetadata=metadata.key===key?metadata:{key,rows:[],error:null};
  const current=members.key===memberKey?members:{key:memberKey,page:null,pending:enabled&&Boolean(id),error:null};
  const collections=useMemo(()=>currentMetadata.rows.map(collectionModel),[currentMetadata.rows]);
  const games=useMemo(()=>current.page?.items.flatMap(item=>item.card?[{...libraryGame(item.card),collectionIds:[id!]}]:[])??[],[current.page,id]);
  async function loadMore() {
    const abort=controller.current,cursor=current.page?.nextCursor;
    if(!enabled||!id||!cursor||!abort||abort.signal.aborted||morePending.current)return;
    morePending.current=true;setMembers(previous=>({...previous,pending:true,error:null}));
    try {
      const page=await requestJson<CollectionMemberPage>(`/api/v2/collections/${id}/games?limit=60&${params}&cursor=${encodeURIComponent(cursor)}`,{signal:abort.signal,cache:"no-store"});
      if(!abort.signal.aborted)setMembers(previous=>previous.key===memberKey&&previous.page?.nextCursor===cursor?{key:memberKey,page:{...page,items:[...previous.page.items,...page.items]},pending:false,error:null}:previous);
    }catch(error){
      if(abort.signal.aborted)return;
      if(error instanceof RequestFailure&&error.status===409)setMemberRetry(value=>value+1);
      else setMembers(previous=>previous.key===memberKey?{...previous,pending:false,error:"More collection games could not be loaded. Please retry."}:previous);
    }finally{if(controller.current===abort)morePending.current=false;}
  }
  return {collections,games,page:current.page,pending:current.pending,error:current.error,loadMore,
    metadataPending:enabled&&metadata.key!==key,metadataError:currentMetadata.error,
    retry:()=>setRetry(value=>value+1),retryMembers:()=>setMemberRetry(value=>value+1)};
}
