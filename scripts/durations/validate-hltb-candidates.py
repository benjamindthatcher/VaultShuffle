#!/usr/bin/env python3
"""Verify reported HLTB candidates against the Steam AppID on their detail page.

This is a read-only report generator. It never connects to Supabase and never
writes duration rows to the database.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
ENRICH_SCRIPT = SCRIPT_DIRECTORY / "enrich-hltb.py"
CHECKPOINT_EVERY = 25
MATCHED_STATUSES = {"matched", "verified_matched"}
POSITIVE_CONFLICT_REJECTION_REASONS = {
    "profile_steam_mismatch",
    "incompatible_game_type",
    "not_pc",
    "not_exact_title",
    "release_year_conflict",
}


def load_enrich_helpers():
    spec = importlib.util.spec_from_file_location("vaultshuffle_enrich_hltb", ENRICH_SCRIPT)
    if not spec or not spec.loader:
        raise RuntimeError(f"Could not import HLTB helpers from {ENRICH_SCRIPT}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HLTB = load_enrich_helpers()


class RequestPacer:
    """Apply one aggregate delay between detail-page request starts."""

    def __init__(self, delay):
        self.delay = delay
        self.next_request_at = 0.0
        self.lock = threading.Lock()

    def wait(self):
        if self.delay <= 0:
            return
        with self.lock:
            remaining = self.next_request_at - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            self.next_request_at = time.monotonic() + self.delay


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Validate HLTB candidate IDs against identity evidence on each candidate's "
            "detail page. Exact profile_steam identity is required by default."
        )
    )
    parser.add_argument("reports", nargs="+", help="JSON candidate report path(s).")
    parser.add_argument("--output", required=True, help="Path for the validation report.")
    parser.add_argument(
        "--delay",
        type=non_negative_float,
        default=0.5,
        help="Minimum aggregate delay between HLTB requests in seconds (default: 0.5).",
    )
    parser.add_argument(
        "--workers",
        type=positive_integer_argument,
        default=4,
        help="Concurrent detail-page workers (default: 4).",
    )
    parser.add_argument(
        "--include-matched",
        action="store_true",
        help=(
            "Also validate provider_game_id values from already matched HLTB rows "
            "for a whole-database audit."
        ),
    )
    parser.add_argument(
        "--allow-safe-title",
        action="store_true",
        help=(
            "When profile_steam is absent, allow the imported identity_evidence gates "
            "to verify a unique candidate from authoritative source titles."
        ),
    )
    parser.add_argument(
        "--resolve-conflicts",
        action="store_true",
        help=(
            "Validate only Steam AppIDs that have multiple candidate HLTB IDs. "
            "A unique exact profile_steam match wins; with --allow-safe-title, a "
            "unique safe-title match may win only when every competitor is "
            "positively rejected. Non-conflicting candidates are not fetched."
        ),
    )
    return parser.parse_args()


def non_negative_float(value):
    parsed = float(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def positive_integer_argument(value):
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def rows_from_document(document, path):
    if isinstance(document, list):
        return document
    if isinstance(document, dict):
        for key in ("results", "rows", "report"):
            if isinstance(document.get(key), list):
                return document[key]
        if any(key in document for key in ("candidate_game_id", "provider_game_id")):
            return [document]
    raise ValueError(f"{path} must contain a JSON array or an object with a results array.")


def clean_text(value):
    return " ".join(str(value or "").split())


def row_status(row):
    return clean_text(row.get("match_status") or row.get("status")).casefold()


def candidate_ids(row, include_matched=False):
    """Return candidate HLTB IDs and their source fields for the selected audit mode."""
    candidates = []
    candidate_game_id = HLTB.positive_integer(row.get("candidate_game_id"))
    if candidate_game_id:
        candidates.append((candidate_game_id, "candidate_game_id"))

    provider_game_id = HLTB.positive_integer(row.get("provider_game_id"))
    provider = clean_text(row.get("provider")).casefold()
    if (
        provider_game_id
        and (include_matched or row_status(row) not in MATCHED_STATUSES)
        and provider in {"", "hltb"}
    ):
        candidates.append((provider_game_id, "provider_game_id"))
    return list(dict.fromkeys(candidates))


def preferred_title(row):
    for key in ("title", "name", "searched_as", "candidate_title", "matched_title"):
        title = clean_text(row.get(key))
        if title:
            return title
    return ""


def text_values(value):
    values = value if isinstance(value, (list, tuple, set)) else [value]
    return [cleaned for item in values if (cleaned := clean_text(item))]


def authoritative_source_titles(row):
    """Keep catalogue titles separate from lossy search/provider labels."""
    titles = []
    for key in ("title", "name", "source_titles"):
        titles.extend(text_values(row.get(key)))
    return list(dict.fromkeys(titles))


def source_release_values(row, singular_key, preserved_key):
    values = []
    for key in (singular_key, preserved_key):
        values.extend(text_values(row.get(key)))
    return list(dict.fromkeys(values))


def source_label(path):
    return str(path.resolve())


def collect_candidates(report_paths, include_matched=False):
    pairs = {}
    input_errors = []
    input_rows = 0
    ignored_rows = 0
    candidate_rows = 0

    for path in sorted(report_paths, key=lambda item: str(item.resolve())):
        try:
            with path.open(encoding="utf-8") as source:
                rows = rows_from_document(json.load(source), path)
        except Exception as error:
            input_errors.append({
                "type": "input_error",
                "path": source_label(path),
                "error_type": type(error).__name__,
                "error": str(error),
            })
            continue

        for row_number, row in enumerate(rows, start=1):
            input_rows += 1
            if not isinstance(row, dict):
                ignored_rows += 1
                continue
            appid = (
                HLTB.positive_integer(row.get("steam_appid"))
                or HLTB.positive_integer(row.get("steam_app_id"))
            )
            ids = candidate_ids(row, include_matched=include_matched)
            if not appid or not ids:
                ignored_rows += 1
                continue
            candidate_rows += 1
            title = preferred_title(row)
            source_titles = authoritative_source_titles(row)
            release_years = source_release_values(
                row, "release_year", "source_release_years"
            )
            release_dates = source_release_values(
                row, "release_date", "source_release_dates"
            )
            for game_id, source_field in ids:
                key = (appid, game_id)
                pair = pairs.setdefault(key, {
                    "steam_appid": appid,
                    "provider_game_id": game_id,
                    "titles": set(),
                    "source_titles": set(),
                    "source_release_years": set(),
                    "source_release_dates": set(),
                    "sources": set(),
                    "source_fields": set(),
                    "source_rows": 0,
                })
                if title:
                    pair["titles"].add(title)
                pair["source_titles"].update(source_titles)
                pair["source_release_years"].update(release_years)
                pair["source_release_dates"].update(release_dates)
                pair["sources"].add(source_label(path))
                pair["source_fields"].add(source_field)
                pair["source_rows"] += 1

    normalized = []
    for pair in pairs.values():
        titles = sorted(pair.pop("titles"), key=lambda value: (value.casefold(), value))
        source_titles = sorted(
            pair.pop("source_titles"), key=lambda value: (value.casefold(), value)
        )
        normalized.append({
            **pair,
            "title": source_titles[0] if source_titles else titles[0] if titles else "",
            "source_titles": source_titles,
            "source_release_years": sorted(pair.pop("source_release_years")),
            "source_release_dates": sorted(pair.pop("source_release_dates")),
            "source_reports": sorted(pair.pop("sources")),
            "source_fields": sorted(pair.pop("source_fields")),
        })
    normalized.sort(key=lambda row: (row["steam_appid"], row["provider_game_id"]))
    return normalized, input_errors, {
        "input_rows": input_rows,
        "ignored_rows": ignored_rows,
        "candidate_rows": candidate_rows,
        "unique_candidate_pairs": len(normalized),
    }


def split_conflicts(candidates, resolve_conflicts=False):
    """Select either ordinary candidates or, explicitly, conflict-only candidates."""
    candidates_by_appid = {}
    for candidate in candidates:
        candidates_by_appid.setdefault(candidate["steam_appid"], []).append(candidate)

    conflicting_appids = {
        appid: sorted(rows, key=result_sort_key)
        for appid, rows in candidates_by_appid.items()
        if len({row["provider_game_id"] for row in rows}) > 1
    }
    conflict_pairs = sum(len(rows) for rows in conflicting_appids.values())
    if resolve_conflicts:
        accepted = [
            candidate
            for appid in sorted(conflicting_appids)
            for candidate in conflicting_appids[appid]
        ]
        return accepted, [], conflict_pairs, len(conflicting_appids)

    accepted = [
        candidate for candidate in candidates
        if candidate["steam_appid"] not in conflicting_appids
    ]
    rejections = [
        conflict_rejection(conflict_candidates, "conflicting_hltb_ids")
        for _, conflict_candidates in sorted(conflicting_appids.items())
    ]
    return accepted, rejections, conflict_pairs, len(conflicting_appids)


def fetch_detail(game_id, title, pacer):
    pacer.wait()
    stub = SimpleNamespace(game_id=game_id, game_name=title, similarity=0.0)
    return HLTB.load_hltb_detail(stub)


def candidate_source_evidence(candidate):
    return {
        "source_titles": candidate.get("source_titles", []),
        "source_release_years": candidate.get("source_release_years", []),
        "source_release_dates": candidate.get("source_release_dates", []),
        "source_reports": candidate.get("source_reports", []),
        "source_fields": candidate.get("source_fields", []),
        "source_rows": candidate.get("source_rows", 0),
    }


def conflict_candidate_evidence(candidate):
    return {
        "provider_game_id": candidate["provider_game_id"],
        "source_titles": candidate.get("source_titles", []),
        "source_release_years": candidate.get("source_release_years", []),
        "source_release_dates": candidate.get("source_release_dates", []),
    }


def conflict_rejection(candidates, reason, **extra):
    ordered = sorted(candidates, key=result_sort_key)
    return {
        "steam_appid": ordered[0]["steam_appid"],
        "status": "rejected",
        "reason": reason,
        "verification_method": "conflict_resolution_rejected",
        "candidate_game_ids": [row["provider_game_id"] for row in ordered],
        "candidate_evidence": [
            conflict_candidate_evidence(row) for row in ordered
        ],
        **extra,
    }


def conflict_evaluation(candidate, detail, outcome, reason):
    return {
        "provider_game_id": candidate["provider_game_id"],
        "matched_title": clean_text(getattr(detail, "game_name", "")),
        "outcome": outcome,
        "reason": reason,
    }


def resolved_conflict_result(result, candidates, strategy, evaluations):
    selected_id = result["provider_game_id"]
    ordered_evaluations = sorted(
        evaluations,
        key=lambda row: row["provider_game_id"],
    )
    return {
        **result,
        "conflict_resolution": {
            "strategy": strategy,
            "candidate_game_ids": sorted(
                candidate["provider_game_id"] for candidate in candidates
            ),
            "selected_provider_game_id": selected_id,
            "candidate_evaluations": ordered_evaluations,
        },
    }


def resolve_conflict_group(
    candidates,
    details_by_game_id,
    checked_at,
    allow_safe_title=False,
    candidate_page_appids=None,
):
    """Resolve one multi-ID Steam app only when identity evidence is decisive."""
    ordered = sorted(candidates, key=result_sort_key)
    appids = {candidate["steam_appid"] for candidate in ordered}
    if len(appids) != 1 or len({row["provider_game_id"] for row in ordered}) < 2:
        raise ValueError("Conflict resolution requires one AppID with multiple HLTB IDs.")

    missing_ids = [
        candidate["provider_game_id"]
        for candidate in ordered
        if candidate["provider_game_id"] not in details_by_game_id
    ]
    if missing_ids:
        return None, conflict_rejection(
            ordered,
            "conflict_detail_pages_incomplete",
            unavailable_candidate_game_ids=missing_ids,
        )

    exact = [
        candidate
        for candidate in ordered
        if HLTB.positive_integer(
            getattr(details_by_game_id[candidate["provider_game_id"]], "profile_steam", None)
        ) == candidate["steam_appid"]
    ]
    if len(exact) > 1:
        return None, conflict_rejection(
            ordered,
            "multiple_profile_steam_exact_candidates",
            exact_candidate_game_ids=[row["provider_game_id"] for row in exact],
        )

    page_appids = candidate_page_appids or {}
    if len(exact) == 1:
        selected = exact[0]
        detail = details_by_game_id[selected["provider_game_id"]]
        result, rejection = verify_candidate(
            selected,
            detail,
            checked_at,
            allow_safe_title=False,
            candidate_page_appids=page_appids.get(
                selected["provider_game_id"], [selected["steam_appid"]]
            ),
        )
        if not result or rejection:
            raise RuntimeError("An exact profile_steam conflict candidate was not verified.")
        evaluations = []
        for candidate in ordered:
            candidate_detail = details_by_game_id[candidate["provider_game_id"]]
            if candidate is selected:
                evaluations.append(conflict_evaluation(
                    candidate,
                    candidate_detail,
                    "selected",
                    "profile_steam_exact",
                ))
                continue
            competing_profile = HLTB.positive_integer(
                getattr(candidate_detail, "profile_steam", None)
            )
            reason = (
                "profile_steam_mismatch"
                if competing_profile is not None
                else "not_selected_direct_appid_precedence"
            )
            evaluations.append(conflict_evaluation(
                candidate,
                candidate_detail,
                "not_selected",
                reason,
            ))
        return resolved_conflict_result(
            result,
            ordered,
            "unique_profile_steam_exact",
            evaluations,
        ), None

    if not allow_safe_title:
        return None, conflict_rejection(
            ordered,
            "conflict_safe_title_resolution_disabled",
        )

    accepted = []
    rejected = []
    evaluations = []
    for candidate in ordered:
        detail = details_by_game_id[candidate["provider_game_id"]]
        result, rejection = verify_candidate(
            candidate,
            detail,
            checked_at,
            allow_safe_title=True,
            candidate_page_appids=page_appids.get(
                candidate["provider_game_id"], [candidate["steam_appid"]]
            ),
        )
        if result:
            accepted.append((candidate, result))
            evaluations.append(conflict_evaluation(
                candidate,
                detail,
                "safe_title_candidate",
                result["verification_method"],
            ))
        elif rejection:
            rejected.append((candidate, rejection))
            evaluations.append(conflict_evaluation(
                candidate,
                detail,
                "rejected" if rejection["reason"] in POSITIVE_CONFLICT_REJECTION_REASONS else "inconclusive",
                rejection["reason"],
            ))
        else:
            raise RuntimeError("Candidate validation produced no result or rejection.")

    if len(accepted) > 1:
        return None, conflict_rejection(
            ordered,
            "multiple_safe_title_candidates",
            candidate_evaluations=evaluations,
        )
    if not accepted:
        reason = (
            "no_conflict_candidate_verified"
            if len(rejected) == len(ordered)
            and all(
                rejection["reason"] in POSITIVE_CONFLICT_REJECTION_REASONS
                for _, rejection in rejected
            )
            else "conflict_identity_inconclusive"
        )
        return None, conflict_rejection(
            ordered,
            reason,
            candidate_evaluations=evaluations,
        )

    selected_candidate, selected_result = accepted[0]
    competitors = [
        rejection
        for candidate, rejection in rejected
        if candidate["provider_game_id"] != selected_candidate["provider_game_id"]
    ]
    if len(competitors) != len(ordered) - 1 or not all(
        rejection["reason"] in POSITIVE_CONFLICT_REJECTION_REASONS
        for rejection in competitors
    ):
        return None, conflict_rejection(
            ordered,
            "safe_title_competitor_not_positively_rejected",
            candidate_evaluations=evaluations,
        )
    return resolved_conflict_result(
        selected_result,
        ordered,
        "unique_safe_title_all_competitors_rejected",
        evaluations,
    ), None


def safe_title_identity(candidate, detail):
    """Apply the imported identity gates to authoritative, unmodified source titles."""
    source_titles = candidate.get("source_titles", [])
    if not source_titles:
        return None, {
            "reason": "no_authoritative_source_title",
            "identity_rejections": ["no_authoritative_source_title"],
        }

    release_years = {
        parsed
        for value in (
            candidate.get("source_release_years", [])
            + candidate.get("source_release_dates", [])
        )
        if (parsed := HLTB.parse_release_year(value))
    }
    release_evidence = sorted(release_years) or [None]
    accepted = []
    rejected_reasons = set()
    for source_title in source_titles:
        title_tiers = []
        title_rejections = []
        for release_year in release_evidence:
            tier, reason = HLTB.identity_evidence(
                detail,
                source_title,
                steam_app_id=candidate["steam_appid"],
                release_year=release_year,
                trusted_titles=source_titles,
            )
            if tier:
                title_tiers.append(tier)
            else:
                title_rejections.append(reason or "identity_rejected")
        if title_tiers and not title_rejections:
            tier = "exact_title" if "exact_title" in title_tiers else title_tiers[0]
            accepted.append((tier, source_title))
        rejected_reasons.update(title_rejections)

    if not accepted:
        reason_order = (
            "different_steam_appid",
            "incompatible_game_type",
            "not_pc",
            "release_year_conflict",
            "short_title_missing_year",
            "not_exact_title",
            "lossy_query_without_appid",
            "identity_rejected",
        )
        ordered_rejections = [
            reason for reason in reason_order if reason in rejected_reasons
        ]
        ordered_rejections.extend(sorted(rejected_reasons - set(ordered_rejections)))
        return None, {
            "reason": ordered_rejections[0] if ordered_rejections else "identity_rejected",
            "identity_rejections": ordered_rejections,
        }

    tier, source_title = sorted(
        accepted,
        key=lambda item: (
            0 if item[0] == "exact_title" else 1,
            item[1].casefold(),
            item[1],
        ),
    )[0]
    main_identity = HLTB.canonical_title(getattr(detail, "game_name", ""))
    method = (
        "safe_exact_title"
        if HLTB.canonical_title(source_title) == main_identity
        else "safe_exact_alias"
    )
    return {
        "verification_method": method,
        "verification_tier": tier,
        "verified_source_title": source_title,
    }, None


def base_result(candidate, detail, checked_at, verification):
    return {
        "steam_appid": candidate["steam_appid"],
        "title": candidate["title"],
        "searched_as": candidate["title"],
        "matched_title": detail.game_name,
        **verification,
        **candidate_source_evidence(candidate),
        "steam_app_id": candidate["steam_appid"],
        "provider": "hltb",
        "provider_game_id": candidate["provider_game_id"],
        "provider_updated_at": None,
        "checked_at": checked_at,
        "updated_at": checked_at,
    }


def rejection_row(candidate, detail, reason, verification_method, **extra):
    return {
        "steam_appid": candidate["steam_appid"],
        "provider_game_id": candidate["provider_game_id"],
        "status": "rejected",
        "reason": reason,
        "matched_title": detail.game_name,
        "verification_method": verification_method,
        **candidate_source_evidence(candidate),
        **extra,
    }


def verify_candidate(
    candidate,
    detail,
    checked_at,
    allow_safe_title=False,
    candidate_page_appids=None,
):
    appid = candidate["steam_appid"]
    page_appids = sorted(set(candidate_page_appids or [appid]))
    profile_steam = HLTB.positive_integer(getattr(detail, "profile_steam", None))
    if profile_steam == appid:
        verification = {
            "verification_method": "profile_steam_exact",
            "verification_tier": "steam_appid",
        }
    elif profile_steam is not None:
        return None, rejection_row(
            candidate,
            detail,
            "profile_steam_mismatch",
            "profile_steam_mismatch",
            page_profile_steam=profile_steam,
        )
    elif not allow_safe_title:
        return None, rejection_row(
            candidate,
            detail,
            "profile_steam_missing",
            "profile_steam_required",
        )
    elif len(page_appids) > 1:
        return None, rejection_row(
            candidate,
            detail,
            "hltb_page_shared_across_steam_appids",
            "safe_title_identity_rejected",
            conflicting_steam_appids=page_appids,
        )
    else:
        verification, title_rejection = safe_title_identity(candidate, detail)
        if not verification:
            return None, rejection_row(
                candidate,
                detail,
                title_rejection["reason"],
                "safe_title_identity_rejected",
                identity_rejections=title_rejection["identity_rejections"],
            )

    values, basis, submission_count, issues = HLTB.duration_values(detail)
    identity_tier = verification["verification_tier"]
    _, _, match_values, metadata = HLTB.match_tuple(
        detail, candidate["title"], identity_tier
    )
    if values != match_values:
        raise RuntimeError("duration_values and match_tuple returned inconsistent durations")
    if (
        basis != metadata["duration_basis"]
        or submission_count != metadata["submission_count"]
        or issues != metadata["duration_issues"]
    ):
        raise RuntimeError("duration_values and match_tuple returned inconsistent metadata")

    row = {
        **base_result(candidate, detail, checked_at, verification),
        **metadata,
        "main_story_minutes": values[0],
        "main_extra_minutes": values[1],
        "completionist_minutes": values[2],
        "submission_count": submission_count,
    }
    if any(value is not None for value in values):
        row.update({
            "status": "verified_matched",
            "verification_status": "verified_matched",
            "match_status": "matched",
            "next_refresh_at": None,
            "last_error_code": None,
        })
    else:
        checked = datetime.fromisoformat(checked_at)
        row.update({
            "status": "verified_no_duration",
            "verification_status": "verified_no_duration",
            "match_status": "no_duration",
            "match_confidence": metadata["identity_confidence"],
            "next_refresh_at": (checked + timedelta(days=90)).isoformat(),
            "last_error_code": "known_title_no_provider_times",
        })
    return row, None


def result_sort_key(row):
    return (row.get("steam_appid", 0), row.get("provider_game_id", 0))


def rejection_sort_key(row):
    ids = row.get("candidate_game_ids") or [row.get("provider_game_id", 0)]
    return (row.get("steam_appid", 0), tuple(ids), row.get("reason", ""))


def error_sort_key(row):
    return (
        row.get("provider_game_id", 0),
        row.get("path", ""),
        row.get("error_type", ""),
        row.get("error", ""),
    )


def build_report(
    state,
    started_at,
    input_paths,
    include_matched,
    allow_safe_title,
    resolve_conflicts,
    input_counts,
    processable_pairs,
    conflict_pairs,
    conflicting_appids,
    completed_pages,
    total_pages,
    results,
    rejections,
    errors,
):
    ordered_results = sorted(results, key=result_sort_key)
    ordered_rejections = sorted(rejections, key=rejection_sort_key)
    ordered_errors = sorted(errors, key=error_sort_key)
    matched = sum(row["verification_status"] == "verified_matched" for row in ordered_results)
    no_duration = sum(
        row["verification_status"] == "verified_no_duration" for row in ordered_results
    )
    return {
        "schema_version": 1,
        "source": "HLTB candidates verified against detail-page identity evidence",
        "state": state,
        "started_at": started_at,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "input_reports": sorted(source_label(path) for path in input_paths),
        "options": {
            "include_matched": include_matched,
            "allow_safe_title": allow_safe_title,
            "resolve_conflicts": resolve_conflicts,
        },
        "counts": {
            **input_counts,
            "conflicting_appids": conflicting_appids,
            "conflicting_candidate_pairs": conflict_pairs,
            "processable_candidate_pairs": processable_pairs,
            "unique_detail_pages": total_pages,
            "completed_detail_pages": completed_pages,
            "verified_matched": matched,
            "verified_no_duration": no_duration,
            "rejections": len(ordered_rejections),
            "errors": len(ordered_errors),
        },
        "results": ordered_results,
        "rejections": ordered_rejections,
        "errors": ordered_errors,
    }


def atomic_write_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as output:
            json.dump(document, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def main():
    args = parse_args()
    input_paths = [Path(value).resolve() for value in args.reports]
    output_path = Path(args.output).resolve()
    if output_path in input_paths:
        raise SystemExit("--output must not overwrite an input report.")

    started_at = datetime.now(timezone.utc).isoformat()
    candidates, input_errors, input_counts = collect_candidates(
        input_paths,
        include_matched=args.include_matched,
    )
    processable, conflict_rejections, conflict_pairs, conflicting_appids = split_conflicts(
        candidates,
        resolve_conflicts=args.resolve_conflicts,
    )
    results = []
    rejections = list(conflict_rejections)
    errors = list(input_errors)

    by_game_id = {}
    for candidate in processable:
        by_game_id.setdefault(candidate["provider_game_id"], []).append(candidate)
    for candidate_group in by_game_id.values():
        candidate_group.sort(key=result_sort_key)

    total_pages = len(by_game_id)
    completed_pages = 0
    details_by_game_id = {}
    checked_at = datetime.now(timezone.utc).isoformat()
    pacer = RequestPacer(args.delay)

    def checkpoint(state):
        atomic_write_json(output_path, build_report(
            state=state,
            started_at=started_at,
            input_paths=input_paths,
            include_matched=args.include_matched,
            allow_safe_title=args.allow_safe_title,
            resolve_conflicts=args.resolve_conflicts,
            input_counts=input_counts,
            processable_pairs=len(processable),
            conflict_pairs=conflict_pairs,
            conflicting_appids=conflicting_appids,
            completed_pages=completed_pages,
            total_pages=total_pages,
            results=results,
            rejections=rejections,
            errors=errors,
        ))

    checkpoint("running" if total_pages else "complete")
    if total_pages:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    fetch_detail,
                    game_id,
                    candidates_for_page[0]["title"],
                    pacer,
                ): game_id
                for game_id, candidates_for_page in sorted(by_game_id.items())
            }
            try:
                for future in as_completed(futures):
                    game_id = futures[future]
                    candidates_for_page = by_game_id[game_id]
                    try:
                        detail = future.result()
                    except Exception as error:
                        errors.append({
                            "type": "detail_page_error",
                            "provider_game_id": game_id,
                            "steam_appids": [
                                candidate["steam_appid"] for candidate in candidates_for_page
                            ],
                            "error_type": type(error).__name__,
                            "error": str(error),
                        })
                    else:
                        if args.resolve_conflicts:
                            details_by_game_id[game_id] = detail
                            completed_pages += 1
                            if completed_pages % CHECKPOINT_EVERY == 0 or completed_pages == total_pages:
                                checkpoint("running")
                                print(
                                    f"Fetched {completed_pages}/{total_pages} conflict-only HLTB detail pages.",
                                    file=sys.stderr,
                                    flush=True,
                                )
                            continue
                        for candidate in candidates_for_page:
                            try:
                                result, rejection = verify_candidate(
                                    candidate,
                                    detail,
                                    checked_at,
                                    allow_safe_title=args.allow_safe_title,
                                    candidate_page_appids=[
                                        row["steam_appid"]
                                        for row in candidates_for_page
                                    ],
                                )
                            except Exception as error:
                                errors.append({
                                    "type": "candidate_validation_error",
                                    "steam_appid": candidate["steam_appid"],
                                    "provider_game_id": game_id,
                                    "error_type": type(error).__name__,
                                    "error": str(error),
                                })
                                continue
                            if result:
                                results.append(result)
                            if rejection:
                                rejections.append(rejection)
                    completed_pages += 1
                    if completed_pages % CHECKPOINT_EVERY == 0 or completed_pages == total_pages:
                        checkpoint("running")
                        print(
                            f"Validated {completed_pages}/{total_pages} unique HLTB detail pages.",
                            file=sys.stderr,
                            flush=True,
                        )
            except KeyboardInterrupt:
                for future in futures:
                    future.cancel()
                checkpoint("interrupted")
                raise

    if args.resolve_conflicts:
        conflict_groups = {}
        for candidate in processable:
            conflict_groups.setdefault(candidate["steam_appid"], []).append(candidate)
        candidate_page_appids = {
            game_id: [candidate["steam_appid"] for candidate in candidates_for_page]
            for game_id, candidates_for_page in by_game_id.items()
        }
        for appid, conflict_candidates in sorted(conflict_groups.items()):
            try:
                result, rejection = resolve_conflict_group(
                    conflict_candidates,
                    details_by_game_id,
                    checked_at,
                    allow_safe_title=args.allow_safe_title,
                    candidate_page_appids=candidate_page_appids,
                )
            except Exception as error:
                errors.append({
                    "type": "conflict_resolution_error",
                    "steam_appid": appid,
                    "provider_game_ids": [
                        row["provider_game_id"] for row in conflict_candidates
                    ],
                    "error_type": type(error).__name__,
                    "error": str(error),
                })
                rejections.append(conflict_rejection(
                    conflict_candidates,
                    "conflict_resolution_error",
                ))
                continue
            if result:
                results.append(result)
            if rejection:
                rejections.append(rejection)

    checkpoint("complete")
    summary = build_report(
        state="complete",
        started_at=started_at,
        input_paths=input_paths,
        include_matched=args.include_matched,
        allow_safe_title=args.allow_safe_title,
        resolve_conflicts=args.resolve_conflicts,
        input_counts=input_counts,
        processable_pairs=len(processable),
        conflict_pairs=conflict_pairs,
        conflicting_appids=conflicting_appids,
        completed_pages=completed_pages,
        total_pages=total_pages,
        results=results,
        rejections=rejections,
        errors=errors,
    )["counts"]
    print(json.dumps({
        "stage": "hltb_candidate_validation_complete",
        "output_path": str(output_path),
        **summary,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
