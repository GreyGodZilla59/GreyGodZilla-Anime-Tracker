import re
import threading
import time
from difflib import SequenceMatcher
from urllib.parse import urljoin

import requests

AH_BASE = "https://animeheaven.me"
CACHE_TTL = 600


def _normalize_title(value):
    text = (value or "").lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class StreamManager:
    def __init__(self, session: requests.Session):
        self._session = session
        self._lock = threading.Lock()
        self._cache = {}

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
        url = urljoin(AH_BASE + "/", path.lstrip("/"))
        response = self._session.get(
            url,
            params=params,
            timeout=20,
            headers={
                "User-Agent": self._session.headers.get("User-Agent", "Mozilla/5.0"),
                "Referer": AH_BASE + "/",
            },
        )
        response.raise_for_status()
        return response.text

    def _parse_fastsearch(self, html):
        results = []
        seen = set()
        pattern = re.compile(
            r"href='/anime\.php\?([a-z0-9]+)'.*?alt='([^']*)'.*?class='fastname'>([^<]+)<",
            re.DOTALL | re.IGNORECASE,
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

        for ah_id in re.findall(r"href='/anime\.php\?([a-z0-9]+)'", html):
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
        title_match = re.search(r"class='infotitle c'>([^<]+)</div>", html)
        jp_match = re.search(r"class='infotitlejp c'>([^<]+)</div>", html)
        episodes = []
        for gate_hash, ep_num in re.findall(
            r"gatea\(\"([a-f0-9]+)\"\).*?watch2 bc[^>]*>(\d+)",
            html,
            flags=re.DOTALL,
        ):
            episodes.append(
                {
                    "episode": int(ep_num),
                    "gate_hash": gate_hash,
                }
            )

        episodes.sort(key=lambda item: item["episode"], reverse=True)
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

        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": self._session.headers.get("User-Agent", "Mozilla/5.0"),
                "Referer": AH_BASE + "/",
            }
        )
        session.cookies.set("key", gate_hash, domain="animeheaven.me", path="/")
        response = session.get(f"{AH_BASE}/gate.php", timeout=20)
        response.raise_for_status()

        sources = []
        seen = set()
        for src in re.findall(r"<source src='([^']+)'", response.text):
            if "&error" in src or src in seen:
                continue
            seen.add(src)
            sources.append(src)

        if not sources:
            return {"ok": False, "error": "No stream found for this episode"}

        result = {"ok": True, "sources": sources, "primary": sources[0]}
        self._set_cached(cache_key, result)
        return result

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