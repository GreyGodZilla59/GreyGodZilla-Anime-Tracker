import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import requests
import webview

from version import APP_NAME, APP_PUBLISHER, APP_VERSION, app_window_title
from stream_manager import StreamManager
from webhook_manager import WebhookManager

WINDOW_WIDTH = 1360
WINDOW_HEIGHT = 900
MIN_WIDTH = 960
MIN_HEIGHT = 640
API_BASE = "https://api.jikan.moe/v4"
CACHE_TTL = 900
SCHEDULE_DELAY = 0.55
DISK_CACHE_TTL = 1800
DAYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]


def app_dir():
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def cache_dir():
    base = Path(os.environ.get("APPDATA") or Path.home())
    root = base / "GreyGodZilla" / "AnimeTracker"
    root.mkdir(parents=True, exist_ok=True)
    return root


def start_server(directory):
    class QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def log_message(self, _format, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), QuietHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{port}"


def slim_anime(item):
    broadcast = item.get("broadcast") or {}
    aired = item.get("aired") or {}
    images = item.get("images") or {}
    jpg = images.get("jpg") or {}

    return {
        "mal_id": item.get("mal_id"),
        "url": item.get("url"),
        "title": item.get("title"),
        "title_english": item.get("title_english"),
        "title_japanese": item.get("title_japanese"),
        "title_synonyms": item.get("title_synonyms") or [],
        "image": jpg.get("large_image_url") or jpg.get("image_url"),
        "type": item.get("type"),
        "episodes": item.get("episodes"),
        "status": item.get("status"),
        "airing": item.get("airing"),
        "aired_from": aired.get("from"),
        "aired_to": aired.get("to"),
        "broadcast_day": broadcast.get("day"),
        "broadcast_time": broadcast.get("time"),
        "score": item.get("score"),
        "rank": item.get("rank"),
        "popularity": item.get("popularity"),
        "genres": [g.get("name") for g in item.get("genres") or []],
        "studios": [s.get("name") for s in item.get("studios") or []],
        "synopsis": (item.get("synopsis") or "")[:180],
    }


class AnimeApi:
    def __init__(self):
        self._cache = {}
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": f"{APP_NAME}/{APP_VERSION}"})
        self._streams = StreamManager(self._session)
        self._webhooks = WebhookManager(self._session, self._request_with_retry)
        self._load_disk_cache()
        threading.Thread(target=self._warm_cache, daemon=True).start()
        self._webhooks.start()

    def get_app_info(self):
        return {
            "name": APP_NAME,
            "version": APP_VERSION,
            "publisher": APP_PUBLISHER,
            "title": app_window_title(),
        }

    def _disk_cache_path(self):
        return cache_dir() / "cache.json"

    def _load_disk_cache(self):
        path = self._disk_cache_path()
        if not path.exists():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if time.time() - payload.get("saved_at", 0) > DISK_CACHE_TTL:
                return
            for key, entry in payload.get("entries", {}).items():
                self._cache[key] = (entry, payload["saved_at"])
        except Exception:
            pass

    def _save_disk_cache(self):
        try:
            payload = {
                "saved_at": time.time(),
                "entries": {key: data for key, (data, _) in self._cache.items()},
            }
            self._disk_cache_path().write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _get_cached(self, key):
        entry = self._cache.get(key)
        if not entry:
            return None
        data, ts = entry
        if time.time() - ts > CACHE_TTL:
            return None
        return data

    def _set_cached(self, key, data):
        self._cache[key] = (data, time.time())

    def _request(self, endpoint, params=None):
        params = dict(params or {})
        try:
            response = self._session.get(
                f"{API_BASE}{endpoint}",
                params=params,
                timeout=15,
            )
            if response.status_code == 429:
                return {"error": "rate_limited", "retry_after": 2, "data": []}
            response.raise_for_status()
            return response.json()
        except Exception as exc:
            return {"error": str(exc), "data": []}

    def _request_with_retry(self, endpoint, params=None, retries=3):
        params = dict(params or {})
        payload = {"error": "unknown", "data": []}
        for attempt in range(retries):
            payload = self._request(endpoint, params)
            if payload.get("error") == "rate_limited":
                time.sleep(payload.get("retry_after", 2) + attempt)
                continue
            if payload.get("error") and not payload.get("data"):
                if attempt < retries - 1:
                    time.sleep(1.0 * (attempt + 1))
                    continue
            return payload
        return payload

    def _fetch_page(self, endpoint, params=None):
        payload = self._request_with_retry(endpoint, params)
        data = [slim_anime(item) for item in payload.get("data") or []]
        return {"data": data, "error": payload.get("error")}

    def _fetch_season_pages(self, season, pages=1):
        cache_key = f"season:{season}:{pages}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        results = []
        error = None
        for page in range(1, pages + 1):
            payload = self._request_with_retry(f"/seasons/{season}", {"page": page})
            if payload.get("error") and not payload.get("data"):
                error = payload.get("error")
                break
            results.extend(slim_anime(item) for item in payload.get("data") or [])
            if not payload.get("pagination", {}).get("has_next_page"):
                break
            if page < pages:
                time.sleep(0.35)

        result = {"data": results, "error": error}
        if results:
            self._set_cached(cache_key, result)
            self._set_cached(f"season:{season}", result)
        return result

    def get_bootstrap(self):
        cached = self._get_cached("bootstrap")
        if cached:
            return cached

        today_name = DAYS[datetime.now().weekday()]

        with ThreadPoolExecutor(max_workers=3) as pool:
            now_future = pool.submit(self._fetch_season_pages, "now", 1)
            upcoming_future = pool.submit(self._fetch_season_pages, "upcoming", 1)
            today_future = pool.submit(
                self._fetch_page, "/schedules", {"filter": today_name}
            )
            now = now_future.result()
            upcoming = upcoming_future.result()
            today = today_future.result()

        result = {
            "now": now.get("data", []),
            "upcoming": upcoming.get("data", []),
            "today": today.get("data", []),
            "today_name": today_name,
            "error": now.get("error") or upcoming.get("error") or today.get("error"),
        }
        self._set_cached("bootstrap", result)
        self._save_disk_cache()
        return result

    def get_weekly(self):
        cached = self._get_cached("weekly")
        if cached:
            return cached

        schedule = {}
        error = None
        for day in DAYS:
            payload = self._fetch_page("/schedules", {"filter": day})
            schedule[day] = payload.get("data", [])
            if payload.get("error"):
                error = payload.get("error")
            time.sleep(SCHEDULE_DELAY)

        result = {"schedule": schedule, "error": error}
        self._set_cached("weekly", result)
        self._save_disk_cache()
        return result

    def get_monthly(self, year=None, month=None):
        now = datetime.now()
        year = int(year or now.year)
        month = int(month or now.month)
        key = f"monthly:{year}-{month:02d}"
        cached = self._get_cached(key)
        if cached:
            return cached

        now_data = self._season_data("now", 2)
        upcoming_data = self._season_data("upcoming", 2)
        combined = {item["mal_id"]: item for item in now_data + upcoming_data}.values()

        premieres = []
        ongoing = []
        for item in combined:
            aired_from = item.get("aired_from")
            if not aired_from:
                continue
            try:
                dt = datetime.fromisoformat(aired_from.replace("Z", "+00:00"))
            except ValueError:
                continue

            if dt.year == year and dt.month == month:
                premieres.append({**item, "premiere_day": dt.day})
            elif item.get("airing"):
                ongoing.append(item)

        starting_soon = []
        today = now.date()
        for item in combined:
            aired_from = item.get("aired_from")
            if not aired_from or item.get("airing"):
                continue
            try:
                dt = datetime.fromisoformat(aired_from.replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.year == year and dt.month == month:
                continue
            dt_date = dt.date()
            if dt_date > today and (dt_date - today).days <= 45:
                starting_soon.append({**item, "premiere_day": dt.day, "premiere_month": dt.month})

        premieres.sort(key=lambda x: (x.get("premiere_day", 99), x.get("title") or ""))
        ongoing.sort(key=lambda x: x.get("score") or 0, reverse=True)
        starting_soon.sort(key=lambda x: x.get("aired_from") or "")

        import calendar

        broadcast_map = {}
        for item in ongoing:
            day = (item.get("broadcast_day") or "").lower()
            if day in DAYS:
                broadcast_map.setdefault(day, []).append(item)

        result = {
            "year": year,
            "month": month,
            "month_name": calendar.month_name[month],
            "days_in_month": calendar.monthrange(year, month)[1],
            "premieres": premieres,
            "ongoing": ongoing[:40],
            "starting_soon": starting_soon[:20],
            "premiere_by_day": self._group_by_day(premieres),
            "broadcast_map": broadcast_map,
        }
        self._set_cached(key, result)
        self._save_disk_cache()
        return result

    def _season_data(self, season, pages=1):
        cached = self._get_cached(f"season:{season}")
        if cached:
            return cached.get("data", [])
        return self._fetch_season_pages(season, pages).get("data", [])

    def _group_by_day(self, items):
        grouped = {}
        for item in items:
            day = item.get("premiere_day")
            if day is None:
                continue
            grouped.setdefault(str(day), []).append(item)
        return grouped

    def get_full_season(self, season):
        return self._fetch_season_pages(season, 2)

    def get_webhook_config(self):
        return self._webhooks.get_config()

    def save_webhook_config(self, config):
        return self._webhooks.save_config(config)

    def get_webhook_status(self):
        return self._webhooks.get_status()

    def get_watchlist(self):
        return self._webhooks.get_watchlist()

    def add_to_watchlist(self, anime):
        return self._webhooks.add_to_watchlist(anime)

    def add_to_watchlist_by_id(self, mal_id):
        return self._webhooks.add_to_watchlist_by_id(mal_id)

    def search_anime(self, query, limit=20):
        query = (query or "").strip()
        if len(query) < 2:
            return {"data": []}
        cached = self._get_cached(f"search:{query.lower()}")
        if cached:
            return cached
        payload = self._request_with_retry(
            "/anime",
            {"q": query, "limit": limit, "sfw": "true", "order_by": "popularity"},
        )
        data = [slim_anime(item) for item in payload.get("data") or []]
        result = {"data": data, "error": payload.get("error")}
        if data:
            self._set_cached(f"search:{query.lower()}", result)
        return result

    def get_picker_anime(self):
        cached = self._get_cached("bootstrap")
        if cached:
            combined = {}
            for item in (cached.get("now") or []) + (cached.get("upcoming") or []):
                combined[item["mal_id"]] = item
            return {"data": list(combined.values())}
        result = self.get_bootstrap()
        combined = {}
        for item in (result.get("now") or []) + (result.get("upcoming") or []):
            combined[item["mal_id"]] = item
        return {"data": list(combined.values())}

    def remove_from_watchlist(self, mal_id):
        return self._webhooks.remove_from_watchlist(mal_id)

    def test_webhook(self, url=None):
        return self._webhooks.test_webhook(url_override=url)

    def check_webhook_now(self):
        return self._webhooks.check_now()

    def search_stream(self, query, limit=12):
        try:
            return self._streams.search(query, limit=limit)
        except Exception as exc:
            return {"data": [], "error": str(exc)}

    def resolve_stream(self, mal_id=None, titles=None):
        title_list = list(titles or [])
        mal_id = int(mal_id or 0)
        if mal_id and not title_list:
            payload = self._request_with_retry(f"/anime/{mal_id}")
            item = payload.get("data") or {}
            title_list = [
                item.get("title_english"),
                item.get("title"),
                item.get("title_japanese"),
                *(item.get("title_synonyms") or []),
            ]
        title_list = [t for t in title_list if t]
        if not title_list:
            return {"ok": False, "error": "No title to search AnimeHeaven"}
        try:
            return self._streams.resolve_for_titles(title_list)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def get_stream_anime(self, ah_id):
        try:
            return self._streams.get_anime(ah_id)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def get_stream_sources(self, gate_hash):
        try:
            return self._streams.get_stream_sources(gate_hash)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _warm_cache(self):
        try:
            self.get_bootstrap()
            self._save_disk_cache()
        except Exception:
            pass


def main():
    directory = app_dir()
    server, url = start_server(directory)
    api = AnimeApi()

    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

    icon_path = os.path.join(directory, "assets", "greygodzilla_icon.ico")

    window = webview.create_window(
        app_window_title(),
        url,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        js_api=api,
    )

    try:
        webview.start()
    finally:
        api._webhooks.stop()
        server.shutdown()


if __name__ == "__main__":
    main()