#!/usr/bin/env python3

import importlib.util
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).with_name("validate-hltb-candidates.py")
SPEC = importlib.util.spec_from_file_location("validate_hltb_candidates", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
CHECKED_AT = "2026-08-25T12:00:00+00:00"


def candidate(appid, game_id, title="Alpha", release_year=2023):
    return {
        "steam_appid": appid,
        "provider_game_id": game_id,
        "title": title,
        "source_titles": [title],
        "source_release_years": [str(release_year)] if release_year else [],
        "source_release_dates": [],
        "source_reports": ["fixture.json"],
        "source_fields": ["candidate_game_id"],
        "source_rows": 1,
    }


def detail(
    game_id,
    title="Alpha",
    *,
    alias="",
    profile_steam=None,
    release_world=2023,
    game_type="game",
    platforms="PC",
    main_story=10,
    completion_count=12,
):
    return SimpleNamespace(
        game_id=game_id,
        game_name=title,
        game_alias=alias,
        game_type=game_type,
        release_world=release_world,
        profile_platforms=platforms,
        profile_steam=profile_steam,
        main_story=main_story,
        main_extra=None,
        completionist=None,
        all_styles=None,
        coop_time=None,
        mp_time=None,
        completion_count=completion_count,
        coop_count=0,
        mp_count=0,
        complexity_lvl_sp=True,
        complexity_lvl_co=False,
        complexity_lvl_mp=False,
        json_content={},
    )


class ConflictSelectionTests(TestCase):
    def test_default_mode_still_pre_rejects_conflicts(self):
        rows = [candidate(10, 101), candidate(10, 102), candidate(20, 201)]

        processable, rejections, conflict_pairs, conflict_apps = MODULE.split_conflicts(rows)

        self.assertEqual([row["provider_game_id"] for row in processable], [201])
        self.assertEqual(conflict_pairs, 2)
        self.assertEqual(conflict_apps, 1)
        self.assertEqual(len(rejections), 1)
        self.assertEqual(rejections[0]["reason"], "conflicting_hltb_ids")
        self.assertEqual(rejections[0]["candidate_game_ids"], [101, 102])

    def test_opt_in_mode_selects_only_conflicting_pairs(self):
        rows = [candidate(10, 101), candidate(10, 102), candidate(20, 201)]

        processable, rejections, conflict_pairs, conflict_apps = MODULE.split_conflicts(
            rows,
            resolve_conflicts=True,
        )

        self.assertEqual(
            [row["provider_game_id"] for row in processable],
            [101, 102],
        )
        self.assertEqual(rejections, [])
        self.assertEqual(conflict_pairs, 2)
        self.assertEqual(conflict_apps, 1)


class ConflictResolutionTests(TestCase):
    def resolve(self, rows, details, allow_safe_title=True, page_appids=None):
        return MODULE.resolve_conflict_group(
            rows,
            details,
            CHECKED_AT,
            allow_safe_title=allow_safe_title,
            candidate_page_appids=page_appids,
        )

    def test_unique_exact_profile_steam_wins_even_if_competitor_has_same_title(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, profile_steam=10),
            102: detail(102),
        }

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(rejection)
        self.assertEqual(result["provider_game_id"], 101)
        self.assertEqual(result["verification_method"], "profile_steam_exact")
        self.assertEqual(
            result["conflict_resolution"]["strategy"],
            "unique_profile_steam_exact",
        )

    def test_multiple_exact_profile_steam_pages_remain_conflicted(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, profile_steam=10),
            102: detail(102, profile_steam=10),
        }

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(result)
        self.assertEqual(rejection["reason"], "multiple_profile_steam_exact_candidates")

    def test_unique_safe_title_wins_only_when_competitor_is_positive_mismatch(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, title="Alpha"),
            102: detail(102, title="Different Game"),
        }

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(rejection)
        self.assertEqual(result["provider_game_id"], 101)
        self.assertEqual(result["verification_method"], "safe_exact_title")
        self.assertEqual(
            result["conflict_resolution"]["strategy"],
            "unique_safe_title_all_competitors_rejected",
        )

    def test_unique_safe_alias_uses_the_same_competitor_rule(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, title="Alpha: The Game", alias="Alpha"),
            102: detail(102, title="Different Game"),
        }

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(rejection)
        self.assertEqual(result["provider_game_id"], 101)
        self.assertEqual(result["verification_method"], "safe_exact_alias")

    def test_safe_title_does_not_win_against_inconclusive_short_title_page(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, title="Alpha"),
            102: detail(102, title="Alpha", release_world=None),
        }

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(result)
        self.assertEqual(
            rejection["reason"],
            "safe_title_competitor_not_positively_rejected",
        )
        inconclusive = [
            row for row in rejection["candidate_evaluations"]
            if row["provider_game_id"] == 102
        ][0]
        self.assertEqual(inconclusive["outcome"], "inconclusive")
        self.assertEqual(inconclusive["reason"], "short_title_missing_year")

    def test_multiple_safe_title_pages_remain_conflicted(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {101: detail(101), 102: detail(102)}

        result, rejection = self.resolve(rows, details)

        self.assertIsNone(result)
        self.assertEqual(rejection["reason"], "multiple_safe_title_candidates")

    def test_missing_detail_page_never_allows_resolution(self):
        rows = [candidate(10, 101), candidate(10, 102)]

        result, rejection = self.resolve(rows, {101: detail(101, profile_steam=10)})

        self.assertIsNone(result)
        self.assertEqual(rejection["reason"], "conflict_detail_pages_incomplete")
        self.assertEqual(rejection["unavailable_candidate_game_ids"], [102])

    def test_safe_title_resolution_requires_explicit_opt_in(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, title="Alpha"),
            102: detail(102, title="Different Game"),
        }

        result, rejection = self.resolve(rows, details, allow_safe_title=False)

        self.assertIsNone(result)
        self.assertEqual(rejection["reason"], "conflict_safe_title_resolution_disabled")

    def test_shared_page_is_inconclusive_for_safe_title_fallback(self):
        rows = [candidate(10, 101), candidate(10, 102)]
        details = {
            101: detail(101, title="Alpha"),
            102: detail(102, title="Different Game"),
        }

        result, rejection = self.resolve(
            rows,
            details,
            page_appids={101: [10], 102: [10, 20]},
        )

        self.assertIsNone(result)
        self.assertEqual(
            rejection["reason"],
            "safe_title_competitor_not_positively_rejected",
        )


class ConflictOnlyCliTests(TestCase):
    def test_cli_fetches_conflict_pages_but_not_non_conflicting_page(self):
        rows = [
            {"steam_appid": 10, "candidate_game_id": 101, "title": "Alpha", "release_year": 2023},
            {"steam_appid": 10, "candidate_game_id": 102, "title": "Alpha", "release_year": 2023},
            {"steam_appid": 20, "candidate_game_id": 201, "title": "Beta", "release_year": 2023},
        ]
        details = {
            101: detail(101, profile_steam=10),
            102: detail(102, title="Different Game"),
            201: detail(201, title="Beta", profile_steam=20),
        }

        with TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.json"
            output_path = Path(directory) / "output.json"
            input_path.write_text(json.dumps(rows), encoding="utf-8")

            def fetch(game_id, _title, _pacer):
                return details[game_id]

            argv = [
                str(SCRIPT_PATH),
                str(input_path),
                "--output",
                str(output_path),
                "--resolve-conflicts",
                "--allow-safe-title",
                "--delay",
                "0",
                "--workers",
                "2",
            ]
            with (
                patch.object(sys, "argv", argv),
                patch.object(MODULE, "fetch_detail", side_effect=fetch) as fetched,
            ):
                self.assertEqual(MODULE.main(), 0)

            report = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(sorted(call.args[0] for call in fetched.call_args_list), [101, 102])
        self.assertEqual(report["counts"]["processable_candidate_pairs"], 2)
        self.assertEqual(report["counts"]["unique_detail_pages"], 2)
        self.assertEqual(report["counts"]["conflicting_appids"], 1)
        self.assertEqual([row["steam_appid"] for row in report["results"]], [10])
        self.assertEqual(report["rejections"], [])
        self.assertTrue(report["options"]["resolve_conflicts"])


if __name__ == "__main__":
    main()
