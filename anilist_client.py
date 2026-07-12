"""AniList GraphQL client — primary metadata source (fast, no API key)."""

from __future__ import annotations

import calendar
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import requests

ANILIST_URL = "https://graphql.anilist.co"
DAYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]
SEASON_BY_MONTH = {
    1: "WINTER",
    2: "WINTER",
    3: "WINTER",
    4: "SPRING",
    5: "SPRING",
    6: "SPRING",
    7: "SUMMER",
    8: "SUMMER",
    9: "SUMMER",
    10: "FALL",
    11: "FALL",
    12: "FALL",
}
NEXT_SEASON = {
    "WINTER": "SPRING",
    "SPRING": "SUMMER",
    "SUMMER": "FALL",
    "FALL": "WINTER",
}
FORMAT_ANIME = {
    "tv": "TV",
    "movie": "MOVIE",
    "ova": "OVA",
    "ona": "ONA",
    "special": "SPECIAL",
    "tv_short": "TV_SHORT",
    "music": "MUSIC",
}
FORMAT_MANGA = {
    "manga": "MANGA",
    "novel": "NOVEL",
    "lightnovel": "NOVEL",
    "one_shot": "ONE_SHOT",
    "oneshot": "ONE_SHOT",
    # Manhwa/manhua/webtoon are country-based on AniList, not format.
}
STATUS_ANIME = {
    "airing": "RELEASING",
    "releasing": "RELEASING",
    "complete": "FINISHED",
    "finished": "FINISHED",
    "upcoming": "NOT_YET_RELEASED",
    "not_yet_released": "NOT_YET_RELEASED",
    "hiatus": "HIATUS",
    "cancelled": "CANCELLED",
}
STATUS_MANGA = {
    "airing": "RELEASING",
    "publishing": "RELEASING",
    "releasing": "RELEASING",
    "complete": "FINISHED",
    "finished": "FINISHED",
    "upcoming": "NOT_YET_RELEASED",
    "hiatus": "HIATUS",
    "discontinued": "CANCELLED",
    "cancelled": "CANCELLED",
}

MEDIA_FRAGMENT = """
fragment MediaFields on Media {
  id
  idMal
  type
  format
  status
  episodes
  chapters
  volumes
  averageScore
  popularity
  favourites
  genres
  description(asHtml: false)
  siteUrl
  isAdult
  countryOfOrigin
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  title { romaji english native }
  synonyms
  coverImage { large extraLarge medium }
  studios(isMain: true) { nodes { name } }
  staff(sort: RELEVANCE, perPage: 4) {
    edges { role node { name { full } } }
  }
  nextAiringEpisode { episode airingAt }
}
"""


def _strip_html(text: Optional[str]) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]+>", " ", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:180]


def _iso_from_fuzzy(date_obj: Optional[dict]) -> Optional[str]:
    if not date_obj or not date_obj.get("year"):
        return None
    y = int(date_obj["year"])
    m = int(date_obj.get("month") or 1)
    d = int(date_obj.get("day") or 1)
    try:
        return datetime(y, m, d, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def _status_label(status: Optional[str], media_type: str) -> str:
    status = (status or "").upper()
    if status == "RELEASING":
        return "Currently Airing" if media_type == "ANIME" else "Publishing"
    if status == "FINISHED":
        return "Finished"
    if status == "NOT_YET_RELEASED":
        return "Not yet aired" if media_type == "ANIME" else "Not yet published"
    if status == "HIATUS":
        return "Hiatus"
    if status == "CANCELLED":
        return "Cancelled"
    return status.title() if status else ""


def _format_label(fmt: Optional[str]) -> str:
    if not fmt:
        return ""
    return fmt.replace("_", " ").title()


def _media_family(item: dict, media_type: str) -> str:
    if media_type == "ANIME":
        return "anime"
    country = (item.get("countryOfOrigin") or "").upper()
    fmt = (item.get("format") or "").upper()
    if country == "KR" or fmt == "MANHWA":
        return "manhwa"
    if country == "CN" or fmt == "MANHUA":
        return "manhua"
    if fmt == "NOVEL":
        return "novel"
    return "manga"


def slim_media(item: dict) -> dict:
    """Normalize AniList Media into the app's shared card shape."""
    if not item:
        return {}
    media_type = (item.get("type") or "ANIME").upper()
    title = item.get("title") or {}
    cover = item.get("coverImage") or {}
    start = item.get("startDate") or {}
    end = item.get("endDate") or {}
    studios = []
    for node in ((item.get("studios") or {}).get("nodes") or []):
        if node and node.get("name"):
            studios.append(node["name"])
    if media_type != "ANIME" and not studios:
        for edge in ((item.get("staff") or {}).get("edges") or []):
            role = (edge.get("role") or "").lower()
            name = ((edge.get("node") or {}).get("name") or {}).get("full")
            if name and ("story" in role or "art" in role or "original" in role):
                studios.append(name)
        studios = studios[:2]

    anilist_id = item.get("id")
    mal_id = item.get("idMal") or anilist_id
    next_ep = item.get("nextAiringEpisode") or {}
    airing_at = next_ep.get("airingAt")
    broadcast_day = None
    broadcast_time = None
    if airing_at:
        dt = datetime.fromtimestamp(int(airing_at), tz=timezone.utc)
        # Show local JST-ish schedule string (AniList airing is unix UTC).
        jst = dt + timedelta(hours=9)
        broadcast_day = jst.strftime("%A")
        broadcast_time = jst.strftime("%H:%M")

    family = _media_family(item, media_type)
    status = item.get("status")
    score = item.get("averageScore")
    return {
        "mal_id": mal_id,
        "anilist_id": anilist_id,
        "url": item.get("siteUrl") or f"https://anilist.co/{'anime' if media_type == 'ANIME' else 'manga'}/{anilist_id}",
        "title": title.get("romaji") or title.get("english") or title.get("native") or "Unknown",
        "title_english": title.get("english"),
        "title_japanese": title.get("native"),
        "title_synonyms": item.get("synonyms") or [],
        "image": cover.get("extraLarge") or cover.get("large") or cover.get("medium"),
        "type": _format_label(item.get("format")) or ("Manga" if media_type != "ANIME" else "TV"),
        "episodes": item.get("episodes"),
        "chapters": item.get("chapters"),
        "volumes": item.get("volumes"),
        "status": _status_label(status, media_type),
        "airing": status == "RELEASING" and media_type == "ANIME",
        "publishing": status == "RELEASING" and media_type != "ANIME",
        "aired_from": _iso_from_fuzzy(start),
        "aired_to": _iso_from_fuzzy(end),
        "broadcast_day": broadcast_day,
        "broadcast_time": broadcast_time,
        "next_episode": next_ep.get("episode"),
        "score": round(score / 10, 2) if score else None,
        "rank": None,
        "popularity": item.get("popularity"),
        "genres": item.get("genres") or [],
        "studios": studios,
        "synopsis": _strip_html(item.get("description")),
        "media": family,
        "season": (item.get("season") or "").title() or None,
        "season_year": item.get("seasonYear"),
        "source": "anilist",
    }


class AniListClient:
    def __init__(self, session: Optional[requests.Session] = None, user_agent: str = "GreyGodZillaAnimeTracker"):
        self._session = session or requests.Session()
        self._session.headers.update(
            {
                "User-Agent": user_agent,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
        )
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._min_interval = 0.12  # stay polite; AniList allows ~90 req/min

    def _throttle(self):
        with self._lock:
            now = time.time()
            wait = self._min_interval - (now - self._last_request)
            if wait > 0:
                time.sleep(wait)
            self._last_request = time.time()

    def gql(self, query: str, variables: Optional[dict] = None, retries: int = 3) -> dict:
        payload = {"query": query, "variables": variables or {}}
        last_error = None
        for attempt in range(retries):
            self._throttle()
            try:
                resp = self._session.post(ANILIST_URL, json=payload, timeout=18)
                if resp.status_code == 429:
                    time.sleep(1.2 + attempt)
                    last_error = "rate_limited"
                    continue
                if resp.status_code >= 500:
                    time.sleep(0.4 * (attempt + 1))
                    last_error = f"http_{resp.status_code}"
                    continue
                data = resp.json()
                if data.get("errors"):
                    # GraphQL soft errors — return empty with message
                    msg = data["errors"][0].get("message") if data["errors"] else "GraphQL error"
                    last_error = msg
                    if attempt < retries - 1:
                        time.sleep(0.35 * (attempt + 1))
                        continue
                    return {"data": None, "error": msg}
                return {"data": data.get("data"), "error": None}
            except Exception as exc:
                last_error = str(exc)
                time.sleep(0.4 * (attempt + 1))
        return {"data": None, "error": last_error or "unknown"}

    def search(
        self,
        query: str,
        media: str = "anime",
        limit: int = 24,
        type: Optional[str] = None,
        status: Optional[str] = None,
        order_by: str = "popularity",
        sort: str = "desc",
        min_score: Optional[float] = None,
    ) -> dict:
        query = (query or "").strip()
        if len(query) < 2:
            return {"data": [], "query": query, "source": "anilist"}

        media = (media or "anime").strip().lower()
        is_anime = media == "anime"
        media_type = "ANIME" if is_anime else "MANGA"

        # Country filters for manhwa / manhua / webtoon.
        # Important: do NOT force format=MANGA when media=manga + type=any —
        # that would drop novels. Only apply format when user picks one.
        country = None
        format_filter = None
        type_key = (type or "").strip().lower()
        if type_key in ("", "any", "all", None):
            type_key = ""
        if not is_anime:
            if media in ("manhwa", "webtoon") or type_key in ("manhwa", "webtoon"):
                country = "KR"
            elif media == "manhua" or type_key == "manhua":
                country = "CN"
            elif media == "novel" or type_key in ("novel", "lightnovel"):
                format_filter = "NOVEL"
            elif type_key in FORMAT_MANGA:
                format_filter = FORMAT_MANGA[type_key]
            # media == "manga" with no type: leave format/country open (JP+KR+CN)
        else:
            if type_key in FORMAT_ANIME:
                format_filter = FORMAT_ANIME[type_key]

        status_map = STATUS_ANIME if is_anime else STATUS_MANGA
        status_key = (status or "").strip().lower()
        status_filter = status_map.get(status_key) if status_key and status_key != "any" else None

        order_key = (order_by or "popularity").strip().lower()
        sort_key = (sort or "desc").strip().lower()
        # AniList MediaSort enum — only these directions exist.
        sort_map = {
            "popularity": "POPULARITY_DESC",
            "score": "SCORE_DESC",
            "title": "TITLE_ROMAJI" if sort_key != "desc" else "TITLE_ROMAJI_DESC",
            "start_date": "START_DATE_DESC" if sort_key != "asc" else "START_DATE",
        }
        # Always bias SEARCH_MATCH first for accuracy.
        sort_list = ["SEARCH_MATCH", sort_map.get(order_key, "POPULARITY_DESC")]

        per_page = max(1, min(50, int(limit or 24)))
        variables: Dict[str, Any] = {
            "search": query,
            "type": media_type,
            "perPage": per_page,
            "sort": sort_list,
            "isAdult": False,
        }
        if format_filter:
            variables["format"] = format_filter
        if status_filter:
            variables["status"] = status_filter
        if country:
            variables["countryOfOrigin"] = country

        gql = (
            MEDIA_FRAGMENT
            + """
        query (
          $search: String, $type: MediaType, $perPage: Int, $sort: [MediaSort],
          $format: MediaFormat, $status: MediaStatus, $countryOfOrigin: CountryCode,
          $isAdult: Boolean
        ) {
          Page(page: 1, perPage: $perPage) {
            media(
              search: $search, type: $type, sort: $sort,
              format: $format, status: $status, countryOfOrigin: $countryOfOrigin,
              isAdult: $isAdult
            ) {
              ...MediaFields
            }
          }
        }
        """
        )
        payload = self.gql(gql, variables)
        if payload.get("error") and not ((payload.get("data") or {}).get("Page") or {}).get("media"):
            return {"data": [], "error": payload.get("error"), "query": query, "source": "anilist"}

        items = (((payload.get("data") or {}).get("Page") or {}).get("media")) or []
        data = [slim_media(m) for m in items]

        # Client-side min score (AniList averageScore is 0-100; we store /10)
        try:
            min_s = float(min_score) if min_score not in (None, "", 0, "0") else 0
        except (TypeError, ValueError):
            min_s = 0
        if min_s > 0:
            data = [d for d in data if (d.get("score") or 0) >= min_s]

        return {
            "data": data,
            "error": payload.get("error"),
            "query": query,
            "media": media,
            "source": "anilist",
            "filters": {
                "type": type_key or "any",
                "status": status_key or "any",
                "order_by": order_key,
                "sort": sort_key,
                "min_score": min_s,
            },
        }

    def _season_page(self, season: str, year: int, page: int = 1, per_page: int = 50) -> dict:
        gql = (
            MEDIA_FRAGMENT
            + """
        query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { hasNextPage }
            media(
              season: $season, seasonYear: $seasonYear, type: ANIME,
              sort: [POPULARITY_DESC], isAdult: false
            ) { ...MediaFields }
          }
        }
        """
        )
        return self.gql(
            gql,
            {
                "season": season.upper(),
                "seasonYear": int(year),
                "page": page,
                "perPage": per_page,
            },
        )

    def season_now(self, pages: int = 2) -> dict:
        now = datetime.now()
        season = SEASON_BY_MONTH[now.month]
        return self._collect_season(season, now.year, pages)

    def season_upcoming(self, pages: int = 2) -> dict:
        now = datetime.now()
        season = SEASON_BY_MONTH[now.month]
        nxt = NEXT_SEASON[season]
        year = now.year + (1 if season == "FALL" else 0)
        return self._collect_season(nxt, year, pages)

    def _collect_season(self, season: str, year: int, pages: int) -> dict:
        results = []
        error = None
        for page in range(1, pages + 1):
            payload = self._season_page(season, year, page=page)
            if payload.get("error") and not ((payload.get("data") or {}).get("Page") or {}).get("media"):
                error = payload.get("error")
                break
            page_data = (payload.get("data") or {}).get("Page") or {}
            batch = page_data.get("media") or []
            results.extend(slim_media(m) for m in batch)
            if not (page_data.get("pageInfo") or {}).get("hasNextPage"):
                break
        return {"data": results, "error": error, "source": "anilist", "season": season, "year": year}

    def season_year_quarter(self, year: int, quarter: str, pages: int = 3) -> dict:
        season = quarter.upper()
        return self._collect_season(season, year, pages)

    def airing_schedule(self, start_ts: int, end_ts: int, pages: int = 4) -> dict:
        """Fetch airing schedules between unix timestamps (inclusive-ish)."""
        gql = (
            MEDIA_FRAGMENT
            + """
        query ($from: Int, $to: Int, $page: Int) {
          Page(page: $page, perPage: 50) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
              airingAt
              episode
              media { ...MediaFields }
            }
          }
        }
        """
        )
        results = []
        error = None
        for page in range(1, pages + 1):
            payload = self.gql(gql, {"from": int(start_ts), "to": int(end_ts), "page": page})
            if payload.get("error") and not ((payload.get("data") or {}).get("Page") or {}).get("airingSchedules"):
                error = payload.get("error")
                break
            page_data = (payload.get("data") or {}).get("Page") or {}
            batch = page_data.get("airingSchedules") or []
            for row in batch:
                media = row.get("media")
                if not media or media.get("isAdult"):
                    continue
                slim = slim_media(media)
                airing_at = row.get("airingAt")
                if airing_at:
                    dt = datetime.fromtimestamp(int(airing_at), tz=timezone.utc)
                    jst = dt + timedelta(hours=9)
                    slim["broadcast_day"] = jst.strftime("%A")
                    slim["broadcast_time"] = jst.strftime("%H:%M")
                    slim["airing_at"] = int(airing_at)
                    slim["next_episode"] = row.get("episode")
                results.append(slim)
            if not (page_data.get("pageInfo") or {}).get("hasNextPage"):
                break
        return {"data": results, "error": error, "source": "anilist"}

    def bootstrap(self) -> dict:
        """Today's airing + current season + upcoming season (parallel)."""
        now = datetime.now(timezone.utc)
        # Local day window in UTC covering JST day roughly
        local = datetime.now().astimezone()
        day_start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end_local = day_start_local + timedelta(days=1)
        start_ts = int(day_start_local.timestamp()) - 3600
        end_ts = int(day_end_local.timestamp()) + 3600

        with ThreadPoolExecutor(max_workers=3) as pool:
            today_f = pool.submit(self.airing_schedule, start_ts, end_ts, 3)
            now_f = pool.submit(self.season_now, 2)
            up_f = pool.submit(self.season_upcoming, 1)
            today_payload = today_f.result()
            now_payload = now_f.result()
            up_payload = up_f.result()

        # Dedupe today by mal_id, prefer first airing time
        seen = {}
        for item in today_payload.get("data") or []:
            key = item.get("mal_id") or item.get("anilist_id")
            if key not in seen:
                seen[key] = item
        today_list = list(seen.values())
        today_list.sort(key=lambda x: (x.get("broadcast_time") or "99:99", x.get("title") or ""))

        today_name = DAYS[datetime.now().weekday()]
        return {
            "now": now_payload.get("data") or [],
            "upcoming": up_payload.get("data") or [],
            "today": today_list,
            "today_name": today_name,
            "error": today_payload.get("error")
            or now_payload.get("error")
            or up_payload.get("error"),
            "source": "anilist",
        }

    def _airing_range(self, start_local: datetime, end_local: datetime, chunk_days: int = 7, pages: int = 8) -> dict:
        """Fetch airing schedules between local datetimes in chunks (full coverage)."""
        results = []
        error = None
        cursor = start_local
        while cursor < end_local:
            chunk_end = min(cursor + timedelta(days=chunk_days), end_local)
            payload = self.airing_schedule(
                int(cursor.timestamp()) - 1800,
                int(chunk_end.timestamp()) + 1800,
                pages=pages,
            )
            if payload.get("error") and not payload.get("data"):
                error = payload.get("error")
            results.extend(payload.get("data") or [])
            cursor = chunk_end
        return {"data": results, "error": error, "source": "anilist"}

    def weekly(self) -> dict:
        """Full week episode airing board from AniList schedules."""
        local = datetime.now().astimezone()
        # Start of current week (Monday)
        start = local - timedelta(days=local.weekday())
        start = start.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=7)
        # Two half-week chunks so pagination never truncates busy days.
        payload = self._airing_range(start, end, chunk_days=4, pages=8)
        schedule = {day: [] for day in DAYS}
        seen_day = {day: set() for day in DAYS}
        for item in payload.get("data") or []:
            airing_at = item.get("airing_at")
            if airing_at:
                dt = datetime.fromtimestamp(int(airing_at)).astimezone()
                # Only keep rows that fall inside this week locally.
                if dt < start or dt >= end:
                    continue
                day = DAYS[dt.weekday()]
                item = {
                    **item,
                    "broadcast_day": dt.strftime("%A"),
                    "broadcast_time": dt.strftime("%H:%M"),
                    "airing_local": dt.isoformat(),
                }
            else:
                day = (item.get("broadcast_day") or "").lower()
                if day not in schedule:
                    continue
            key = (
                item.get("mal_id") or item.get("anilist_id"),
                item.get("next_episode"),
            )
            if key in seen_day[day]:
                continue
            seen_day[day].add(key)
            schedule[day].append(item)
        for day in DAYS:
            schedule[day].sort(
                key=lambda x: (x.get("broadcast_time") or "99:99", x.get("title") or "")
            )
        return {
            "schedule": schedule,
            "week_start": start.date().isoformat(),
            "week_end": (end - timedelta(seconds=1)).date().isoformat(),
            "total": sum(len(v) for v in schedule.values()),
            "error": payload.get("error"),
            "source": "anilist",
            "last_refreshed": datetime.now().isoformat(),
        }

    def monthly(self, year: Optional[int] = None, month: Optional[int] = None) -> dict:
        """Month calendar of episode releases + series premieres."""
        now = datetime.now().astimezone()
        year = int(year or now.year)
        month = int(month or now.month)
        days_in_month = calendar.monthrange(year, month)[1]
        start = now.replace(
            year=year, month=month, day=1, hour=0, minute=0, second=0, microsecond=0
        )
        end = start + timedelta(days=days_in_month)

        # 1) Real episode drops for every day this month (what users expect).
        airing_payload = self._airing_range(start, end, chunk_days=8, pages=8)
        error = airing_payload.get("error")
        releases_by_day: Dict[str, list] = {}
        ongoing_map: Dict[Any, dict] = {}
        for item in airing_payload.get("data") or []:
            airing_at = item.get("airing_at")
            if not airing_at:
                continue
            dt = datetime.fromtimestamp(int(airing_at)).astimezone()
            if dt.year != year or dt.month != month:
                continue
            day = dt.day
            entry = {
                **item,
                "premiere_day": day,
                "broadcast_day": dt.strftime("%A"),
                "broadcast_time": dt.strftime("%H:%M"),
                "airing_local": dt.isoformat(),
                "episode_label": f"Ep {item.get('next_episode')}"
                if item.get("next_episode")
                else None,
            }
            releases_by_day.setdefault(str(day), []).append(entry)
            key = item.get("mal_id") or item.get("anilist_id")
            if key:
                ongoing_map[key] = entry

        for day_key in releases_by_day:
            releases_by_day[day_key].sort(
                key=lambda x: (x.get("broadcast_time") or "99:99", x.get("title") or "")
            )

        # 2) Series premieres (first air date this month) from season lists.
        season = SEASON_BY_MONTH[month]
        seasons_to_fetch = [season]
        if month in (3, 6, 9, 12):
            seasons_to_fetch.append(NEXT_SEASON[season])
        if month in (1, 4, 7, 10):
            prev = {v: k for k, v in NEXT_SEASON.items()}[season]
            seasons_to_fetch.append(prev)

        combined = {}
        for s in seasons_to_fetch:
            y = year
            if s == "WINTER" and month == 12:
                y = year + 1
            if s == "FALL" and month == 1:
                y = year - 1
            payload = self._collect_season(s, y, pages=2)
            if payload.get("error") and not payload.get("data"):
                error = error or payload.get("error")
            for item in payload.get("data") or []:
                key = item.get("mal_id") or item.get("anilist_id")
                combined[key] = item

        premieres = []
        starting_soon = []
        today = now.date()
        for item in combined.values():
            aired_from = item.get("aired_from")
            dt = None
            if aired_from:
                try:
                    dt = datetime.fromisoformat(aired_from.replace("Z", "+00:00"))
                except ValueError:
                    dt = None
            if dt and dt.year == year and dt.month == month:
                premieres.append({**item, "premiere_day": dt.day})
            if dt and not item.get("airing"):
                d = dt.date()
                if d > today and (d - today).days <= 45:
                    starting_soon.append(
                        {**item, "premiere_day": dt.day, "premiere_month": dt.month}
                    )

        premieres.sort(key=lambda x: (x.get("premiere_day", 99), x.get("title") or ""))
        starting_soon.sort(key=lambda x: x.get("aired_from") or "")
        ongoing = sorted(
            ongoing_map.values(),
            key=lambda x: x.get("score") or 0,
            reverse=True,
        )

        # Calendar uses episode releases (not just series premieres).
        premiere_by_day = releases_by_day

        broadcast_map: Dict[str, list] = {}
        for item in ongoing:
            day = (item.get("broadcast_day") or "").lower()
            if day in DAYS:
                broadcast_map.setdefault(day, []).append(item)

        release_count = sum(len(v) for v in releases_by_day.values())
        return {
            "year": year,
            "month": month,
            "month_name": calendar.month_name[month],
            "days_in_month": days_in_month,
            "premieres": premieres,
            "ongoing": ongoing[:60],
            "starting_soon": starting_soon[:20],
            "premiere_by_day": premiere_by_day,
            "releases_by_day": releases_by_day,
            "broadcast_map": broadcast_map,
            "release_count": release_count,
            "error": error,
            "source": "anilist",
            "last_refreshed": datetime.now().isoformat(),
        }

    def yearly(self, year: Optional[int] = None) -> dict:
        now = datetime.now()
        year = int(year or now.year)
        combined = {}
        error = None
        for quarter in ("WINTER", "SPRING", "SUMMER", "FALL"):
            payload = self._collect_season(quarter, year, pages=2)
            if payload.get("error") and not payload.get("data"):
                error = payload.get("error")
            for item in payload.get("data") or []:
                key = item.get("mal_id") or item.get("anilist_id")
                combined[key] = item

        # Also include currently airing / upcoming if same year
        for extra in (self.season_now(1), self.season_upcoming(1)):
            for item in extra.get("data") or []:
                key = item.get("mal_id") or item.get("anilist_id")
                combined[key] = item

        today = now.date()
        premieres = []
        announced_tba = []
        airing = []
        finished = []
        for item in combined.values():
            if item.get("airing"):
                airing.append(item)
                continue
            aired = item.get("aired_from")
            if not aired:
                if year >= now.year:
                    announced_tba.append(item)
                continue
            try:
                dt = datetime.fromisoformat(aired.replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.year != year:
                continue
            status = (item.get("status") or "").lower()
            if "finish" in status:
                finished.append(item)
            elif dt.date() >= today:
                premieres.append(
                    {
                        **item,
                        "premiere_month": dt.month,
                        "premiere_day": dt.day,
                    }
                )
            else:
                finished.append(item)

        premieres.sort(key=lambda x: (x.get("aired_from") or "", x.get("title") or ""))
        announced_tba.sort(key=lambda x: (-(x.get("popularity") or 0), x.get("title") or ""))
        airing.sort(key=lambda x: x.get("score") or 0, reverse=True)
        finished.sort(key=lambda x: x.get("score") or 0, reverse=True)

        by_month: Dict[str, list] = {}
        for item in premieres:
            m = item.get("premiere_month")
            if m:
                by_month.setdefault(str(m), []).append(item)

        by_quarter = {q.lower(): [] for q in ("WINTER", "SPRING", "SUMMER", "FALL")}
        for item in combined.values():
            aired = item.get("aired_from")
            if not aired:
                continue
            try:
                dt = datetime.fromisoformat(aired.replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.year != year:
                continue
            q = SEASON_BY_MONTH[dt.month].lower()
            by_quarter[q].append(item)

        month_names = [
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
        return {
            "year": year,
            "total": len(combined),
            "premieres": premieres,
            "announced_tba": announced_tba,
            "airing": airing,
            "finished": finished[:40],
            "by_month": by_month,
            "by_quarter": by_quarter,
            "month_names": month_names,
            "last_refreshed": datetime.now().isoformat(),
            "error": error,
            "source": "anilist",
        }

    def get_anime_by_mal(self, mal_id: int) -> dict:
        gql = (
            MEDIA_FRAGMENT
            + """
        query ($idMal: Int) {
          Media(idMal: $idMal, type: ANIME) { ...MediaFields }
        }
        """
        )
        payload = self.gql(gql, {"idMal": int(mal_id)})
        media = (payload.get("data") or {}).get("Media")
        if not media:
            return {"ok": False, "error": payload.get("error") or "Not found", "data": None}
        return {"ok": True, "data": slim_media(media), "raw": media}

    def next_episode_info(self, mal_id: int) -> dict:
        info = self.get_anime_by_mal(mal_id)
        if not info.get("ok"):
            return info
        raw = info.get("raw") or {}
        next_ep = raw.get("nextAiringEpisode") or {}
        return {
            "ok": True,
            "mal_id": mal_id,
            "episodes": raw.get("episodes"),
            "next_episode": next_ep.get("episode"),
            "airing_at": next_ep.get("airingAt"),
            "status": raw.get("status"),
            "data": info.get("data"),
        }
