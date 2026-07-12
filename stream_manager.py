import re
import threading
import time
from difflib import SequenceMatcher
from urllib.parse import urljoin

import requests

AH_BASE = "https://animeheaven.me"
CACHE_TTL = 600
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)
BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": AH_BASE + "/",
    "Origin": AH_BASE,
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": BROWSER_UA,
}


def _normalize_title(value):
    text = (value or "").lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class StreamManager:
    def __init__(self, session: requests.Session):
        self._session = session
        self._lock = threading.Lock()
        self._cache = {}
        self._session_ready = False
        # Ensure session looks like a real browser for AnimeHeaven/CDN.
        self._session.headers.update(BROWSER_HEADERS)
        self._ensure_session()

    def _ensure_session(self):
        if self._session_ready:
            return
        with self._lock:
            if self._session_ready:
                return
            try:
                self._session.get(AH_BASE + "/", timeout=25, headers=BROWSER_HEADERS)
                self._session_ready = True
            except requests.RequestException:
                # Leave unready so next call retries warm-up.
                self._session_ready = False
                raise

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

    def _fetch(self, path, params=None):
        self._ensure_session()
        url = urljoin(AH_BASE + "/", path.lstrip("/"))
        last_error = None
        for attempt in range(4):
            try:
                response = self._session.get(
                    url,
                    params=params,
                    timeout=25,
                    headers=BROWSER_HEADERS,
                )
                if response.status_code in (403, 429, 503) and attempt < 3:
                    self._session_ready = False
                    time.sleep(0.4 * (attempt + 1))
                    try:
                        self._ensure_session()
                    except requests.RequestException as warm_err:
                        last_error = warm_err
                    last_error = response
                    continue
                response.raise_for_status()
                return response.text
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_error = exc
                self._session_ready = False
                time.sleep(0.45 * (attempt + 1))
                continue
        if isinstance(last_error, requests.Response):
            last_error.raise_for_status()
        raise requests.RequestException(f"Failed to fetch {url}: {last_error}")

    def _parse_fastsearch(self, html):
        results = []
        seen = set()
        # Current AH markup: href then alt then fastname (order flexible).
        pattern = re.compile(
            r"href=['\"]/anime\.php\?([a-z0-9]+)['\"][\s\S]*?"
            r"(?:alt=['\"]([^'\"]*)['\"][\s\S]*?)?"
            r"class=['\"]fastname['\"]>([^<]+)<",
            re.IGNORECASE,
        )
        for ah_id, alt, name in pattern.findall(html):
            if ah_id in seen:
                continue
            seen.add(ah_id)
            title = (name or alt or "").strip()
            if title:
                results.append(
                    {
                        "ah_id": ah_id,
                        "title": title,
                        "url": f"{AH_BASE}/anime.php?{ah_id}",
                    }
                )
        if results:
            return results

        # Fallback: bare anime.php links
        for ah_id in re.findall(r"href=['\"]/anime\.php\?([a-z0-9]+)['\"]", html, flags=re.I):
            if ah_id in seen:
                continue
            seen.add(ah_id)
            results.append(
                {
                    "ah_id": ah_id,
                    "title": ah_id,
                    "url": f"{AH_BASE}/anime.php?{ah_id}",
                }
            )
        return results

    def _score_match(self, query, candidate):
        q = _normalize_title(query)
        c = _normalize_title(candidate)
        if not q or not c:
            return 0.0
        if q == c:
            return 1.0
        if q in c or c in q:
            return 0.92
        ratio = SequenceMatcher(None, q, c).ratio()
        q_words = set(q.split())
        c_words = set(c.split())
        overlap = len(q_words & c_words) / max(len(q_words), 1)
        return max(ratio, overlap * 0.85)

    def search(self, query, limit=12):
        query = (query or "").strip()
        if len(query) < 2:
            return {"data": []}

        cache_key = f"search:{query.lower()}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        html = self._fetch("fastsearch.php", {"xhr": "1", "s": query})
        data = self._parse_fastsearch(html)[:limit]
        result = {"data": data}
        if data:
            self._set_cached(cache_key, result)
        return result

    def get_anime(self, ah_id):
        ah_id = (ah_id or "").strip()
        if not ah_id:
            return {"ok": False, "error": "Missing AnimeHeaven id"}

        cache_key = f"anime:{ah_id}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        html = self._fetch(f"anime.php?{ah_id}")
        title_match = re.search(r"class=['\"]infotitle c['\"]>([^<]+)</div>", html, re.I)
        jp_match = re.search(r"class=['\"]infotitlejp c['\"]>([^<]+)</div>", html, re.I)
        episodes = []
        # Markup: gatea("hash") ... class=' watch2 bc '>N
        for gate_hash, ep_num in re.findall(
            r"gatea\([\"']([a-f0-9]+)[\"']\)[\s\S]{0,400}?watch2[^>]*>(\d+)",
            html,
            flags=re.IGNORECASE,
        ):
            episodes.append(
                {
                    "episode": int(ep_num),
                    "gate_hash": gate_hash,
                }
            )

        # Deduplicate by episode number (keep first/highest hash order later sorted)
        by_ep = {}
        for ep in episodes:
            by_ep[ep["episode"]] = ep
        episodes = sorted(by_ep.values(), key=lambda item: item["episode"], reverse=True)

        result = {
            "ok": True,
            "ah_id": ah_id,
            "title": (title_match.group(1).strip() if title_match else ah_id),
            "title_japanese": (jp_match.group(1).strip() if jp_match else ""),
            "url": f"{AH_BASE}/anime.php?{ah_id}",
            "episodes": episodes,
            "episode_count": len(episodes),
        }
        self._set_cached(cache_key, result)
        return result

    def get_stream_sources(self, gate_hash):
        gate_hash = (gate_hash or "").strip()
        if not gate_hash:
            return {"ok": False, "error": "Missing episode key"}

        cache_key = f"stream:{gate_hash}"
        cached = self._get_cached(cache_key)
        if cached:
            return cached

        last_error = None
        for attempt in range(3):
            try:
                session = requests.Session()
                session.headers.update(BROWSER_HEADERS)
                session.cookies.set("key", gate_hash, domain="animeheaven.me", path="/")
                # Warm homepage then gate (some edges expect prior cookie jar)
                try:
                    session.get(AH_BASE + "/", timeout=20)
                except requests.RequestException:
                    pass
                response = session.get(f"{AH_BASE}/gate.php", timeout=25)
                response.raise_for_status()

                sources = []
                seen = set()
                for src in re.findall(
                    r"<source[^>]+src=['\"]([^'\"]+)['\"]",
                    response.text,
                    flags=re.I,
                ):
                    if re.search(r"[&?]error\d*", src, flags=re.I):
                        continue
                    if src in seen:
                        continue
                    seen.add(src)
                    sources.append(src)

                if not sources:
                    last_error = "No stream found for this episode"
                    time.sleep(0.35 * (attempt + 1))
                    continue

                result = {
                    "ok": True,
                    "sources": sources,
                    "primary": sources[0],
                    "referer": AH_BASE + "/",
                }
                self._set_cached(cache_key, result)
                return result
            except requests.RequestException as exc:
                last_error = str(exc)
                time.sleep(0.4 * (attempt + 1))

        return {"ok": False, "error": last_error or "Stream lookup failed"}

    def resolve_for_titles(self, titles):
        candidates = []
        for raw in titles or []:
            title = (raw or "").strip()
            if not title:
                continue
            try:
                payload = self.search(title, limit=10)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
            for hit in payload.get("data") or []:
                score = max(self._score_match(t, hit["title"]) for t in titles if t)
                candidates.append({**hit, "score": score})

        if not candidates:
            return {"ok": False, "error": "No results on AnimeHeaven"}

        best = max(candidates, key=lambda item: item.get("score", 0))
        if best.get("score", 0) < 0.42:
            return {
                "ok": False,
                "error": "Could not match this show on AnimeHeaven — try searching manually",
                "suggestions": self.search(titles[0], limit=6).get("data", []),
            }

        details = self.get_anime(best["ah_id"])
        if not details.get("ok"):
            return details

        return {
            "ok": True,
            "match_score": round(best["score"], 2),
            "ah_id": details["ah_id"],
            "title": details["title"],
            "title_japanese": details.get("title_japanese"),
            "url": details["url"],
            "episodes": details["episodes"],
            "episode_count": details["episode_count"],
        }
