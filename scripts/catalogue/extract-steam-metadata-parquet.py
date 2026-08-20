#!/usr/bin/env python3
"""Extract VaultShuffle catalogue fields from a local Steam metadata snapshot."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as parquet


COLUMNS = [
    "appID",
    "name",
    "release_date",
    "price",
    "short_description",
    "header_image",
    "windows",
    "mac",
    "linux",
    "positive",
    "negative",
    "developers",
    "publishers",
    "categories",
    "genres",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--captured-at", default="2025-12-18")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    parquet_path = Path(args.parquet).resolve()
    output_path = Path(args.output).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    wanted = {
        positive_integer(game.get("steam_appid"))
        for game in manifest.get("games", [])
    }
    wanted.discard(None)
    if not wanted:
        raise ValueError("The manifest contains no valid Steam AppIDs.")

    table = parquet.read_table(parquet_path, columns=COLUMNS)
    rows = table.to_pylist()
    results: dict[int, dict] = {}
    duplicate_rows = 0
    for row in rows:
        steam_appid = positive_integer(row.get("appID"))
        if steam_appid not in wanted:
            continue
        name = clean_text(row.get("name"))
        if not name:
            continue
        if steam_appid in results:
            duplicate_rows += 1
            continue

        positive = non_negative_integer(row.get("positive")) or 0
        negative = non_negative_integer(row.get("negative")) or 0
        price_final = price_minor_units(row.get("price"))
        genres = clean_list(row.get("genres"))
        is_free = price_final == 0 and any(
            genre.casefold() == "free to play" for genre in genres
        )
        results[steam_appid] = {
            "steam_appid": steam_appid,
            "source_name": name,
            "status": "ready",
            "source": "huggingface:Z02Z/steam-games-dataset",
            "source_captured_at": args.captured_at,
            "metadata": {
                "steam_appid": steam_appid,
                "name": name,
                "normalized_name": normalize_name(name) or name.lower(),
                "steam_type": "game",
                "developer": join_names(row.get("developers")),
                "publisher": join_names(row.get("publishers")),
                "genres": genres,
                "categories": clean_list(row.get("categories")),
                "short_description": clean_text(row.get("short_description")) or None,
                "release_date": release_date(row.get("release_date")),
                "is_free": is_free,
                "capsule_url": (
                    f"https://cdn.akamai.steamstatic.com/steam/apps/{steam_appid}/"
                    "library_600x900_2x.jpg"
                ),
                "header_url": clean_text(row.get("header_image")) or (
                    f"https://cdn.akamai.steamstatic.com/steam/apps/{steam_appid}/header.jpg"
                ),
                "review_positive": positive,
                "review_negative": negative,
                "review_total": positive + negative,
                "price_currency": "USD" if price_final and price_final > 0 else None,
                "price_initial": price_final if price_final and price_final > 0 else None,
                "price_final": price_final if price_final and price_final > 0 else None,
                "discount_percent": 0,
                "platform_windows": boolean_or_none(row.get("windows")),
                "platform_mac": boolean_or_none(row.get("mac")),
                "platform_linux": boolean_or_none(row.get("linux")),
                "deck_compatibility": None,
                "deck_checked_at": None,
                "metadata_fetched_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        }

    ordered = [results[steam_appid] for steam_appid in sorted(results)]
    output = {
        "schema_version": 1,
        "source": "huggingface:Z02Z/steam-games-dataset",
        "source_license": "CC BY 4.0",
        "source_captured_at": args.captured_at,
        "manifest_path": str(manifest_path),
        "parquet_path": str(parquet_path),
        "manifest_rows": len(wanted),
        "matched_rows": len(ordered),
        "missing_rows": len(wanted) - len(ordered),
        "duplicate_source_rows": duplicate_rows,
        "results": ordered,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "stage": "steam_snapshot_extract_complete",
        "manifest_rows": len(wanted),
        "matched_rows": len(ordered),
        "missing_rows": len(wanted) - len(ordered),
        "duplicate_source_rows": duplicate_rows,
        "output_path": str(output_path),
    }))


def positive_integer(value: object) -> int | None:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def non_negative_integer(value: object) -> int | None:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def price_minor_units(value: object) -> int | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0:
        return None
    return round(parsed * 100)


def clean_text(value: object) -> str:
    return " ".join(str(value or "").strip().split())


def normalize_name(value: object) -> str:
    return " ".join("".join(
        character.lower() if character.isascii() and character.isalnum() else " "
        for character in clean_text(value)
    ).split())


def clean_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [cleaned for item in value if (cleaned := clean_text(item))]


def join_names(value: object) -> str | None:
    names = clean_list(value)
    return ", ".join(names) if names else None


def boolean_or_none(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def release_date(value: object) -> str | None:
    raw = clean_text(value)
    if not raw:
        return None
    for pattern in ("%b %d, %Y", "%Y-%m-%d", "%d %b, %Y"):
        try:
            return datetime.strptime(raw, pattern).date().isoformat()
        except ValueError:
            continue
    return None


if __name__ == "__main__":
    main()
