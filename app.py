import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
import webview

from version import APP_NAME, APP_PUBLISHER, APP_VERSION, app_window_title
from anilist_client import AniListClient
from library_manager import LibraryManager
from stream_manager import StreamManager
from webhook_manager import WebhookManager

WINDOW_WIDTH = 1360
WINDOW_HEIGHT = 900
MIN_WIDTH = 960
MIN_HEIGHT = 640
API_BASE = "https://api.jikan.moe/v4"
# AniList is primary; Jikan kept as soft fallback when AniList fails.
CACHE_TTL = 1800
SEARCH_CACHE_TTL = 600
SCHEDULE_DELAY = 0.35
DISK_CACHE_TTL = 6 * 3600
STALE_DISK_TTL = 48 * 3600  # serve stale disk cache instantly while refreshing
YEARLY_CACHE_TTL = 86400
DAILY_CHECK_INTERVAL = 3600
SEASON_QUARTERS = ("winter", "spring", "summer", "fall")
MONTH_NAMES = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]
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


def _today_key():
    return datetime.now().strftime("%Y-%m-%d")


def _parse_aired_date(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _month_quarter(month):
    if month <= 3:
        return "winter"
    if month <= 6:
        return "spring"
    if month <= 9:
        return "summer"
    return "fall"


def start_server(directory, stream_manager):
    class QuietHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def log_message(self, _format, *_args):
            pass

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/stream":
                gate_hash = parse_qs(parsed.query).get("h", [""])[0].strip()
                if gate_hash:
                    self._proxy_stream(gate_hash)
                    return
            return SimpleHTTPRequestHandler.do_GET(self)

        def _proxy_stream(self, gate_hash):
            try:
                payload = stream_manager.get_stream_sources(gate_hash)
                if not payload.get("ok"):
                    self.send_error(404, payload.get("error", "Stream not found"))
                    return

                remote_url = payload.get("primary") or (payload.get("sources") or [None])[0]
                if not remote_url:
                    self.send_error(404, "No stream URL")
                    return

                # CDN often rejects non-browser UAs and missing Referer.
                headers = {
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/122.0.0.0 Safari/537.36"
                    ),
                    "Referer": "https://animeheaven.me/",
                    "Origin": "https://animeheaven.me",
                    "Accept": "*/*",
                }
                range_hdr = self.headers.get("Range")
                if range_hdr:
                    headers["Range"] = range_hdr

                with requests.get(
                    remote_url,
                    headers=headers,
                    stream=True,
                    timeout=60,
                ) as resp:
                    self.send_response(resp.status_code)
                    for key in (
                        "Content-Type",
                        "Content-Length",
                        "Content-Range",
                        "Accept-Ranges",
                    ):
                        if key in resp.headers:
                            self.send_header(key, resp.headers[key])
                    self.end_headers()
                    for chunk in resp.iter_content(chunk_size=1024 * 256):
                        if chunk:
                            self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                try:
                    self.send_error(500, "Stream proxy error")
                except Exception:
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
        "media": "anime",
    }


def slim_manga(item):
    images = item.get("images") or {}
    jpg = images.get("jpg") or {}
    published = item.get("published") or {}
    raw_type = (item.get("type") or "Manga").strip()
    type_lower = raw_type.lower().replace(" ", "").replace("-", "")
    # Normalize MAL media family for favorites / UI badges.
    if type_lower in ("manhwa",):
        media = "manhwa"
    elif type_lower in ("manhua",):
        media = "manhua"
    elif type_lower in ("lightnovel", "novel"):
        media = "novel"
    else:
        media = "manga"
    return {
        "mal_id": item.get("mal_id"),
        "url": item.get("url"),
        "title": item.get("title"),
        "title_english": item.get("title_english"),
        "title_japanese": item.get("title_japanese"),
        "title_synonyms": item.get("title_synonyms") or [],
        "image": jpg.get("large_image_url") or jpg.get("image_url"),
        "type": raw_type,
        "chapters": item.get("chapters"),
        "volumes": item.get("volumes"),
        "status": item.get("status"),
        "publishing": item.get("publishing"),
        "aired_from": published.get("from"),
        "aired_to": published.get("to"),
        "score": item.get("score"),
        "rank": item.get("rank"),
        "popularity": item.get("popularity"),
        "genres": [g.get("name") for g in item.get("genres") or []],
        "studios": [s.get("name") for s in item.get("authors") or []],
        "synopsis": (item.get("synopsis") or "")[:180],
        "media": media,
        "airing": bool(item.get("publishing")),
    }


class AnimeApi:
    def __init__(self):
        self._cache = {}
        self._cache_lock = threading.Lock()
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": f"{APP_NAME}/{APP_VERSION}"})
        self._anilist = AniListClient(
            self._session, user_agent=f"{APP_NAME}/{APP_VERSION}"
        )
        self._streams = StreamManager(self._session)
        self._webhooks = WebhookManager(self._session, self._request_with_retry)
        self._webhooks.set_anilist(self._anilist)
        self._library = LibraryManager()
        self._refresh_meta = self._load_refresh_meta()
        self._invalidate_if_new_day()
        self._load_disk_cache(allow_stale=True)
        threading.Thread(target=self._warm_cache, daemon=True).start()
        threading.Thread(target=self._daily_refresh_loop, daemon=True).start()
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

    def _refresh_meta_path(self):
        return cache_dir() / "refresh_meta.json"

    def _load_refresh_meta(self):
        path = self._refresh_meta_path()
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_refresh_meta(self):
        try:
            self._refresh_meta_path().write_text(
                json.dumps(self._refresh_meta, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _invalidate_if_new_day(self):
        today = _today_key()
        if self._refresh_meta.get("last_date") == today:
            return False

        with self._cache_lock:
            stale_prefixes = (
                "bootstrap",
                "weekly",
                "monthly",
                "yearly",
                "season:",
                "search:",
            )
            for key in list(self._cache):
                if key.startswith(stale_prefixes):
                    self._cache.pop(key, None)

        self._refresh_meta["last_date"] = today
        self._refresh_meta["last_time"] = datetime.now().isoformat()
        self._save_refresh_meta()
        return True

    def _load_disk_cache(self, allow_stale=False):
        path = self._disk_cache_path()
        if not path.exists():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            age = time.time() - payload.get("saved_at", 0)
            # Prefer fresh cache; still load stale so UI paints instantly.
            if age > STALE_DISK_TTL:
                return
            if not allow_stale and age > DISK_CACHE_TTL:
                return
            if not allow_stale and self._refresh_meta.get("last_date") != _today_key():
                return
            saved_at = payload.get("saved_at", time.time())
            for key, entry in payload.get("entries", {}).items():
                # Mark slightly stale so TTL still expires, but available for first paint.
                self._cache[key] = (entry, saved_at)
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

    def _cache_ttl_for(self, key):
        if key.startswith("yearly:"):
            return YEARLY_CACHE_TTL
        if key.startswith("search:"):
            return SEARCH_CACHE_TTL
        return CACHE_TTL

    def _get_cached(self, key, allow_stale=False):
        entry = self._cache.get(key)
        if not entry:
            return None
        data, ts = entry
        age = time.time() - ts
        ttl = self._cache_ttl_for(key)
        if age > ttl and not allow_stale:
            return None
        if age > STALE_DISK_TTL:
            return None
        if (
            not allow_stale
            and key.startswith(("bootstrap", "weekly", "monthly", "yearly", "season:"))
        ):
            if data.get("refresh_date") != _today_key():
                # Still return for first paint when explicitly allowed.
                return None
        return data

    def _get_cached_or_stale(self, key):
        return self._get_cached(key, allow_stale=False) or self._get_cached(
            key, allow_stale=True
        )

    def _set_cached(self, key, data):
        if isinstance(data, dict):
            data = {**data, "refresh_date": _today_key()}
        with self._cache_lock:
            self._cache[key] = (data, time.time())

    def _request(self, endpoint, params=None):
        params = dict(params or {})
        try:
            response = self._session.get(
                f"{API_BASE}{endpoint}",
                params=params,
                timeout=12,
            )
            if response.status_code == 429:
                return {"error": "rate_limited", "retry_after": 2, "data": []}
            if response.status_code >= 500:
                return {
                    "error": f"jikan_http_{response.status_code}",
                    "data": [],
                    "retry_after": 2,
                }
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
        self._invalidate_if_new_day()
        cached = self._get_cached("bootstrap")
        if cached:
            return cached

        # Instant paint from yesterday's cache while we refresh.
        stale = self._get_cached("bootstrap", allow_stale=True)

        try:
            result = self._anilist.bootstrap()
            if (result.get("now") or result.get("today") or result.get("upcoming")):
                self._set_cached("bootstrap", result)
                self._save_disk_cache()
                return result
        except Exception as exc:
            result = {"error": str(exc), "now": [], "upcoming": [], "today": []}

        # Soft fallback to Jikan (often rate-limited / 504).
        try:
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
            fallback = {
                "now": now.get("data", []),
                "upcoming": upcoming.get("data", []),
                "today": today.get("data", []),
                "today_name": today_name,
                "error": now.get("error") or upcoming.get("error") or today.get("error"),
                "source": "jikan",
            }
            if fallback["now"] or fallback["today"] or fallback["upcoming"]:
                self._set_cached("bootstrap", fallback)
                self._save_disk_cache()
                return fallback
        except Exception:
            pass

        if stale:
            return {**stale, "stale": True, "error": result.get("error") or stale.get("error")}
        return {
            "now": [],
            "upcoming": [],
            "today": [],
            "today_name": DAYS[datetime.now().weekday()],
            "error": result.get("error") or "Could not load schedule data",
            "source": "none",
        }

    def get_weekly(self):
        self._invalidate_if_new_day()
        cached = self._get_cached("weekly")
        if cached:
            return cached
        stale = self._get_cached("weekly", allow_stale=True)

        try:
            result = self._anilist.weekly()
            if any(result.get("schedule", {}).get(d) for d in DAYS):
                self._set_cached("weekly", result)
                self._save_disk_cache()
                return result
        except Exception as exc:
            result = {"schedule": {d: [] for d in DAYS}, "error": str(exc)}

        # Jikan fallback (slow — sequential day requests)
        schedule = {}
        error = result.get("error") if isinstance(result, dict) else None
        for day in DAYS:
            payload = self._fetch_page("/schedules", {"filter": day})
            schedule[day] = payload.get("data", [])
            if payload.get("error"):
                error = payload.get("error")
            time.sleep(SCHEDULE_DELAY)
        if any(schedule.values()):
            out = {"schedule": schedule, "error": error, "source": "jikan"}
            self._set_cached("weekly", out)
            self._save_disk_cache()
            return out
        if stale:
            return {**stale, "stale": True}
        return {"schedule": schedule, "error": error or "Could not load weekly schedule"}

    def get_monthly(self, year=None, month=None):
        self._invalidate_if_new_day()
        now = datetime.now()
        year = int(year or now.year)
        month = int(month or now.month)
        key = f"monthly:{year}-{month:02d}"
        cached = self._get_cached(key)
        if cached:
            return cached
        stale = self._get_cached(key, allow_stale=True)

        try:
            result = self._anilist.monthly(year, month)
            if result.get("premieres") is not None:
                self._set_cached(key, result)
                self._save_disk_cache()
                return result
        except Exception as exc:
            if stale:
                return {**stale, "stale": True, "error": str(exc)}
            return {
                "year": year,
                "month": month,
                "month_name": MONTH_NAMES[month],
                "days_in_month": 30,
                "premieres": [],
                "ongoing": [],
                "starting_soon": [],
                "premiere_by_day": {},
                "broadcast_map": {},
                "error": str(exc),
            }
        if stale:
            return {**stale, "stale": True}
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

    def _fetch_calendar_season(self, year, quarter):
        results = []
        error = None
        page = 1
        while page <= 6:
            payload = self._request_with_retry(
                f"/seasons/{year}/{quarter}",
                {"page": page},
            )
            if payload.get("error") and not payload.get("data"):
                error = payload.get("error")
                break
            batch = [slim_anime(item) for item in payload.get("data") or []]
            if not batch:
                break
            results.extend(batch)
            if not payload.get("pagination", {}).get("has_next_page"):
                break
            page += 1
            time.sleep(0.35)
        return results, error

    def get_yearly(self, year=None):
        self._invalidate_if_new_day()
        now = datetime.now()
        year = int(year or now.year)
        key = f"yearly:{year}"
        cached = self._get_cached(key)
        if cached:
            return cached
        stale = self._get_cached(key, allow_stale=True)

        try:
            result = self._anilist.yearly(year)
            if result.get("total") or result.get("premieres") is not None:
                self._set_cached(key, result)
                self._save_disk_cache()
                return result
        except Exception as exc:
            if stale:
                return {**stale, "stale": True, "error": str(exc)}
            return {
                "year": year,
                "total": 0,
                "premieres": [],
                "announced_tba": [],
                "airing": [],
                "finished": [],
                "by_month": {},
                "by_quarter": {q: [] for q in SEASON_QUARTERS},
                "month_names": MONTH_NAMES,
                "last_refreshed": datetime.now().isoformat(),
                "error": str(exc),
            }
        if stale:
            return {**stale, "stale": True}
        return result

    def get_refresh_status(self):
        self._invalidate_if_new_day()
        return {
            "today": _today_key(),
            "last_refresh_date": self._refresh_meta.get("last_date"),
            "last_refresh_time": self._refresh_meta.get("last_time"),
        }

    def refresh_all_data(self, hard=True):
        """Force-refresh schedule data. hard=True also wipes disk cache."""
        with self._cache_lock:
            for key in list(self._cache):
                if key.startswith(
                    (
                        "bootstrap",
                        "weekly",
                        "monthly",
                        "yearly",
                        "season:",
                        "search:",
                    )
                ):
                    self._cache.pop(key, None)

        if hard:
            try:
                path = self._disk_cache_path()
                if path.exists():
                    path.unlink()
            except Exception:
                pass

        self._refresh_meta["last_date"] = _today_key()
        self._refresh_meta["last_time"] = datetime.now().isoformat()
        self._save_refresh_meta()

        # Reload the tabs users care about most (today / week / month).
        bootstrap = self.get_bootstrap()
        weekly = self.get_weekly()
        now = datetime.now()
        monthly = self.get_monthly(now.year, now.month)
        self._save_disk_cache()
        return {
            "ok": True,
            "today": _today_key(),
            "last_refresh_time": self._refresh_meta.get("last_time"),
            "bootstrap": bootstrap,
            "weekly": weekly,
            "monthly": monthly,
            "source": bootstrap.get("source")
            or weekly.get("source")
            or monthly.get("source"),
        }

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

    def search_anime(
        self,
        query,
        limit=24,
        type=None,
        status=None,
        order_by="popularity",
        sort="desc",
        min_score=None,
    ):
        return self.search_media(
            query,
            media="anime",
            limit=limit,
            type=type,
            status=status,
            order_by=order_by,
            sort=sort,
            min_score=min_score,
        )

    def search_manga(
        self,
        query,
        limit=24,
        type=None,
        status=None,
        order_by="popularity",
        sort="desc",
        min_score=None,
    ):
        return self.search_media(
            query,
            media=type if type in ("manhwa", "manhua", "webtoon", "novel") else "manga",
            limit=limit,
            type=type,
            status=status,
            order_by=order_by,
            sort=sort,
            min_score=min_score,
        )

    def search_media(
        self,
        query,
        media="anime",
        limit=24,
        type=None,
        status=None,
        order_by="popularity",
        sort="desc",
        min_score=None,
    ):
        """Primary search via AniList (fast). Falls back to Jikan if needed.

        media: anime | manga | manhwa | webtoon | manhua | novel | all
        """
        query = (query or "").strip()
        media = (media or "anime").strip().lower()
        if media in ("all", "any", "everything", "*"):
            media = "all"
        if len(query) < 2:
            return {"data": [], "query": query, "media": media, "source": "none"}

        type_key = (type or "").strip().lower() if type else "any"
        status_key = (status or "").strip().lower() if status else "any"
        order_key = (order_by or "popularity").strip().lower()
        sort_key = (sort or "desc").strip().lower()
        try:
            score_key = float(min_score) if min_score not in (None, "", 0, "0") else 0
        except (TypeError, ValueError):
            score_key = 0

        # "All" = anime + manga (manhwa/manhua included under manga type on AniList)
        if media == "all":
            half = max(8, min(24, int(limit or 24) // 2 + 2))
            anime = self.search_media(
                query, "anime", half, type_key if type_key in ("tv", "movie", "ova", "ona", "special", "any", "") else "any",
                status_key, order_key, sort_key, score_key,
            )
            manga = self.search_media(
                query, "manga", half, type_key if type_key not in ("tv", "movie", "ova", "ona", "special") else "any",
                status_key, order_key, sort_key, score_key,
            )
            merged = []
            seen = set()
            for item in (anime.get("data") or []) + (manga.get("data") or []):
                key = item.get("anilist_id") or item.get("mal_id") or item.get("title")
                if key in seen:
                    continue
                seen.add(key)
                merged.append(item)
            # Prefer SEARCH_MATCH order: keep anime list then manga list interleaved by score
            merged.sort(key=lambda d: (-(d.get("score") or 0), -(d.get("popularity") or 0)))
            result = {
                "data": merged[: max(1, min(50, int(limit or 24)))],
                "query": query,
                "media": "all",
                "source": "anilist",
                "error": anime.get("error") if not anime.get("data") else manga.get("error"),
            }
            return result

        cache_key = (
            f"search:{media}:{query.lower()}:{type_key}:{status_key}:"
            f"{order_key}:{sort_key}:{score_key}:{limit}"
        )
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        # --- AniList (primary) ---
        try:
            result = self._anilist.search(
                query,
                media=media,
                limit=limit,
                type=None if type_key in ("", "any", None) else type_key,
                status=None if status_key in ("", "any", None) else status_key,
                order_by=order_key,
                sort=sort_key,
                min_score=score_key or None,
            )
            if result.get("data") or not result.get("error"):
                # Cache hits and clean empty results (typos) briefly.
                self._set_cached(cache_key, result)
                return result
            al_error = result.get("error")
        except Exception as exc:
            al_error = str(exc)
            result = {"data": [], "error": al_error, "query": query, "media": media}

        # --- Jikan fallback ---
        try:
            if media in ("manga", "manhwa", "manhua", "webtoon", "novel"):
                jikan = self._search_jikan_manga(
                    query, limit, type_key, status_key, order_key, sort_key, score_key
                )
            else:
                jikan = self._search_jikan_anime(
                    query, limit, type_key, status_key, order_key, sort_key, score_key
                )
            if jikan.get("data"):
                jikan["source"] = "jikan"
                self._set_cached(cache_key, jikan)
                return jikan
            if jikan.get("error"):
                result["error"] = f"{al_error}; jikan: {jikan.get('error')}"
        except Exception as exc:
            result["error"] = f"{al_error}; jikan: {exc}"

        self._set_cached(cache_key, result)
        return result

    def _search_jikan_anime(
        self, query, limit, type_key, status_key, order_key, sort_key, score_key
    ):
        params = {
            "q": query,
            "limit": max(1, min(25, int(limit or 24))),
            "sfw": "true",
            "order_by": order_key
            if order_key
            in (
                "mal_id",
                "title",
                "start_date",
                "end_date",
                "episodes",
                "score",
                "scored_by",
                "rank",
                "popularity",
                "members",
                "favorites",
            )
            else "popularity",
            "sort": "desc" if sort_key == "desc" else "asc",
        }
        if type_key not in ("any", "", None):
            params["type"] = type_key
        if status_key not in ("any", "", None):
            params["status"] = status_key
        if score_key > 0:
            params["min_score"] = score_key
        payload = self._request_with_retry("/anime", params)
        data = [slim_anime(item) for item in payload.get("data") or []]
        return {"data": data, "error": payload.get("error"), "query": query, "media": "anime"}

    def _search_jikan_manga(
        self, query, limit, type_key, status_key, order_key, sort_key, score_key
    ):
        type_map = {
            "manga": "manga",
            "manhwa": "manhwa",
            "manhua": "manhua",
            "webtoon": "manhwa",
            "novel": "novel",
            "lightnovel": "lightnovel",
            "one_shot": "one_shot",
            "doujinshi": "doujinshi",
        }
        status_map = {
            "airing": "publishing",
            "publishing": "publishing",
            "complete": "complete",
            "finished": "complete",
            "upcoming": "upcoming",
        }
        params = {
            "q": query,
            "limit": max(1, min(25, int(limit or 24))),
            "sfw": "true",
            "order_by": "popularity",
            "sort": "asc",
        }
        jikan_type = type_map.get(type_key)
        if jikan_type:
            params["type"] = jikan_type
        jikan_status = status_map.get(status_key)
        if jikan_status:
            params["status"] = jikan_status
        if score_key > 0:
            params["min_score"] = score_key
        payload = self._request_with_retry("/manga", params)
        data = [slim_manga(item) for item in payload.get("data") or []]
        return {
            "data": data,
            "error": payload.get("error"),
            "query": query,
            "media": type_key if type_key not in ("any", "", None) else "manga",
        }

    def search(self, query, media="anime", limit=24):
        """Simple search alias used by older UI bindings."""
        return self.search_media(query, media=media, limit=limit)

    # --- Library: favorites / history / resume ---

    def get_favorites(self):
        return self._library.get_favorites()

    def add_favorite(self, item):
        return self._library.add_favorite(item)

    def remove_favorite(self, mal_id):
        return self._library.remove_favorite(mal_id)

    def toggle_favorite(self, item):
        return self._library.toggle_favorite(item)

    def get_history(self):
        return self._library.get_history()

    def mark_completed(self, item, note=None):
        return self._library.mark_completed(item, note=note)

    def remove_from_history(self, mal_id):
        return self._library.remove_from_history(mal_id)

    def get_watch_progress(self, mal_id=None, episode=None):
        return self._library.get_progress(mal_id, episode)

    def get_last_watch_progress(self, mal_id):
        """Most recently updated resume point for a show (episode + seconds)."""
        return self._library.get_last_progress(mal_id)

    def save_watch_progress(self, mal_id, episode, seconds, duration=None, title=None):
        return self._library.save_progress(
            mal_id, episode, seconds, duration=duration, title=title
        )

    def clear_watch_progress(self, mal_id=None, episode=None):
        return self._library.clear_progress(mal_id, episode)

    def get_library_summary(self):
        return self._library.get_library_summary()

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
            result = self._streams.get_stream_sources(gate_hash)
            if result.get("ok"):
                result["playback_url"] = f"/stream?h={gate_hash}"
            return result
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _warm_cache(self):
        try:
            # Priority: paint Today ASAP, then week. Year can wait.
            self.get_bootstrap()
            self._save_disk_cache()
            self.get_weekly()
            self._save_disk_cache()
        except Exception:
            pass

    def _daily_refresh_loop(self):
        while True:
            time.sleep(DAILY_CHECK_INTERVAL)
            try:
                if self._invalidate_if_new_day():
                    self.get_bootstrap()
                    self.get_weekly()
                    self._save_disk_cache()
            except Exception:
                pass


def main():
    directory = app_dir()
    api = AnimeApi()
    server, url = start_server(directory, api._streams)

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