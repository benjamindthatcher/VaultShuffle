#!/usr/bin/env python3
"""Background-only HowLongToBeat fallback for unresolved catalogue games.

Search results are previewed by default. Pass --write to persist approved
high-confidence matches through the existing game_duration_estimates trigger.
"""

import argparse
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from howlongtobeatpy import HowLongToBeat

EDITION_SUFFIX = re.compile(
    r"\s*(?:[-:]\s*)?(?:definitive|anniversary|gold|complete|game of the year|"
    r"ultimate|steam|legacy|apocalypse|maximum)\s+edition(?:\s+deluxe)?$",
    re.IGNORECASE,
)
MARKS = re.compile(r"[™®©]")
YEAR = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")


def request(path, key, params=None, method="GET", payload=None, prefer=None):
    base = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
    query = f"?{urllib.parse.urlencode(params or {}, doseq=True)}" if params else ""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        f"{base}/rest/v1/{path}{query}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read()
        return json.loads(body) if body else None


def variants(title, alias=None):
    values = [alias, title, MARKS.sub("", title), YEAR.sub("", MARKS.sub("", title))]
    values.append(EDITION_SUFFIX.sub("", values[-1]))
    if ":" in values[-1]:
        values.append(values[-1].split(":", 1)[0])
    return list(dict.fromkeys(value.strip(" -:") for value in values if value and value.strip()))


def minutes(value):
    return round(float(value) * 60) if value and float(value) > 0 else None


def best_match(title_variants):
    for search_title in title_variants:
        results = HowLongToBeat().search(search_title) or []
        if not results:
            continue
        best = max(results, key=lambda item: item.similarity)
        if best.similarity < 0.8:
            continue
        durations = [minutes(best.main_story), minutes(best.main_extra), minutes(best.completionist)]
        if any(durations):
            return best, search_title, durations
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Persist high-confidence matches.")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=1.25)
    args = parser.parse_args()

    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    games = request(
        "catalog_games",
        key,
        {
            "select": "steam_appid,name,release_date",
            "duration_kind": "eq.unknown",
            "order": "steam_appid.asc",
            "limit": str(args.limit),
        },
    )
    aliases = request(
        "game_duration_aliases",
        key,
        {"select": "steam_app_id,search_title", "review_status": "eq.approved"},
    )
    alias_by_appid = {int(row["steam_app_id"]): row["search_title"] for row in aliases}
    report = []

    for game in games:
        appid = int(game["steam_appid"])
        match = best_match(variants(game["name"], alias_by_appid.get(appid)))
        if not match:
            report.append({"steam_appid": appid, "title": game["name"], "status": "unmatched"})
            time.sleep(args.delay)
            continue

        result, searched_as, duration_values = match
        now = datetime.now(timezone.utc).isoformat()
        row = {
            "steam_app_id": appid,
            "provider": "hltb",
            "provider_game_id": int(result.game_id),
            "main_story_minutes": duration_values[0],
            "main_extra_minutes": duration_values[1],
            "completionist_minutes": duration_values[2],
            "match_status": "matched",
            "match_confidence": "high",
            "checked_at": now,
            "next_refresh_at": None,
            "last_error_code": None,
            "updated_at": now,
        }
        report.append(
            {
                "steam_appid": appid,
                "title": game["name"],
                "searched_as": searched_as,
                "matched_title": result.game_name,
                "similarity": result.similarity,
                **row,
            }
        )
        if args.write:
            request(
                "game_duration_estimates",
                key,
                {"on_conflict": "steam_app_id,provider"},
                method="POST",
                payload=row,
                prefer="resolution=merge-duplicates,return=minimal",
            )
            request(
                "game_duration_jobs",
                key,
                {"steam_app_id": f"eq.{appid}"},
                method="PATCH",
                payload={"status": "completed", "updated_at": now},
                prefer="return=minimal",
            )
        time.sleep(args.delay)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
