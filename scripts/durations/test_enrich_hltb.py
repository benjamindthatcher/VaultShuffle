#!/usr/bin/env python3

import importlib.util
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).with_name("enrich-hltb.py")
SPEC = importlib.util.spec_from_file_location("enrich_hltb", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def entry(
    game_id,
    game_name,
    *,
    game_alias="",
    game_type="game",
    release_world=2023,
    profile_platforms="PC",
    similarity=1.0,
    profile_steam=None,
    main_story=None,
    main_extra=None,
    completionist=None,
    all_styles=None,
    coop_time=None,
    mp_time=None,
    completion_count=0,
    coop_count=0,
    mp_count=0,
):
    return SimpleNamespace(
        game_id=game_id,
        game_name=game_name,
        game_alias=game_alias,
        game_type=game_type,
        release_world=release_world,
        profile_platforms=profile_platforms,
        similarity=similarity,
        profile_steam=profile_steam,
        main_story=main_story,
        main_extra=main_extra,
        completionist=completionist,
        all_styles=all_styles,
        coop_time=coop_time,
        mp_time=mp_time,
        completion_count=completion_count,
        coop_count=coop_count,
        mp_count=mp_count,
        complexity_lvl_sp=False,
        complexity_lvl_co=bool(coop_time),
        complexity_lvl_mp=bool(mp_time),
        json_content={},
    )


class DurationMatcherTests(TestCase):
    def test_stdin_reader_accepts_json_arrays_and_ndjson(self):
        expected = [
            {"steam_appid": 10, "name": "One"},
            {"steam_appid": 20, "name": "Two"},
        ]

        self.assertEqual(MODULE.read_stdin_games(StringIO(json.dumps(expected))), expected)
        ndjson = "\n".join(json.dumps(row) for row in expected) + "\n\n"
        self.assertEqual(MODULE.read_stdin_games(StringIO(ndjson)), expected)

    def run_match(
        self,
        search_results,
        *,
        title,
        appid=None,
        release_year=None,
        trusted_titles=None,
        details=None,
    ):
        details = details or {candidate.game_id: candidate for candidate in search_results}

        def load_detail(candidate):
            return details[candidate.game_id]

        with (
            patch.object(MODULE, "search_hltb", return_value=search_results) as search,
            patch.object(MODULE, "load_hltb_detail", side_effect=load_detail) as load,
        ):
            result = MODULE.best_match(
                [title],
                steam_app_id=appid,
                release_year=release_year,
                trusted_titles=trusted_titles or [title],
            )

        search.assert_called_once_with(title)
        self.assertGreaterEqual(load.call_count, 1)
        return result

    def test_mixed_script_titles_search_the_english_portion_first(self):
        self.assertEqual(MODULE.title_variants("Gujian3(古剑奇谭三)")[0], "Gujian3")
        self.assertEqual(
            MODULE.title_variants("鬼谷八荒 Tale of Immortal")[0],
            "Tale of Immortal",
        )

    def test_uppercase_titles_include_non_uppercase_search_variants(self):
        variants = MODULE.title_variants("PAYDAY 3")

        self.assertIn("Payday 3", variants)
        self.assertIn("payday 3", variants)

    def test_direct_profile_steam_match_is_highest_confidence_identity(self):
        candidate = entry(
            131658,
            "EA Sports FC 24",
            profile_steam=2195250,
            main_story=42,
            main_extra=104.34,
            completionist=150,
            completion_count=20,
        )

        match, errors, review, no_duration = self.run_match(
            [candidate],
            title="EA SPORTS FC 24",
            appid=2195250,
            release_year=2023,
        )

        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIsNone(no_duration)
        self.assertIs(match[0], candidate)
        self.assertEqual(match[2], [2520, 6260, 9000])
        self.assertEqual(match[3]["identity_tier"], "steam_appid")
        self.assertEqual(match[3]["match_confidence"], "high")

    def test_different_profile_steam_is_never_accepted_as_direct_match(self):
        candidate = entry(
            131658,
            "EA Sports FC 24",
            profile_steam=999999,
            main_story=42,
            completion_count=20,
        )

        match, errors, review, no_duration = self.run_match(
            [candidate],
            title="EA Sports FC 24",
            appid=2195250,
            release_year=2023,
        )

        self.assertIsNone(match)
        self.assertEqual(errors, [])
        self.assertIsNone(no_duration)
        self.assertIsNotNone(review)
        self.assertEqual(review[3]["review_reason"], "different_steam_appid")

    def test_empty_pure_non_latin_identities_never_exact_match(self):
        candidate = entry(
            9001,
            "冒険",
            release_world=None,
            similarity=1.0,
            main_story=10,
            completion_count=12,
        )

        match, errors, _review, no_duration = self.run_match(
            [candidate],
            title="生存",
        )

        self.assertTrue(MODULE.normalized("冒険"))
        self.assertTrue(MODULE.normalized("生存"))
        self.assertNotEqual(MODULE.normalized("冒険"), MODULE.normalized("生存"))
        self.assertIsNone(match)
        self.assertEqual(errors, [])
        self.assertIsNone(no_duration)

    def test_sequel_numbers_must_match_but_roman_and_arabic_forms_are_compatible(self):
        self.assertFalse(MODULE.numbers_compatible("PAYDAY 3", "PAYDAY 2"))
        self.assertTrue(MODULE.numbers_compatible("Redout II", "Redout 2"))
        self.assertFalse(MODULE.numbers_compatible("Redout III", "Redout 2"))

        wrong_sequel = entry(
            999,
            "PAYDAY 2",
            similarity=0.95,
            main_story=10,
            completion_count=20,
        )
        match, _errors, _review, _no_duration = self.run_match(
            [wrong_sequel],
            title="PAYDAY 3",
            release_year=2023,
        )
        self.assertIsNone(match)

        redout = entry(
            105621,
            "Redout II",
            game_alias="Redout 2",
            release_world=2022,
            main_story=32.58,
            main_extra=49.77,
            completion_count=15,
        )
        match, errors, review, no_duration = self.run_match(
            [redout],
            title="Redout 2",
            release_year=2022,
        )
        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIsNone(no_duration)
        self.assertIs(match[0], redout)
        self.assertEqual(match[3]["identity_tier"], "exact_title")

    def test_release_year_conflict_and_short_missing_year_require_review(self):
        conflicting = entry(
            4673,
            "Prey",
            release_world=2006,
            main_story=12,
            completion_count=20,
        )
        match, _errors, review, _no_duration = self.run_match(
            [conflicting],
            title="Prey",
            release_year=2017,
        )
        self.assertIsNone(match)
        self.assertEqual(review[3]["review_reason"], "release_year_conflict")

        missing_year = entry(
            4674,
            "Prey",
            release_world=None,
            main_story=12,
            completion_count=20,
        )
        match, _errors, review, _no_duration = self.run_match(
            [missing_year],
            title="Prey",
            release_year=2017,
        )
        self.assertIsNone(match)
        self.assertEqual(review[3]["review_reason"], "short_title_missing_year")

    def test_edition_stripped_queries_cannot_auto_match_without_appid(self):
        cases = [
            ("FINAL FANTASY VII", "FINAL FANTASY VII REMAKE", "Final Fantasy VII"),
            ("OneShot", "OneShot: World Machine Edition", "OneShot"),
        ]
        for index, (query, trusted_title, result_title) in enumerate(cases, start=1):
            with self.subTest(trusted_title=trusted_title):
                candidate = entry(
                    7000 + index,
                    result_title,
                    similarity=1.0,
                    main_story=20,
                    completion_count=20,
                )
                match, _errors, review, no_duration = self.run_match(
                    [candidate],
                    title=query,
                    trusted_titles=[trusted_title],
                )
                self.assertIsNone(match)
                self.assertIsNone(no_duration)
                self.assertIsNotNone(review)
                self.assertEqual(review[3]["review_reason"], "lossy_query_without_appid")

    def test_exact_appid_without_any_time_is_preserved_as_verified_no_duration(self):
        candidate = entry(
            88943,
            "A Known Game Without Times",
            profile_steam=1468810,
            completion_count=0,
        )

        match, errors, review, no_duration = self.run_match(
            [candidate],
            title="A Known Game Without Times",
            appid=1468810,
            release_year=2023,
        )

        self.assertIsNone(match)
        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIs(no_duration[0], candidate)
        self.assertEqual(no_duration[2], [None, None, None])
        self.assertEqual(no_duration[3]["identity_tier"], "steam_appid")
        self.assertEqual(no_duration[3]["duration_basis"], "no_duration")
        self.assertEqual(no_duration[3]["identity_confidence"], "high")

    def test_lower_valid_result_is_not_hidden_by_top_result_with_no_time(self):
        no_time = entry(
            60001,
            "World War 3",
            similarity=1.0,
        )
        valid = entry(
            64185,
            "World War 3",
            similarity=0.9,
            profile_steam=674020,
            main_story=11.95,
            completion_count=12,
        )

        match, errors, review, no_duration = self.run_match(
            [no_time, valid],
            title="World War 3",
            appid=674020,
            release_year=2018,
        )

        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIsNone(no_duration)
        self.assertIs(match[0], valid)
        self.assertEqual(match[2], [717, None, None])

    def test_world_war_3_multiplayer_time_becomes_medium_representative_estimate(self):
        candidate = entry(
            64185,
            "World War 3",
            profile_steam=674020,
            coop_time=12.0,
            coop_count=2,
            mp_time=11.9,
            mp_count=2,
        )

        match, errors, review, no_duration = self.run_match(
            [candidate],
            title="World War 3",
            appid=674020,
            release_year=2018,
        )

        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIsNone(no_duration)
        self.assertEqual(match[2], [717, None, None])
        self.assertEqual(match[3]["duration_basis"], "multiplayer_representative")
        self.assertEqual(match[3]["submission_count"], 4)
        self.assertEqual(match[3]["match_confidence"], "medium")

    def test_field_anomalies_are_removed_and_reduce_confidence(self):
        candidate = entry(
            9100,
            "Anomalous Adventure",
            profile_steam=9100,
            main_story=10,
            main_extra=8,
            completionist=150,
            completion_count=20,
        )

        match, errors, review, no_duration = self.run_match(
            [candidate],
            title="Anomalous Adventure",
            appid=9100,
            release_year=2023,
        )

        self.assertEqual(errors, [])
        self.assertIsNone(review)
        self.assertIsNone(no_duration)
        self.assertEqual(match[2], [600, None, None])
        self.assertEqual(
            match[3]["duration_issues"],
            ["main_extra_below_main_story", "completionist_extreme_ratio"],
        )
        self.assertEqual(match[3]["match_confidence"], "medium")


if __name__ == "__main__":
    main()
