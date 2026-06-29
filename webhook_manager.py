import json
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests

from version import APP_NAME, APP_PUBLISHER, APP_VERSION

API_BASE = "https://api.jikan.moe/v4"
DEFAULT_POLL_MINUTES = 30
DISCORD_COLOR = 0xFF5500


def _config_dir():
    base = Path(__import__("os").environ.get("APPDATA") or Path.home())
    root = base / "GreyGodZilla" / "AnimeTracker"
    root.mkdir(parents=True, exist_ok=True)
    return root


class WebhookManager:
    def __init__(self, session: requests.Session, request_fn):
        self._session = session
        self._request = request_fn
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._config = self._load_json("webhook_config.json", self._default_config())
        self._state = self._load_json("webhook_state.json", {"tracked": {}, "log": []})

    def _default_config(self):
        return {
            "enabled": False,
            "url": "",
            "poll_minutes": DEFAULT_POLL_MINUTES,
            "notify_premieres": True,
        }

    def _config_path(self, name):
        return _config_dir() / name

    def _load_json(self, name, default):
        path = self._config_path(name)
        if not path.exists():
            return default.copy() if isinstance(default, dict) else default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default.copy() if isinstance(default, dict) else default

    def _save_json(self, name, data):
        self._config_path(name).write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def get_config(self):
        with self._lock:
            watchlist = list(self._state.get("watchlist", []))
            return {
                **self._config,
                "watchlist": watchlist,
                "watchlist_count": len(watchlist),
            }

    def get_status(self):
        with self._lock:
            log = self._state.get("log", [])[-8:]
            return {
                "enabled": self._config.get("enabled", False),
                "url_set": bool((self._config.get("url") or "").strip()),
                "watchlist_count": len(self._state.get("watchlist", [])),
                "last_check": self._state.get("last_check"),
                "last_ping": self._state.get("last_ping"),
                "last_error": self._state.get("last_error"),
                "log": log,
            }

    def save_config(self, config):
        with self._lock:
            url = (config.get("url") or "").strip()
            if url and not self._valid_url(url):
                return {"ok": False, "error": "Invalid webhook URL"}

            self._config["enabled"] = bool(config.get("enabled"))
            self._config["url"] = url
            self._config["poll_minutes"] = max(
                15, min(120, int(config.get("poll_minutes") or DEFAULT_POLL_MINUTES))
            )
            self._config["notify_premieres"] = bool(
                config.get("notify_premieres", True)
            )
            self._save_json("webhook_config.json", self._config)
            self._restart_poller()
            return {"ok": True}

    def _valid_url(self, url):
        try:
            parsed = urlparse(url)
            return parsed.scheme in ("http", "https") and bool(parsed.netloc)
        except Exception:
            return False

    def get_watchlist(self):
        with self._lock:
            return list(self._state.get("watchlist", []))

    def add_to_watchlist(self, anime):
        mal_id = int(anime.get("mal_id") or 0)
        if not mal_id:
            return {"ok": False, "error": "Missing anime id"}

        entry = {
            "mal_id": mal_id,
            "title": anime.get("title_english") or anime.get("title") or "Unknown",
            "image": anime.get("image"),
            "url": anime.get("url"),
        }
        return self._add_watchlist_entry(entry)

    def add_to_watchlist_by_id(self, mal_id):
        mal_id = int(mal_id)
        if not mal_id:
            return {"ok": False, "error": "Missing anime id"}

        with self._lock:
            watchlist = self._state.setdefault("watchlist", [])
            if any(item["mal_id"] == mal_id for item in watchlist):
                return {"ok": True, "already": True, "title": next(
                    w["title"] for w in watchlist if w["mal_id"] == mal_id
                )}

        payload = self._request(f"/anime/{mal_id}")
        item = payload.get("data")
        if not item:
            return {"ok": False, "error": "Anime not found"}

        images = (item.get("images") or {}).get("jpg") or {}
        entry = {
            "mal_id": mal_id,
            "title": item.get("title_english") or item.get("title") or "Unknown",
            "image": images.get("large_image_url") or images.get("image_url"),
            "url": item.get("url"),
        }
        return self._add_watchlist_entry(entry)

    def _add_watchlist_entry(self, entry):
        mal_id = entry["mal_id"]
        with self._lock:
            watchlist = self._state.setdefault("watchlist", [])
            if any(item["mal_id"] == mal_id for item in watchlist):
                return {"ok": True, "already": True, "title": entry["title"]}

            tracked = self._state.setdefault("tracked", {})
            tracked[str(mal_id)] = {
                "last_episode_id": -1,
                "pending_baseline": True,
                "baseline_set_at": datetime.now().isoformat(),
            }
            watchlist.append(entry)
            self._save_json("webhook_state.json", self._state)

        threading.Thread(
            target=self._set_episode_baseline,
            args=(mal_id,),
            daemon=True,
        ).start()
        self._restart_poller()
        return {"ok": True, "title": entry["title"]}

    def _set_episode_baseline(self, mal_id):
        latest = self._fetch_latest_episode(mal_id)
        with self._lock:
            tracked = self._state.setdefault("tracked", {}).setdefault(
                str(mal_id), {"last_episode_id": 0}
            )
            if latest:
                tracked["last_episode_id"] = int(latest.get("episode_id") or 0)
                tracked["last_episode_title"] = latest.get("title")
                tracked["last_episode_aired"] = latest.get("aired")
            else:
                tracked["last_episode_id"] = 0
            tracked["pending_baseline"] = False
            self._save_json("webhook_state.json", self._state)

    def remove_from_watchlist(self, mal_id):
        mal_id = int(mal_id)
        with self._lock:
            watchlist = self._state.setdefault("watchlist", [])
            self._state["watchlist"] = [w for w in watchlist if w["mal_id"] != mal_id]
            self._state.get("tracked", {}).pop(str(mal_id), None)
            self._save_json("webhook_state.json", self._state)
            return {"ok": True}

    def test_webhook(self, url_override=None):
        url = (url_override or "").strip()
        if not url:
            with self._lock:
                url = (self._config.get("url") or "").strip()
        if not url:
            return {"ok": False, "error": "No webhook URL configured"}
        if not self._valid_url(url):
            return {"ok": False, "error": "Invalid webhook URL"}

        payload = self._build_payload(
            title="Grey GodZilla Anime Tracker",
            description="Webhook test — you'll get pinged here when a tracked show releases a new episode.",
            episode_label="Test",
            anime_url="https://myanimelist.net",
            image_url=None,
            webhook_url=url,
        )
        return self._send_webhook(url, payload, test=True)

    def check_now(self):
        with self._lock:
            url = (self._config.get("url") or "").strip()
            if not url:
                return {"ok": False, "error": "No webhook URL configured"}
            if not self._state.get("watchlist"):
                return {"ok": False, "error": "No shows on your watchlist"}
            if not self._config.get("enabled"):
                return {
                    "ok": False,
                    "error": "Notifications are disabled — check 'Enable episode notifications' and Save",
                }

        threading.Thread(target=self._check_watchlist, daemon=True).start()
        return {"ok": True, "message": "Checking watchlist now..."}

    def _fetch_latest_episode(self, mal_id):
        payload = self._request(f"/anime/{mal_id}/episodes", {"page": 1})
        if payload.get("error") and not payload.get("data"):
            return None

        data = payload.get("data") or []
        if not data:
            return None

        last = data[-1]
        if payload.get("pagination", {}).get("has_next_page"):
            last_page = payload.get("pagination", {}).get("last_visible_page", 2)
            if last_page > 1:
                tail = self._request(
                    f"/anime/{mal_id}/episodes",
                    {"page": int(last_page)},
                )
                tail_data = tail.get("data") or []
                if tail_data:
                    last = tail_data[-1]

        return {
            "episode_id": last.get("mal_id"),
            "title": last.get("title") or last.get("title_japanese"),
            "aired": last.get("aired"),
        }

    def _is_discord(self, url):
        return "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url

    def _build_payload(
        self,
        title,
        description,
        episode_label,
        anime_url,
        image_url,
        webhook_url=None,
    ):
        hook_url = webhook_url or (self._config.get("url") or "")
        if self._is_discord(hook_url):
            embed = {
                "title": f"New Episode: {title}",
                "description": description,
                "url": anime_url or None,
                "color": DISCORD_COLOR,
                "footer": {"text": f"{APP_NAME} v{APP_VERSION}"},
                "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            if image_url:
                embed["thumbnail"] = {"url": image_url}
            return {"embeds": [embed]}

        return {
            "event": "episode_released",
            "app": APP_NAME,
            "anime": title,
            "episode": episode_label,
            "description": description,
            "url": anime_url,
            "image": image_url,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }

    def _send_webhook(self, url, payload, test=False, anime_title=None):
        try:
            response = self._session.post(
                url,
                json=payload,
                timeout=15,
                headers={"Content-Type": "application/json"},
            )
            if response.status_code == 204 or response.status_code == 200:
                pass
            else:
                response.raise_for_status()
            with self._lock:
                self._state["last_ping"] = datetime.now().isoformat()
                self._state["last_error"] = None
                entry = {
                    "time": datetime.now().isoformat(),
                    "type": "test" if test else "episode",
                    "anime": anime_title or ("Test" if test else "Unknown"),
                    "ok": True,
                }
                self._state.setdefault("log", []).append(entry)
                self._state["log"] = self._state["log"][-50:]
                self._save_json("webhook_state.json", self._state)
            return {"ok": True}
        except Exception as exc:
            with self._lock:
                self._state["last_error"] = str(exc)
                self._save_json("webhook_state.json", self._state)
            detail = str(exc)
            if hasattr(exc, "response") and exc.response is not None:
                try:
                    body = exc.response.text[:200]
                    if body:
                        detail = f"{exc} — {body}"
                except Exception:
                    pass
            return {"ok": False, "error": detail}

    def _log_check(self, message):
        with self._lock:
            self._state["last_check"] = datetime.now().isoformat()
            entry = {
                "time": self._state["last_check"],
                "type": "check",
                "message": message,
                "ok": True,
            }
            self._state.setdefault("log", []).append(entry)
            self._state["log"] = self._state["log"][-50:]
            self._save_json("webhook_state.json", self._state)

    def _check_watchlist(self):
        with self._lock:
            if not self._config.get("enabled"):
                return
            url = (self._config.get("url") or "").strip()
            watchlist = list(self._state.get("watchlist", []))
            if not url or not watchlist:
                return

        pings = []
        for item in watchlist:
            mal_id = item["mal_id"]
            latest = self._fetch_latest_episode(mal_id)
            time.sleep(0.55)

            with self._lock:
                tracked = self._state.setdefault("tracked", {}).setdefault(
                    str(mal_id), {"last_episode_id": 0}
                )

            if not latest:
                continue

            if tracked.get("pending_baseline"):
                with self._lock:
                    tracked["last_episode_id"] = int(latest.get("episode_id") or 0)
                    tracked["pending_baseline"] = False
                    self._save_json("webhook_state.json", self._state)
                continue

            ep_id = int(latest.get("episode_id") or 0)
            prev_id = int(tracked.get("last_episode_id") or 0)

            if ep_id <= prev_id or prev_id < 0:
                continue

            ep_title = latest.get("title") or f"Episode {ep_id}"
            aired = latest.get("aired")
            aired_fmt = ""
            if aired:
                try:
                    aired_fmt = datetime.fromisoformat(
                        aired.replace("Z", "+00:00")
                    ).strftime("%b %d, %Y")
                except ValueError:
                    aired_fmt = aired

            description = f"**{ep_title}**"
            if aired_fmt:
                description += f"\nAired: {aired_fmt}"

            pings.append(
                {
                    "mal_id": mal_id,
                    "anime_title": item.get("title"),
                    "episode_id": ep_id,
                    "episode_title": ep_title,
                    "description": description,
                    "url": item.get("url"),
                    "image": item.get("image"),
                }
            )

        for ping in pings:
            payload = self._build_payload(
                title=ping["anime_title"],
                description=ping["description"],
                episode_label=ping["episode_title"],
                anime_url=ping.get("url"),
                image_url=ping.get("image"),
            )
            result = self._send_webhook(
                url, payload, anime_title=ping["anime_title"]
            )
            if result.get("ok"):
                with self._lock:
                    tracked = self._state["tracked"][str(ping["mal_id"])]
                    tracked["last_episode_id"] = ping["episode_id"]
                    tracked["last_episode_title"] = ping["episode_title"]
                    tracked["last_notified_at"] = datetime.now().isoformat()
                    self._save_json("webhook_state.json", self._state)

        self._log_check(
            f"Checked {len(watchlist)} show(s), {len(pings)} new episode(s)"
        )

    def _poll_loop(self):
        while not self._stop.is_set():
            try:
                self._check_watchlist()
            except Exception as exc:
                with self._lock:
                    self._state["last_error"] = str(exc)
                    self._save_json("webhook_state.json", self._state)

            with self._lock:
                minutes = int(self._config.get("poll_minutes") or DEFAULT_POLL_MINUTES)
            self._stop.wait(max(60, minutes * 60))

    def _restart_poller(self):
        self.stop()
        with self._lock:
            enabled = self._config.get("enabled")
            has_url = bool((self._config.get("url") or "").strip())
            has_watchlist = bool(self._state.get("watchlist"))
        if enabled and has_url and has_watchlist:
            self._stop.clear()
            self._thread = threading.Thread(target=self._poll_loop, daemon=True)
            self._thread.start()

    def start(self):
        self._restart_poller()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1)
        self._thread = None