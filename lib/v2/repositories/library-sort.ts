import type { TenantTransaction } from "../db/client.ts";

/** Match libraryGame's displayed precedence and integer inference, retaining manual decimals. */
export function libraryProgressSort(tx: TenantTransaction) {
  return tx`lpad((case when completed then 10000 when duration_kind='endless' then 9900
    when manual_progress is not null then round(manual_progress*100)
    when duration_minutes>0 then least(100,round(coalesce(playtime_minutes,0)*100.0/duration_minutes))*100
    else 0 end)::text,20,'0')`;
}

/** Preserve the raw label. Validate before casting and normalize supported dates to UTC. */
export function libraryAddedSort(tx: TenantTransaction) {
  return tx`(select case when pg_input_is_valid(parsed,'timestamp with time zone')
    then to_char(parsed::timestamptz at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') end
    from (select case
      when date_added ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then date_added||'T00:00:00Z'
      when date_added ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
        then substring(date_added from 7 for 4)||'-'||substring(date_added from 4 for 2)||'-'||substring(date_added from 1 for 2)||'T00:00:00Z'
      when date_added ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?$'
        then case when date_added ~ '([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$' then date_added else date_added||'Z' end
    end parsed) dates)`;
}
