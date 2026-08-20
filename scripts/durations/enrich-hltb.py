#!/usr/bin/env python3
"""Background-only HowLongToBeat fallback for unresolved catalogue games.

Search results are previewed by default. Pass --write to persist approved
high-confidence matches through the existing game_duration_estimates trigger.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import requests
from fake_useragent import UserAgent
from howlongtobeatpy import HowLongToBeat
from howlongtobeatpy.HTMLRequests import HTMLRequests

EDITION_SUFFIX = re.compile(
    r"\s*(?:[-:]\s*)?(?:definitive|anniversary|gold|complete|game of the year|"
    r"ultimate|steam|legacy|apocalypse|maximum)\s+edition(?:\s+deluxe)?$",
    re.IGNORECASE,
)
MARKS = re.compile(r"[™®©]")
YEAR = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")
HLTB_SESSION_TTL_SECONDS = 300
_hltb_session = {}


def refresh_hltb_session():
    user_agent = UserAgent().random.strip()
    search_info = HTMLRequests.send_website_request_getcode(False, user_agent)
    if search_info is None or search_info.search_url is None:
        search_info = HTMLRequests.send_website_request_getcode(True, user_agent)
    parsed_search_url = search_info.search_url if search_info is not None else None
    auth = HTMLRequests.send_website_get_auth_token(parsed_search_url, user_agent)
    if auth is None:
        raise RuntimeError("HLTB did not return a search authentication token.")
    if parsed_search_url:
        HTMLRequests.SEARCH_URL = HTMLRequests.BASE_URL + parsed_search_url
    _hltb_session.update({
        "user_agent": user_agent,
        "auth": auth,
        "expires_at": time.monotonic() + HLTB_SESSION_TTL_SECONDS,
    })


def cached_hltb_request(game_name, search_modifiers=None, page=1):
    """Use one HLTB search session for several minutes instead of per title."""
    if not _hltb_session or time.monotonic() >= _hltb_session["expires_at"]:
        refresh_hltb_session()
    modifier = search_modifiers if search_modifiers is not None else 0
    last_status = None
    for attempt in range(2):
        headers = HTMLRequests.get_search_request_headers(
            _hltb_session["auth"], _hltb_session["user_agent"]
        )
        payload = HTMLRequests.get_search_request_data(
            game_name, modifier, page, _hltb_session["auth"]
        )
        response = requests.post(
            HTMLRequests.SEARCH_URL,
            headers=headers,
            data=payload,
            timeout=60,
        )
        last_status = response.status_code
        if response.status_code == 200:
            return response.text
        _hltb_session.clear()
        if attempt == 0:
            refresh_hltb_session()
    raise RuntimeError(f"HLTB search returned HTTP {last_status}.")


HTMLRequests.send_web_request = staticmethod(cached_hltb_request)


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
    return list(dict.fromkeys(value.strip(" -:") for value in values if value and value.strip()))


def normalized(value):
    ascii_value = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", ascii_value.lower()).strip()


def minutes(value):
    return round(float(value) * 60) if value and float(value) > 0 else None


def best_match(title_variants):
    errors = []
    review_candidate = None
    for search_title in title_variants:
        try:
            results = HowLongToBeat().search(search_title) or []
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
            continue
        if not results:
            continue
        best = max(results, key=lambda item: item.similarity)
        if best.similarity < 0.8:
            continue
        durations = [minutes(best.main_story), minutes(best.main_extra), minutes(best.completionist)]
        if not any(durations):
            continue
        if normalized(best.game_name) == normalized(search_title):
            return (best, search_title, durations), errors
        if review_candidate is None or best.similarity > review_candidate[0].similarity:
            review_candidate = (best, search_title, durations)
    return None, errors, review_candidate


def write_report(path, report):
    serialized = json.dumps(report, indent=2)
    if path:
        with open(path, "w", encoding="utf-8") as destination:
            destination.write(serialized)
            destination.write("\n")
    else:
        print(serialized)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Persist high-confidence matches.")
    parser.add_argument("--input", help="Read unresolved games from a local JSON export, or '-' for one-line JSON on stdin.")
    parser.add_argument("--output", help="Write the JSON report to this file instead of stdout.")
    parser.add_argument("--resume", action="store_true", help="Resume from an existing --output report.")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=1.25)
    args = parser.parse_args()

    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if args.input:
        if args.input == "-":
            games = json.loads(sys.stdin.readline())[: args.limit]
        else:
            with open(args.input, encoding="utf-8") as source:
                games = json.load(source)[: args.limit]
        aliases = []
    else:
        if not key:
            raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required unless --input is provided.")
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
    if args.resume and args.output and os.path.exists(args.output):
        with open(args.output, encoding="utf-8") as existing:
            report = json.load(existing)
        completed_appids = {int(row["steam_appid"]) for row in report}
        games = [game for game in games if int(game["steam_appid"]) not in completed_appids]

    total_games = len(games)
    for index, game in enumerate(games, start=1):
        appid = int(game["steam_appid"])
        input_alias = game.get("search_title") if isinstance(game, dict) else None
        match_result = best_match(variants(game["name"], input_alias or alias_by_appid.get(appid)))
        match, lookup_errors = match_result[:2]
        review_candidate = match_result[2] if len(match_result) > 2 else None
        if not match:
            unresolved = {
                "steam_appid": appid,
                "title": game["name"],
                "status": "provider_error" if lookup_errors and review_candidate is None else "needs_review" if review_candidate else "unmatched",
                "errors": list(dict.fromkeys(lookup_errors))[:3],
            }
            if review_candidate:
                candidate, searched_as, duration_values = review_candidate
                unresolved.update({
                    "searched_as": searched_as,
                    "candidate_game_id": int(candidate.game_id),
                    "candidate_title": candidate.game_name,
                    "candidate_similarity": candidate.similarity,
                    "candidate_main_story_minutes": duration_values[0],
                    "candidate_main_extra_minutes": duration_values[1],
                    "candidate_completionist_minutes": duration_values[2],
                })
            report.append(unresolved)
            if index == 1 or index % 25 == 0 or index == total_games:
                print(f"Processed {index}/{total_games} duration lookups.", file=sys.stderr, flush=True)
                if args.output:
                    write_report(args.output, report)
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
            if not key:
                raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required with --write.")
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
        if index == 1 or index % 25 == 0 or index == total_games:
            print(f"Processed {index}/{total_games} duration lookups.", file=sys.stderr, flush=True)
            if args.output:
                write_report(args.output, report)
        time.sleep(args.delay)

    write_report(args.output, report)


if __name__ == "__main__":
    main()
