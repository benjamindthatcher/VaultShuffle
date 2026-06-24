import json
import os
import random
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from game import Game
from recommend import RandomBacklogRecommender, TopThreeBacklogRecommender, TopThreeWishlistRecommender
from stats import StatisticsManager
from storage import CSVStorage


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
SEED_FILE = BASE_DIR / "games.csv"
DB_FILE = BASE_DIR / "backlog.db"
HOST = "127.0.0.1"
PORT = int(os.environ.get("BACKLOG_WEB_PORT", "8766"))
GAME_FIELDS = Game.csv_fields()
NUMBER_FIELDS = {"rating", "hours_played", "completion_percentage"}
STEAM_OPENID_URL = "https://steamcommunity.com/openid/login"
SESSION_COOKIE = "vault_session"
SESSION_DAYS = 30
STEAM_KEY_SETTING = "steam_web_api_key"


def connect():
    connection = sqlite3.connect(DB_FILE)
    connection.row_factory = sqlite3.Row
    return connection


def ensure_database():
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                genre TEXT NOT NULL DEFAULT 'Unknown',
                store TEXT NOT NULL DEFAULT 'Steam',
                ownership TEXT NOT NULL DEFAULT 'Owned',
                status TEXT NOT NULL DEFAULT 'Not Started',
                rating INTEGER NOT NULL DEFAULT 0,
                hours_played REAL NOT NULL DEFAULT 0,
                completion_percentage INTEGER NOT NULL DEFAULT 0,
                priority TEXT NOT NULL DEFAULT 'Medium',
                date_added TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                steam_appid TEXT NOT NULL DEFAULT ''
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS steam_users (
                steam_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                avatar_url TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                last_login TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                steam_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (steam_id) REFERENCES steam_users(steam_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        count = connection.execute("SELECT COUNT(*) FROM games").fetchone()[0]
        if count == 0 and SEED_FILE.exists():
            for game in CSVStorage().load_games(str(SEED_FILE)):
                insert_game(connection, game, commit=False)
        connection.commit()


def load_games():
    ensure_database()
    with connect() as connection:
        rows = connection.execute("SELECT * FROM games ORDER BY title COLLATE NOCASE").fetchall()
    return [row_to_game(row) for row in rows]


def row_to_game(row):
    game = Game(
        title=row["title"],
        genre=row["genre"],
        store=row["store"],
        ownership=row["ownership"],
        status=row["status"],
        rating=int(row["rating"] or 0),
        hours_played=float(row["hours_played"] or 0),
        completion_percentage=int(row["completion_percentage"] or 0),
        priority=row["priority"],
        date_added=row["date_added"],
        notes=row["notes"],
        steam_appid=row["steam_appid"],
    )
    game.db_id = row["id"]
    return game


def game_to_dict(game):
    data = game.to_dict()
    data["id"] = getattr(game, "db_id", None)
    return data


def game_from_payload(payload):
    return Game(
        title=str(payload.get("title", "")).strip(),
        genre=str(payload.get("genre", "")).strip() or "Unknown",
        store=str(payload.get("store", "")).strip() or "Steam",
        ownership=str(payload.get("ownership", "Owned")).strip() or "Owned",
        status=str(payload.get("status", "Not Started")).strip() or "Not Started",
        rating=int(float(payload.get("rating") or 0)),
        hours_played=float(payload.get("hours_played") or 0),
        completion_percentage=int(float(payload.get("completion_percentage") or 0)),
        priority=str(payload.get("priority", "Medium")).strip() or "Medium",
        date_added=str(payload.get("date_added", "")).strip(),
        notes=str(payload.get("notes", "")).strip(),
        steam_appid=str(payload.get("steam_appid", "")).strip(),
    )


def insert_game(connection, game, commit=True):
    values = game.to_dict()
    cursor = connection.execute(
        f"""
        INSERT INTO games ({", ".join(GAME_FIELDS)})
        VALUES ({", ".join("?" for _ in GAME_FIELDS)})
        """,
        [values[field] for field in GAME_FIELDS],
    )
    if commit:
        connection.commit()
    game.db_id = cursor.lastrowid
    return game


def update_game(game_id, game):
    values = game.to_dict()
    with connect() as connection:
        exists = connection.execute("SELECT id FROM games WHERE id = ?", (game_id,)).fetchone()
        if not exists:
            return None
        assignments = ", ".join(f"{field} = ?" for field in GAME_FIELDS)
        connection.execute(
            f"UPDATE games SET {assignments} WHERE id = ?",
            [values[field] for field in GAME_FIELDS] + [game_id],
        )
        connection.commit()
    game.db_id = game_id
    return game


def patch_game(game_id, payload):
    updates = {}
    for key, value in payload.items():
        if key in GAME_FIELDS:
            updates[key] = normalize_field(key, value)
    if updates.get("status") == "Completed":
        updates["completion_percentage"] = 100
    if not updates:
        return find_game(game_id)
    with connect() as connection:
        exists = connection.execute("SELECT id FROM games WHERE id = ?", (game_id,)).fetchone()
        if not exists:
            return None
        fields = list(updates)
        assignments = ", ".join(f"{field} = ?" for field in fields)
        connection.execute(
            f"UPDATE games SET {assignments} WHERE id = ?",
            [updates[field] for field in fields] + [game_id],
        )
        connection.commit()
    return find_game(game_id)


def delete_game(game_id):
    game = find_game(game_id)
    if not game:
        return None
    with connect() as connection:
        connection.execute("DELETE FROM games WHERE id = ?", (game_id,))
        connection.commit()
    return game


def find_game(game_id):
    ensure_database()
    with connect() as connection:
        row = connection.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    return row_to_game(row) if row else None


def normalize_field(key, value):
    if key in NUMBER_FIELDS:
        if key == "hours_played":
            return float(value or 0)
        return int(float(value or 0))
    return str(value or "").strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def today_label():
    return datetime.now().strftime("%d/%m/%Y")


def steam_auth_url(base_url):
    base_url = base_url.rstrip("/")
    params = {
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": f"{base_url}/auth/steam/callback",
        "openid.realm": f"{base_url}/",
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    }
    return f"{STEAM_OPENID_URL}?{urlencode(params)}"


def verify_steam_openid(query):
    params = {key: value[0] for key, value in query.items()}
    params["openid.mode"] = "check_authentication"
    request = Request(STEAM_OPENID_URL, data=urlencode(params).encode("utf-8"), method="POST")
    with urlopen(request, timeout=20) as response:
        text = response.read().decode("utf-8", errors="ignore")
    return "is_valid:true" in text


def steam_id_from_openid(query):
    claimed_id = query.get("openid.claimed_id", [""])[0]
    match = re.search(r"/id/(\d+)$", claimed_id)
    return match.group(1) if match else ""


def upsert_steam_user(steam_id):
    timestamp = now_iso()
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO steam_users (steam_id, created_at, last_login)
            VALUES (?, ?, ?)
            ON CONFLICT(steam_id) DO UPDATE SET last_login = excluded.last_login
            """,
            (steam_id, timestamp, timestamp),
        )
        connection.commit()


def create_session(steam_id):
    token = secrets.token_urlsafe(32)
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(days=SESSION_DAYS)
    with connect() as connection:
        connection.execute(
            "INSERT INTO sessions (token, steam_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, steam_id, created_at.isoformat(), expires_at.isoformat()),
        )
        connection.commit()
    return token


def find_session(token):
    if not token:
        return None
    ensure_database()
    with connect() as connection:
        row = connection.execute(
            """
            SELECT sessions.token, sessions.steam_id, sessions.expires_at, steam_users.display_name, steam_users.avatar_url
            FROM sessions
            JOIN steam_users ON steam_users.steam_id = sessions.steam_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
    if not row:
        return None
    try:
        expires_at = datetime.fromisoformat(row["expires_at"])
    except ValueError:
        return None
    if expires_at <= datetime.now(timezone.utc):
        with connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
            connection.commit()
        return None
    return dict(row)


def get_setting(key, default=""):
    ensure_database()
    env_value = os.environ.get("STEAM_WEB_API_KEY", "").strip() if key == STEAM_KEY_SETTING else ""
    if env_value:
        return env_value
    with connect() as connection:
        row = connection.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value):
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        connection.commit()


def fetch_json(url, timeout=20):
    request = Request(url, headers={"User-Agent": "VaultShuffle/0.1"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="ignore"))


def steam_store_search(term):
    if not term.strip():
        return []
    payload = fetch_json(
        "https://store.steampowered.com/api/storesearch/?"
        + urlencode({"term": term.strip(), "cc": "GB", "l": "en"}),
        timeout=15,
    )
    items = payload.get("items", []) if isinstance(payload, dict) else []
    results = []
    for item in items[:12]:
        appid = str(item.get("id") or item.get("appid") or "").strip()
        name = str(item.get("name") or "").strip()
        if not appid or not name:
            continue
        results.append(
            {
                "appid": appid,
                "name": name,
                "image": item.get("tiny_image", ""),
                "store_url": f"https://store.steampowered.com/app/{appid}/",
            }
        )
    return results


def import_owned_steam_games(steam_id, api_key):
    payload = fetch_json(
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?"
        + urlencode(
            {
                "key": api_key,
                "steamid": steam_id,
                "include_appinfo": 1,
                "include_played_free_games": 1,
                "format": "json",
            }
        ),
        timeout=30,
    )
    games = payload.get("response", {}).get("games", []) if isinstance(payload, dict) else []
    imported = []
    with connect() as connection:
        for item in games:
            appid = str(item.get("appid", "")).strip()
            name = str(item.get("name", "")).strip()
            if not appid or not name:
                continue
            hours = round(float(item.get("playtime_forever") or 0) / 60, 1)
            game = Game(
                title=name,
                genre="Unknown",
                store="Steam",
                ownership="Owned",
                status="In Progress" if hours else "Not Started",
                rating=0,
                hours_played=hours,
                completion_percentage=0,
                priority="Medium",
                date_added=today_label(),
                notes=f"Imported from Steam account. AppID: {appid}",
                steam_appid=appid,
            )
            imported.append(upsert_steam_game(connection, game))
        connection.commit()
    return imported


def upsert_steam_game(connection, game):
    existing = None
    if game.steam_appid:
        existing = connection.execute(
            "SELECT * FROM games WHERE steam_appid = ?",
            (game.steam_appid,),
        ).fetchone()
    if existing:
        updates = {field: existing[field] for field in GAME_FIELDS}
        updates["title"] = game.title
        updates["store"] = "Steam"
        updates["steam_appid"] = game.steam_appid
        updates["hours_played"] = game.hours_played
        if not existing["genre"] or existing["genre"] == "Unknown":
            updates["genre"] = game.genre
        if existing["status"] != "Completed" and game.status == "In Progress":
            updates["status"] = "In Progress"
        if not existing["date_added"]:
            updates["date_added"] = game.date_added
        if not existing["notes"]:
            updates["notes"] = game.notes
        fields = list(GAME_FIELDS)
        assignments = ", ".join(f"{field} = ?" for field in fields)
        connection.execute(
            f"UPDATE games SET {assignments} WHERE id = ?",
            [updates[field] for field in fields] + [existing["id"]],
        )
        game.db_id = existing["id"]
        return game
    return insert_game(connection, game, commit=False)


def stats_payload(games):
    stats = StatisticsManager(games)
    return {
        "total": stats.total_games(),
        "completed": stats.completed_games_count(),
        "in_progress": stats.in_progress_games_count(),
        "wishlist": stats.wishlist_games_count(),
        "hours": round(stats.total_hours_played(), 1),
        "avg_rating": round(stats.average_rating(), 1),
        "avg_completion": round(stats.average_completion(), 1),
    }


def content_type_for(file_path):
    if file_path.suffix == ".css":
        return "text/css"
    if file_path.suffix == ".js":
        return "application/javascript"
    if file_path.suffix == ".png":
        return "image/png"
    if file_path.suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if file_path.suffix == ".webp":
        return "image/webp"
    if file_path.suffix == ".svg":
        return "image/svg+xml"
    if file_path.suffix == ".ico":
        return "image/x-icon"
    return "text/html"


class BacklogHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        parsed = urlparse(self.path)
        target = "index.html" if parsed.path in {"", "/"} else parsed.path.lstrip("/")
        file_path = (STATIC_DIR / target).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.exists():
            self.send_error(404)
            return
        content_type = content_type_for(file_path)
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(file_path.stat().st_size))
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/auth/steam":
            self.send_redirect(steam_auth_url(self.base_url()))
            return
        if parsed.path == "/auth/steam/callback":
            self.handle_steam_callback(parsed)
            return
        if parsed.path == "/api/session":
            session = self.current_session()
            self.send_json(
                {
                    "logged_in": bool(session),
                    "steam_id": session["steam_id"] if session else "",
                    "has_steam_key": bool(get_setting(STEAM_KEY_SETTING)),
                }
            )
            return
        if parsed.path == "/app.html" and not self.current_session():
            self.send_redirect("/login.html?next=/app.html")
            return
        if parsed.path.startswith("/api/") and not self.current_session():
            self.send_json({"error": "Steam sign-in is required."}, status=401)
            return
        if parsed.path == "/api/games":
            self.send_json({"games": [game_to_dict(game) for game in load_games()]})
            return
        if parsed.path == "/api/stats":
            self.send_json(stats_payload(load_games()))
            return
        if parsed.path == "/api/recommendations":
            self.send_json(self.recommendations())
            return
        if parsed.path == "/api/shuffle":
            self.send_json(self.shuffle(parse_qs(parsed.query)))
            return
        if parsed.path == "/api/steam/search":
            term = parse_qs(parsed.query).get("q", [""])[0]
            try:
                self.send_json({"results": steam_store_search(term)})
            except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
                self.send_json({"error": f"Steam search could not be reached: {error}"}, status=502)
            return
        if parsed.path == "/api/steam/owned-games":
            session = self.current_session()
            api_key = get_setting(STEAM_KEY_SETTING)
            if not api_key:
                self.send_json({"error": "Add a Steam Web API key before importing your owned games."}, status=400)
                return
            try:
                games = import_owned_steam_games(session["steam_id"], api_key)
            except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
                self.send_json({"error": f"Steam library import failed: {error}"}, status=502)
                return
            self.send_json({"imported": len(games), "games": [game_to_dict(game) for game in games]})
            return
        self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/logout":
            self.send_json({"ok": True}, cookies=[self.clear_session_cookie()])
            return
        if parsed.path.startswith("/api/") and not self.current_session():
            self.send_json({"error": "Steam sign-in is required."}, status=401)
            return
        if parsed.path == "/api/settings/steam-key":
            payload = self.read_payload()
            api_key = str(payload.get("api_key", "")).strip()
            if not api_key:
                self.send_json({"error": "Steam Web API key is required."}, status=400)
                return
            set_setting(STEAM_KEY_SETTING, api_key)
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/games":
            payload = self.read_payload()
            if not str(payload.get("title", "")).strip():
                self.send_json({"error": "Title is required."}, status=400)
                return
            game = game_from_payload(payload)
            with connect() as connection:
                if game.steam_appid:
                    game = upsert_steam_game(connection, game)
                    connection.commit()
                else:
                    insert_game(connection, game)
            self.send_json({"ok": True, "game": game_to_dict(game)}, status=201)
            return
        self.send_json({"error": "Not found."}, status=404)

    def do_PUT(self):
        if not self.current_session():
            self.send_json({"error": "Steam sign-in is required."}, status=401)
            return
        if self.path.startswith("/api/games/"):
            game_id = self.path_id()
            game = update_game(game_id, game_from_payload(self.read_payload())) if game_id else None
            if not game:
                self.send_json({"error": "Game not found."}, status=404)
                return
            self.send_json({"ok": True, "game": game_to_dict(game)})
            return
        self.send_json({"error": "Not found."}, status=404)

    def do_PATCH(self):
        if not self.current_session():
            self.send_json({"error": "Steam sign-in is required."}, status=401)
            return
        if self.path.startswith("/api/games/"):
            game_id = self.path_id()
            game = patch_game(game_id, self.read_payload()) if game_id else None
            if not game:
                self.send_json({"error": "Game not found."}, status=404)
                return
            self.send_json({"ok": True, "game": game_to_dict(game)})
            return
        self.send_json({"error": "Not found."}, status=404)

    def do_DELETE(self):
        if not self.current_session():
            self.send_json({"error": "Steam sign-in is required."}, status=401)
            return
        if self.path.startswith("/api/games/"):
            game_id = self.path_id()
            game = delete_game(game_id) if game_id else None
            if not game:
                self.send_json({"error": "Game not found."}, status=404)
                return
            self.send_json({"ok": True, "removed": game.title})
            return
        self.send_json({"error": "Not found."}, status=404)

    def recommendations(self):
        games = load_games()
        random_game = RandomBacklogRecommender().recommend(games)
        return {
            "backlog": [game_to_dict(game) for game in TopThreeBacklogRecommender().recommend(games)],
            "wishlist": [game_to_dict(game) for game in TopThreeWishlistRecommender().recommend(games)],
            "random": game_to_dict(random_game) if random_game else None,
        }

    def shuffle(self, query):
        mood = query.get("mood", ["Any vibe"])[0]
        time = query.get("time", ["Any time"])[0]
        candidates = [
            game for game in load_games()
            if game.ownership == "Owned" and game.status != "Completed"
        ]
        if mood != "Any vibe":
            keywords = {
                "Relaxed": ["cozy", "farming", "sim", "puzzle", "casual", "stardew", "sky"],
                "Action": ["action", "shooter", "fps", "rogue", "combat", "counter", "fear"],
                "Story": ["story", "rpg", "adventure", "narrative", "witcher", "detroit"],
                "Competitive": ["competitive", "multiplayer", "online", "counter-strike", "league"],
            }.get(mood, [])
            matched = [
                game for game in candidates
                if any(word in f"{game.title} {game.genre} {game.notes}".lower() for word in keywords)
            ]
            candidates = matched or candidates
        if not candidates:
            self.send_json({"game": None, "reason": "No unfinished owned games were found."})
            return
        game = random.choice(candidates)
        reason = f"{game.status} pick for {mood.lower()} / {time.lower()} with {game.hours_played:g}h logged."
        return {"game": game_to_dict(game), "reason": reason}

    def path_id(self):
        try:
            return int(urlparse(self.path).path.rstrip("/").split("/")[-1])
        except ValueError:
            return None

    def read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(body or "{}")

    def handle_steam_callback(self, parsed):
        try:
            query = parse_qs(parsed.query)
            if not verify_steam_openid(query):
                raise ValueError("Steam sign-in could not be verified.")
            steam_id = steam_id_from_openid(query)
            if not steam_id:
                raise ValueError("Steam sign-in did not include a SteamID64.")
            upsert_steam_user(steam_id)
            token = create_session(steam_id)
            self.send_redirect("/app.html", cookies=[self.session_cookie(token)])
        except Exception as error:
            self.send_html(
                f"""
                <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Steam sign-in failed</title>
                <link rel="stylesheet" href="/landing.css"></head><body><main class="page-main">
                <section class="content-panel"><h1>Steam sign-in failed</h1><p>{str(error)}</p>
                <p><a class="primary-action" href="/login.html">Try again</a></p></section></main></body></html>
                """,
                status=400,
            )

    def current_session(self):
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(SESSION_COOKIE)
        return find_session(morsel.value if morsel else "")

    def base_url(self):
        host = self.headers.get("Host") or f"{HOST}:{PORT}"
        return f"http://{host}"

    def session_cookie(self, token):
        return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 24 * 60 * 60}"

    def clear_session_cookie(self):
        return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def send_redirect(self, location, cookies=None):
        self.send_response(302)
        self.send_header("Location", location)
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def send_html(self, html, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload, status=200, cookies=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, path):
        target = "index.html" if path in {"", "/"} else path.lstrip("/")
        file_path = (STATIC_DIR / target).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.exists():
            self.send_error(404)
            return
        content_type = content_type_for(file_path)
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(file_path.stat().st_size))
        self.end_headers()
        self.wfile.write(file_path.read_bytes())

    def log_message(self, _format, *_args):
        return


def main():
    ensure_database()
    server = ThreadingHTTPServer((HOST, PORT), BacklogHandler)
    print(f"Steam Backlog Tracker web app running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
