"use client";

import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { DashboardPayload } from "@/lib/v2/repositories/dashboard-core";

export function useV2Dashboard(enabled:boolean,params:string,revision:number) {
  const [retry,setRetry]=useState(0);
  const key=`${params}:${revision}:${retry}`;
  const [state,setState]=useState<{key:string;payload:DashboardPayload|null;error:string|null}>({key:"",payload:null,error:null});
  useEffect(()=>{
    if (!enabled) return;
    const abort=new AbortController();
    requestJson<DashboardPayload>(`/api/v2/dashboard?${params}`,{signal:abort.signal,cache:"no-store"})
      .then(payload=>{if(!abort.signal.aborted)setState({key,payload,error:null});})
      .catch(()=>{if(!abort.signal.aborted)setState({key,payload:null,error:"Your dashboard could not be loaded. Please retry."});});
    return ()=>abort.abort();
  },[enabled,key,params]);
  const current=state.key===key?state:{key,payload:null,error:null};
  return {payload:current.payload,error:current.error,pending:enabled&&!current.payload&&!current.error,retry:()=>setRetry(value=>value+1)};
}
