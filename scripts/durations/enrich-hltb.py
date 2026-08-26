#!/usr/bin/env python3
"""Read-only HowLongToBeat fallback for unresolved catalogue games.

The script writes a checkpointed local report only. Database writes must go
through the staged transactional writeback so a no-duration lookup, a stale
page, or a low-confidence result cannot overwrite stronger catalogue evidence.
"""

import argparse
from difflib import SequenceMatcher
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import requests
from bs4 import BeautifulSoup
from fake_useragent import UserAgent

EDITION_SUFFIX = re.compile(
    r"(?:\s+|[-:|]\s*)(?:(?:the\s+)?(?:definitive|anniversary|gold|complete|"
    r"game of the year|goty|ultimate|steam|legacy|apocalypse|maximum|deluxe|"
    r"collector(?:'s|s)?|special|enhanced|extended|premium|digital deluxe)\s+edition|"
    r"(?:deluxe|gold|complete|ultimate|enhanced|anniversary|collector(?:'s|s)?|special)\s*|"
    r"hd|remaster(?:ed)?|remake|redux|director(?:'s|s)?\s+cut)$",
    re.IGNORECASE,
)
BRACKETED_EDITION = re.compile(
    r"\s*[\[(](?:(?:the\s+)?(?:definitive|anniversary|gold|complete|game of the year|"
    r"goty|ultimate|steam|legacy|apocalypse|maximum|deluxe|collector(?:'s|s)?|special|"
    r"enhanced|extended|premium|digital deluxe)\s+edition|remaster(?:ed)?|remake|redux|"
    r"director(?:'s|s)?\s+cut)[\])]\s*$",
    re.IGNORECASE,
)
MARKS = re.compile(r"[™®©]")
HTML_TAG = re.compile(r"<[^>]+>")
YEAR = re.compile(r"\s*\((?:19|20)\d{2}\)\s*$")
ROMAN_NUMERALS = {
    "i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5",
    "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10",
    "xi": "11", "xii": "12", "xiii": "13", "xiv": "14", "xv": "15",
    "xvi": "16", "xvii": "17", "xviii": "18", "xix": "19", "xx": "20",
}
UNSAFE_HLTB_TYPES = ("dlc", "expansion", "mod", "compilation", "bundle")
REVIEW_SIMILARITY = 0.8
MAX_FUZZY_DETAILS_PER_QUERY = 3
MAX_DURATION_MINUTES = 120_000
HLTB_SESSION_TTL_SECONDS = 300
HLTB_BASE_URL = "https://howlongtobeat.com"
HLTB_SEARCH_INIT_URL = f"{HLTB_BASE_URL}/api/search/site/init"
HLTB_SEARCH_URL = f"{HLTB_BASE_URL}/api/search/site"
_hltb_session = {}
_hltb_details = {}


def refresh_hltb_session():
    user_agent = UserAgent().random.strip() or "Mozilla/5.0"
    session = requests.Session()
    response = session.get(
        HLTB_SEARCH_INIT_URL,
        params={"t": int(time.time() * 1000)},
        headers=hltb_headers(user_agent),
        timeout=60,
    )
    if response.status_code != 200:
        raise RuntimeError(f"HLTB search initialization returned HTTP {response.status_code}.")
    payload = response.json()
    token = payload.get("token")
    hp_key = payload.get("hpKey")
    hp_value = payload.get("hpVal")
    if not token or not hp_key or not hp_value:
        raise RuntimeError("HLTB did not return complete search credentials.")
    _hltb_session.update({
        "session": session,
        "user_agent": user_agent,
        "token": token,
        "hp_key": hp_key,
        "hp_value": hp_value,
        "expires_at": time.monotonic() + HLTB_SESSION_TTL_SECONDS,
    })


def hltb_headers(user_agent, include_auth=False):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": HLTB_BASE_URL,
        "Referer": f"{HLTB_BASE_URL}/",
        "User-Agent": user_agent,
    }
    if include_auth:
        headers.update({
            "Content-Type": "application/json",
            "x-auth-token": _hltb_session["token"],
            "x-hp-key": _hltb_session["hp_key"],
            "x-hp-val": _hltb_session["hp_value"],
        })
    return headers


def hltb_search_payload(game_name):
    payload = {
        "searchType": "games",
        "searchTerms": str(game_name).strip().split(),
        "searchPage": 1,
        "size": 20,
        "searchOptions": {
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": {"min": 0, "max": 0},
                "gameplay": {"perspective": "", "flow": "", "genre": "", "difficulty": ""},
                "rangeYear": {"min": "", "max": ""},
                "modifier": "",
            },
            "users": {"sortCategory": "postcount"},
            "lists": {"sortCategory": "follows"},
            "filter": "",
            "sort": 0,
            "randomizer": 0,
        },
        "useCache": True,
    }
    payload[_hltb_session["hp_key"]] = _hltb_session["hp_value"]
    return payload


def search_hltb(game_name):
    """Search HLTB's current public site endpoint using one short-lived session."""
    if not _hltb_session or time.monotonic() >= _hltb_session["expires_at"]:
        refresh_hltb_session()
    last_status = None
    for attempt in range(2):
        response = _hltb_session["session"].post(
            HLTB_SEARCH_URL,
            headers=hltb_headers(_hltb_session["user_agent"], include_auth=True),
            json=hltb_search_payload(game_name),
            timeout=60,
        )
        last_status = response.status_code
        if response.status_code == 200:
            payload = response.json()
            return [hltb_entry(row, game_name) for row in payload.get("data", [])]
        _hltb_session.clear()
        if attempt == 0:
            refresh_hltb_session()
    raise RuntimeError(f"HLTB search returned HTTP {last_status}.")


def hltb_entry(row, search_title):
    aliases = [part.strip() for part in str(row.get("game_alias") or "").split(",") if part.strip()]
    names = [str(row.get("game_name") or ""), *aliases]
    similarity = max((title_similarity(search_title, name) for name in names), default=0.0)
    return SimpleNamespace(
        game_id=int(row.get("game_id") or 0),
        game_name=str(row.get("game_name") or ""),
        game_alias=str(row.get("game_alias") or ""),
        game_type=str(row.get("game_type") or ""),
        release_world=row.get("release_world"),
        profile_platforms=row.get("profile_platform"),
        similarity=similarity,
        main_story=seconds_to_hours(row.get("comp_main")),
        main_extra=seconds_to_hours(row.get("comp_plus")),
        completionist=seconds_to_hours(row.get("comp_100")),
        all_styles=seconds_to_hours(row.get("comp_all")),
        coop_time=seconds_to_hours(row.get("invested_co")),
        mp_time=seconds_to_hours(row.get("invested_mp")),
        completion_count=max(
            int(row.get("count_comp") or 0),
            int(row.get("count_main") or 0),
            int(row.get("count_plus") or 0),
            int(row.get("count_100") or 0),
        ),
        coop_count=int(row.get("invested_co_count") or 0),
        mp_count=int(row.get("invested_mp_count") or 0),
        complexity_lvl_sp=bool(row.get("comp_lvl_sp")),
        complexity_lvl_co=bool(row.get("comp_lvl_co")),
        complexity_lvl_mp=bool(row.get("comp_lvl_mp")),
        profile_steam=positive_integer(row.get("profile_steam")),
        json_content=row,
    )


def load_hltb_detail(entry):
    """Hydrate an HLTB search result with its embedded Steam identity and full times."""
    if entry.game_id in _hltb_details:
        return _hltb_details[entry.game_id]
    session = _hltb_session.get("session") or requests
    response = session.get(
        f"{HLTB_BASE_URL}/game/{entry.game_id}",
        headers=hltb_headers(_hltb_session.get("user_agent") or "Mozilla/5.0"),
        timeout=60,
    )
    if response.status_code != 200:
        raise RuntimeError(f"HLTB game page {entry.game_id} returned HTTP {response.status_code}.")
    script = BeautifulSoup(response.text, "html.parser").find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        raise RuntimeError(f"HLTB game page {entry.game_id} did not contain embedded game data.")
    embedded = find_embedded_game(json.loads(script.string), entry.game_id)
    if not embedded:
        raise RuntimeError(f"HLTB game page {entry.game_id} did not contain the requested game.")
    detail = hltb_entry(embedded, entry.game_name)
    detail.similarity = entry.similarity
    _hltb_details[entry.game_id] = detail
    return detail


def find_embedded_game(value, game_id):
    if isinstance(value, dict):
        if positive_integer(value.get("game_id")) == game_id:
            return value
        for child in value.values():
            match = find_embedded_game(child, game_id)
            if match:
                return match
    elif isinstance(value, list):
        for child in value:
            match = find_embedded_game(child, game_id)
            if match:
                return match
    return None


def seconds_to_hours(value):
    seconds = float(value or 0)
    return seconds / 3600 if seconds > 0 else None


def positive_integer(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


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


def request_all(path, key, params=None, page_size=1000):
    """Read every PostgREST page instead of silently accepting its row cap."""
    rows = []
    offset = 0
    while True:
        page = request(
            path,
            key,
            {**(params or {}), "limit": str(page_size), "offset": str(offset)},
        ) or []
        if not isinstance(page, list):
            raise RuntimeError(f"{path} returned a non-list response.")
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def strip_special_characters(value):
    """Replace punctuation/symbol runs with spaces while retaining Unicode letters and numbers."""
    cleaned = []
    plain_value = HTML_TAG.sub(" ", MARKS.sub("", str(value)))
    for character in unicodedata.normalize("NFKC", plain_value):
        category = unicodedata.category(character)
        cleaned.append(character if category[0] in {"L", "N"} or character.isspace() else " ")
    return re.sub(r"\s+", " ", "".join(cleaned)).strip()


def english_only_title(value):
    """Return an ASCII search title, dropping non-Latin scripts and punctuation."""
    plain = html.unescape(HTML_TAG.sub(" ", MARKS.sub("", str(value))))
    ascii_value = unicodedata.normalize("NFKD", plain).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Za-z0-9]+", " ", ascii_value).strip()


def contains_non_latin_letters(value):
    for character in str(value):
        if not character.isalpha() or ord(character) < 128:
            continue
        if not unicodedata.name(character, "").startswith("LATIN "):
            return True
    return False


def retained_english_identity(value):
    retained = english_only_title(value)
    alphanumerics = re.sub(r"[^A-Za-z0-9]", "", retained)
    if len(alphanumerics) < 4 or not re.search(r"[A-Za-z]", retained):
        return ""
    return normalized(retained)


def title_variants(value):
    if not value or not str(value).strip():
        return []
    original = str(value).strip()
    without_marks = HTML_TAG.sub(" ", MARKS.sub("", original))
    without_year = YEAR.sub("", without_marks)
    without_bracketed_edition = BRACKETED_EDITION.sub("", without_year)
    without_edition = EDITION_SUFFIX.sub("", without_bracketed_edition)
    candidates = [original, without_marks]
    if contains_non_latin_letters(original) and retained_english_identity(original):
        candidates.insert(0, english_only_title(without_edition))
    candidates.extend((without_year, without_bracketed_edition, without_edition))
    letters = [character for character in original if character.isalpha()]
    if letters and all(character.isupper() for character in letters):
        candidates.extend((original.title(), original.lower()))
    for candidate in list(candidates):
        candidates.append(strip_special_characters(candidate))
        candidates.append(strip_special_characters(candidate.replace("&", " and ")))
    return list(dict.fromkeys(
        candidate.strip(" -:|") for candidate in candidates if candidate.strip(" -:|")
    ))


def variants(title, alias=None):
    values = []
    for value in (alias, title):
        values.extend(title_variants(value))
    return list(dict.fromkeys(values))


def normalized_retry_variants(title, alias=None):
    """Return only transformed names for a second, conservative HLTB pass."""
    values = []
    for value in (alias, title):
        if not value or not str(value).strip():
            continue
        original = str(value).strip()
        without_marks = HTML_TAG.sub(" ", MARKS.sub("", original))
        without_year = YEAR.sub("", without_marks)
        without_bracketed_edition = BRACKETED_EDITION.sub("", without_year)
        without_edition = EDITION_SUFFIX.sub("", without_bracketed_edition)
        transformed = [
            without_year,
            without_bracketed_edition,
            without_edition,
            strip_special_characters(without_year),
            strip_special_characters(without_edition),
            strip_special_characters(without_year.replace("&", " and ")),
            strip_special_characters(without_edition.replace("&", " and ")),
        ]
        values.extend(candidate for candidate in transformed if candidate and candidate != original)
    return list(dict.fromkeys(value.strip(" -:|") for value in values if value.strip(" -:|")))


def edition_retry_variants(title, alias=None):
    """Return only markup-cleaned or edition-stripped names for a narrow follow-up pass."""
    values = []
    for value in (alias, title):
        if not value or not str(value).strip():
            continue
        original = str(value).strip()
        without_markup = HTML_TAG.sub(" ", MARKS.sub("", original))
        without_year = YEAR.sub("", without_markup)
        without_bracketed_edition = BRACKETED_EDITION.sub("", without_year)
        without_edition = EDITION_SUFFIX.sub("", without_bracketed_edition)
        if without_markup != original:
            values.extend((without_markup, strip_special_characters(without_markup)))
        if without_bracketed_edition != without_year:
            values.extend((without_bracketed_edition, strip_special_characters(without_bracketed_edition)))
        if without_edition != without_bracketed_edition:
            values.extend((
                without_edition,
                strip_special_characters(without_edition),
                strip_special_characters(without_edition.replace("&", " and ")),
            ))
    return list(dict.fromkeys(value.strip(" -:|") for value in values if value.strip(" -:|")))


def igdb_alias_retry_variants(title, aliases):
    """Search only exact-mapped IGDB identities that are genuinely new Steam-title variants."""
    title_normalized = normalized(title)
    title_canonical = canonical_title(title)
    values = []
    for alias in aliases or []:
        if not alias or not str(alias).strip():
            continue
        alias_normalized = normalized(alias)
        alias_canonical = canonical_title(alias)
        if not alias_normalized:
            continue
        if alias_normalized == title_normalized:
            continue
        if alias_canonical and title_canonical and alias_canonical == title_canonical:
            continue
        values.extend(title_variants(alias))
    return list(dict.fromkeys(value.strip(" -:|") for value in values if value.strip(" -:|")))


def normalized(value):
    """N1 identity: case, punctuation, marks and Latin diacritics only; no word removal."""
    plain = html.unescape(HTML_TAG.sub(" ", MARKS.sub("", str(value)))).replace("&", " and ")
    plain = unicodedata.normalize("NFKC", plain).casefold()
    plain = "".join(
        character for character in unicodedata.normalize("NFKD", plain)
        if not unicodedata.combining(character)
    )
    cleaned = [
        character if unicodedata.category(character)[0] in {"L", "N"} else " "
        for character in plain
    ]
    return re.sub(r"\s+", " ", "".join(cleaned)).strip()


def canonical_title(value):
    """Identity-safe comparison form; packaging words are deliberately retained."""
    identity = normalized(value)
    if not identity:
        return ""
    return " ".join(
        ROMAN_NUMERALS.get(token, token) if token != "i" else token
        for token in identity.split()
    )


def title_similarity(left, right):
    left_identity = normalized(left)
    right_identity = normalized(right)
    if not left_identity or not right_identity:
        return 0.0
    return SequenceMatcher(None, left_identity, right_identity).ratio()


def protected_numbers(value):
    numbers = []
    for token in re.findall(r"[A-Za-z0-9]+", html.unescape(str(value))):
        if token.isdigit():
            numbers.append(str(int(token)))
            continue
        lower = token.lower()
        if token.isupper() and len(token) > 1 and lower in ROMAN_NUMERALS:
            numbers.append(ROMAN_NUMERALS[lower])
    return tuple(numbers)


def numbers_compatible(left, right):
    left_numbers = protected_numbers(left)
    right_numbers = protected_numbers(right)
    return (not left_numbers and not right_numbers) or left_numbers == right_numbers


def parse_release_year(value):
    if value is None or value == "":
        return None
    match = re.search(r"(?:19|20)\d{2}", str(value))
    return int(match.group()) if match else None


def candidate_names(entry):
    aliases = [
        part.strip()
        for part in str(getattr(entry, "game_alias", "") or "").split(",")
        if part.strip()
    ]
    return [str(getattr(entry, "game_name", "") or ""), *aliases]


def is_pc_entry(entry):
    platforms = getattr(entry, "profile_platforms", None)
    if not platforms:
        return True
    values = platforms if isinstance(platforms, list) else re.split(r"[,|/]", str(platforms))
    return any(str(value).strip().casefold() in {"pc", "windows", "steam"} for value in values)


def is_short_or_collision_prone(value):
    identity = normalized(value)
    return bool(identity) and (len(identity) <= 10 or len(identity.split()) <= 2)


def trusted_query_tier(search_title, trusted_titles):
    query_identity = normalized(search_title)
    if not query_identity:
        return None
    for trusted in trusted_titles or []:
        if (
            query_identity == normalized(trusted)
            or canonical_title(search_title) == canonical_title(trusted)
        ) and numbers_compatible(search_title, trusted):
            return "exact_title"
    for trusted in trusted_titles or []:
        if contains_non_latin_letters(trusted):
            if query_identity == retained_english_identity(trusted) and numbers_compatible(search_title, trusted):
                return "mixed_script_title"
    return None


def identity_evidence(entry, search_title, steam_app_id=None, release_year=None, trusted_titles=None):
    """Return an acceptance tier or rejection reason for one hydrated HLTB entry."""
    profile_steam = getattr(entry, "profile_steam", None)
    if steam_app_id and profile_steam == int(steam_app_id):
        return "steam_appid", None
    if profile_steam:
        return None, "different_steam_appid"
    if any(marker in str(getattr(entry, "game_type", "")).casefold() for marker in UNSAFE_HLTB_TYPES):
        return None, "incompatible_game_type"
    if not is_pc_entry(entry):
        return None, "not_pc"

    query_tier = trusted_query_tier(search_title, trusted_titles or [search_title])
    if not query_tier:
        return None, "lossy_query_without_appid"
    search_identity = canonical_title(search_title)
    exact_name = next(
        (name for name in candidate_names(entry) if canonical_title(name) == search_identity),
        None,
    )
    if not exact_name or not search_identity or not numbers_compatible(exact_name, search_title):
        return None, "not_exact_title"

    source_year = parse_release_year(release_year)
    candidate_year = parse_release_year(getattr(entry, "release_world", None))
    if source_year and candidate_year and abs(source_year - candidate_year) > 1:
        return None, "release_year_conflict"
    if is_short_or_collision_prone(search_title) and (not source_year or not candidate_year):
        return None, "short_title_missing_year"
    return query_tier, None


def minutes(value):
    return round(float(value) * 60) if value and float(value) > 0 else None


def duration_values(entry):
    """Choose a useful duration without letting corrupt fields poison the app average."""
    values = [
        minutes(getattr(entry, "main_story", None)),
        minutes(getattr(entry, "main_extra", None)),
        minutes(getattr(entry, "completionist", None)),
    ]
    issues = []
    for index, value in enumerate(values):
        if value and value > MAX_DURATION_MINUTES:
            issues.append(("main_story", "main_extra", "completionist")[index] + "_too_large")
            values[index] = None

    if values[0] and values[1] and values[1] < values[0]:
        issues.append("main_extra_below_main_story")
        values[1] = None
    comparison = values[1] or values[0]
    if values[2] and comparison and values[2] < comparison:
        issues.append("completionist_below_longer_story_estimate")
        values[2] = None
    if values[0] and values[2] and values[2] >= values[0] * 12:
        issues.append("completionist_extreme_ratio")
        values[2] = None

    if any(values):
        return values, "completion_times", int(getattr(entry, "completion_count", 0) or 0), issues

    all_styles = minutes(getattr(entry, "all_styles", None))
    if all_styles and all_styles <= MAX_DURATION_MINUTES:
        return [all_styles, None, None], "all_styles", int(
            getattr(entry, "completion_count", 0) or 0
        ), issues

    representative = []
    if getattr(entry, "coop_time", None) and getattr(entry, "coop_count", 0):
        representative.append((float(entry.coop_time), int(entry.coop_count)))
    if getattr(entry, "mp_time", None) and getattr(entry, "mp_count", 0):
        representative.append((float(entry.mp_time), int(entry.mp_count)))
    representative_count = sum(count for _, count in representative)
    if representative and representative_count >= 3:
        weighted_hours = sum(hours * count for hours, count in representative) / representative_count
        representative_minutes = minutes(weighted_hours)
        if representative_minutes and representative_minutes <= MAX_DURATION_MINUTES:
            return (
                [representative_minutes, None, None],
                "multiplayer_representative",
                representative_count,
                issues,
            )
    return [None, None, None], "no_duration", max(
        int(getattr(entry, "completion_count", 0) or 0), representative_count
    ), issues


def lower_confidence(left, right):
    order = {"low": 0, "medium": 1, "high": 2}
    return left if order[left] <= order[right] else right


def estimate_confidence(identity_tier, basis, submission_count, populated_fields):
    identity_confidence = "medium" if identity_tier == "mixed_script_title" else "high"
    if submission_count >= 10 and populated_fields >= 2 and basis == "completion_times":
        value_confidence = "high"
    elif submission_count >= 3:
        value_confidence = "medium"
    else:
        value_confidence = "low"
    if populated_fields == 1 or basis in {"all_styles", "multiplayer_representative"}:
        value_confidence = lower_confidence(value_confidence, "medium")
    return lower_confidence(identity_confidence, value_confidence)


def hydrated_candidates(results, search_title, errors):
    exact = [
        result for result in results
        if any(
            canonical_title(name) and canonical_title(name) == canonical_title(search_title)
            for name in candidate_names(result)
        )
    ]
    ranked = sorted(results, key=lambda result: result.similarity, reverse=True)
    selected = [
        *[result for result in results if result.profile_steam],
        *exact,
        *ranked[:MAX_FUZZY_DETAILS_PER_QUERY],
    ]
    hydrated = []
    seen = set()
    for result in selected:
        if not result.game_id or result.game_id in seen:
            continue
        seen.add(result.game_id)
        try:
            detail = load_hltb_detail(result)
        except Exception as error:
            errors.append(f"game {result.game_id}: {type(error).__name__}: {error}")
            if not result.profile_steam:
                continue
            detail = result
        detail.similarity = max(detail.similarity, result.similarity)
        hydrated.append(detail)
    return hydrated


def match_tuple(entry, search_title, identity_tier):
    values, basis, submission_count, issues = duration_values(entry)
    identity_confidence = "medium" if identity_tier == "mixed_script_title" else "high"
    confidence = (
        identity_confidence
        if basis == "no_duration"
        else estimate_confidence(
            identity_tier,
            basis,
            submission_count,
            sum(value is not None for value in values),
        )
    )
    metadata = {
        "identity_tier": identity_tier,
        "identity_confidence": identity_confidence,
        "duration_basis": basis,
        "submission_count": submission_count,
        "match_confidence": confidence,
        "duration_issues": issues,
        "hltb_modes": {
            "single_player": bool(getattr(entry, "complexity_lvl_sp", False)),
            "co_op": bool(getattr(entry, "complexity_lvl_co", False)),
            "multiplayer": bool(getattr(entry, "complexity_lvl_mp", False)),
        },
    }
    return entry, search_title, values, metadata


def best_match(title_variants, steam_app_id=None, release_year=None, trusted_titles=None):
    """Return only a unique identity-safe match; similarity alone is review-only."""
    errors = []
    review_candidate = None
    verified_no_duration = None
    trusted_titles = [title for title in (trusted_titles or title_variants) if title]
    for search_title in title_variants:
        try:
            results = search_hltb(search_title) or []
        except Exception as error:
            errors.append(f"{type(error).__name__}: {error}")
            continue
        if not results:
            continue
        accepted = []
        for candidate in hydrated_candidates(results, search_title, errors):
            identity_tier, rejection = identity_evidence(
                candidate,
                search_title,
                steam_app_id=steam_app_id,
                release_year=release_year,
                trusted_titles=trusted_titles,
            )
            candidate_match = match_tuple(candidate, search_title, identity_tier or "exact_title")
            durations = candidate_match[2]
            if identity_tier:
                accepted.append(candidate_match)
                continue
            if any(durations) and candidate.similarity >= REVIEW_SIMILARITY:
                metadata = {**candidate_match[3], "review_reason": rejection or "fuzzy_title"}
                proposed = (candidate, search_title, durations, metadata)
                if review_candidate is None or candidate.similarity > review_candidate[0].similarity:
                    review_candidate = proposed

        direct = {item[0].game_id: item for item in accepted if item[3]["identity_tier"] == "steam_appid"}
        if len(direct) == 1:
            direct_match = next(iter(direct.values()))
            if any(direct_match[2]):
                return direct_match, errors, review_candidate, verified_no_duration
            return None, errors, review_candidate, direct_match
        if len(direct) > 1:
            ambiguous = max(direct.values(), key=lambda item: item[0].similarity)
            ambiguous[3]["review_reason"] = "multiple_hltb_pages_for_steam_appid"
            review_candidate = ambiguous
            continue

        exact = {item[0].game_id: item for item in accepted}
        if len(exact) == 1:
            exact_match = next(iter(exact.values()))
            if any(exact_match[2]):
                return exact_match, errors, review_candidate, verified_no_duration
            verified_no_duration = exact_match
        elif len(exact) > 1:
            ambiguous = max(exact.values(), key=lambda item: item[0].similarity)
            ambiguous[3]["review_reason"] = "multiple_exact_hltb_candidates"
            review_candidate = ambiguous
    return None, errors, review_candidate, verified_no_duration


def write_report(path, report):
    serialized = json.dumps(report, indent=2)
    if path:
        with open(path, "w", encoding="utf-8") as destination:
            destination.write(serialized)
            destination.write("\n")
    else:
        print(serialized)


def read_stdin_games(stream):
    """Read either a JSON array or newline-delimited game objects from stdin.

    NDJSON is useful for large catalogues because each record stays below a
    terminal's canonical-input limit. A blank line terminates an interactive
    NDJSON stream; EOF also terminates it.
    """
    first_line = stream.readline()
    if not first_line:
        return []
    first_value = first_line.strip()
    if not first_value:
        return []
    if first_value.startswith("["):
        games = json.loads(first_value)
        if not isinstance(games, list):
            raise ValueError("stdin JSON input must be an array of games")
        return games

    games = []
    current_value = first_value
    while current_value:
        game = json.loads(current_value)
        if not isinstance(game, dict):
            raise ValueError("each NDJSON input row must be a game object")
        games.append(game)
        next_line = stream.readline()
        if not next_line:
            break
        current_value = next_line.strip()
    return games


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--write",
        action="store_true",
        help="Disabled: use the staged transactional report writeback.",
    )
    parser.add_argument("--input", help="Read unresolved games from a local JSON export, or '-' for one-line JSON on stdin.")
    parser.add_argument("--output", help="Write the JSON report to this file instead of stdout.")
    parser.add_argument("--resume", action="store_true", help="Resume from an existing --output report.")
    parser.add_argument(
        "--normalized-retry",
        action="store_true",
        help="Search only punctuation-cleaned and edition-stripped title variants.",
    )
    parser.add_argument(
        "--edition-retry",
        action="store_true",
        help="Search only markup-cleaned or edition-stripped variants.",
    )
    parser.add_argument(
        "--igdb-alias-retry",
        action="store_true",
        help="Search only canonical identities supplied by exact IGDB-to-Steam mappings.",
    )
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--delay", type=float, default=1.25)
    args = parser.parse_args()

    if args.write:
        raise SystemExit(
            "--write is disabled because row-by-row REST writes are not atomic. "
            "Consolidate the report and use the staged transactional writeback."
        )

    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if args.input:
        if args.input == "-":
            games = read_stdin_games(sys.stdin)[: args.limit]
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
                "select": "steam_appid,name,release_date,developer",
                "duration_kind": "eq.unknown",
                "order": "steam_appid.asc",
                "limit": str(args.limit),
            },
        )
        aliases = request(
            "game_duration_aliases",
            key,
            {"select": "steam_app_id,search_title,release_year", "review_status": "eq.approved"},
        )
        excluded = request_all(
            "catalog_game_quarantine",
            key,
            {"select": "steam_appid", "review_status": "eq.excluded", "order": "steam_appid.asc"},
        )
        excluded_appids = {int(row["steam_appid"]) for row in excluded}
        games = [game for game in games if int(game["steam_appid"]) not in excluded_appids]
    alias_by_appid = {int(row["steam_app_id"]): row for row in aliases}
    report = []
    if args.resume and args.output and os.path.exists(args.output):
        with open(args.output, encoding="utf-8") as existing:
            report = json.load(existing)
        report = [row for row in report if row.get("status") != "provider_error"]
        completed_appids = {int(row["steam_appid"]) for row in report}
        games = [game for game in games if int(game["steam_appid"]) not in completed_appids]

    total_games = len(games)
    for index, game in enumerate(games, start=1):
        appid = int(game["steam_appid"])
        input_alias = game.get("search_title") if isinstance(game, dict) else None
        approved_alias = alias_by_appid.get(appid, {})
        approved_title = approved_alias.get("search_title")
        if args.igdb_alias_retry:
            title_candidates = igdb_alias_retry_variants(game["name"], game.get("aliases", []))
        elif args.edition_retry:
            title_candidates = edition_retry_variants(game["name"], input_alias or approved_title)
        elif args.normalized_retry:
            title_candidates = normalized_retry_variants(game["name"], input_alias or approved_title)
        else:
            title_candidates = variants(game["name"], input_alias or approved_title)
        trusted_titles = list(dict.fromkeys(
            title for title in [
                game["name"],
                input_alias,
                approved_title,
                *(game.get("aliases", []) if args.igdb_alias_retry else []),
            ]
            if title
        ))
        release_year = (
            game.get("release_year")
            or approved_alias.get("release_year")
            or game.get("release_date")
        )
        match, lookup_errors, review_candidate, verified_no_duration = best_match(
            title_candidates,
            steam_app_id=appid,
            release_year=release_year,
            trusted_titles=trusted_titles,
        )
        if not match:
            unresolved = {
                "steam_appid": appid,
                "title": game["name"],
                "status": (
                    "verified_no_duration"
                    if verified_no_duration
                    else "provider_error"
                    if lookup_errors and review_candidate is None
                    else "needs_review"
                    if review_candidate
                    else "unmatched"
                ),
                "errors": list(dict.fromkeys(lookup_errors))[:3],
            }
            if verified_no_duration:
                candidate, searched_as, _, metadata = verified_no_duration
                now = datetime.now(timezone.utc)
                no_duration_row = {
                    "steam_app_id": appid,
                    "provider": "hltb",
                    "provider_game_id": int(candidate.game_id),
                    "main_story_minutes": None,
                    "main_extra_minutes": None,
                    "completionist_minutes": None,
                    "submission_count": metadata["submission_count"],
                    "match_status": "no_duration",
                    "match_confidence": metadata["identity_confidence"],
                    "checked_at": now.isoformat(),
                    "next_refresh_at": (now + timedelta(days=90)).isoformat(),
                    "last_error_code": "known_title_no_provider_times",
                    "updated_at": now.isoformat(),
                }
                unresolved.update({
                    "searched_as": searched_as,
                    "matched_title": candidate.game_name,
                    "similarity": candidate.similarity,
                    **metadata,
                    **no_duration_row,
                })
            if review_candidate:
                candidate, searched_as, duration_values, metadata = review_candidate
                unresolved.update({
                    "searched_as": searched_as,
                    "candidate_game_id": int(candidate.game_id),
                    "candidate_title": candidate.game_name,
                    "candidate_similarity": candidate.similarity,
                    "candidate_main_story_minutes": duration_values[0],
                    "candidate_main_extra_minutes": duration_values[1],
                    "candidate_completionist_minutes": duration_values[2],
                    "candidate_metadata": metadata,
                })
            report.append(unresolved)
            if index == 1 or index % 25 == 0 or index == total_games:
                print(f"Processed {index}/{total_games} duration lookups.", file=sys.stderr, flush=True)
                if args.output:
                    write_report(args.output, report)
            time.sleep(args.delay)
            continue

        result, searched_as, duration_values, metadata = match
        now = datetime.now(timezone.utc).isoformat()
        row = {
            "steam_app_id": appid,
            "provider": "hltb",
            "provider_game_id": int(result.game_id),
            "main_story_minutes": duration_values[0],
            "main_extra_minutes": duration_values[1],
            "completionist_minutes": duration_values[2],
            "submission_count": metadata["submission_count"],
            "match_status": "matched",
            "match_confidence": metadata["match_confidence"],
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
                **metadata,
                **row,
            }
        )
        if index == 1 or index % 25 == 0 or index == total_games:
            print(f"Processed {index}/{total_games} duration lookups.", file=sys.stderr, flush=True)
            if args.output:
                write_report(args.output, report)
        time.sleep(args.delay)

    write_report(args.output, report)


if __name__ == "__main__":
    main()
