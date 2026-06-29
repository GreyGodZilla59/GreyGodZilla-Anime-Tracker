# Grey GodZilla Anime Tracker

Portable Windows desktop app for tracking **airing and upcoming anime** — daily, weekly, and monthly views, plus Discord webhook alerts when tracked shows release new episodes.

![Grey GodZilla](assets/greygodzilla_logo.png)

## Download

**Latest release:** [GitHub Releases](https://github.com/GreyGodZilla59/GreyGodZilla-Anime-Tracker/releases/latest)

**v1.2.0** — In-app streaming via AnimeHeaven.me, webhook alerts, schedule views.

Single `.exe`, no installer, no account.

## Quick start

1. Download `Grey GodZilla Anime Tracker v1.1.3.exe` from Releases
2. Run it anywhere — no install step
3. Browse **Today**, **This Week**, **This Month**, **Airing Now**, or **Upcoming**
4. Click **▶ Watch** on any show to stream via [AnimeHeaven.me](https://animeheaven.me)
5. Click **+ Track** for webhook alerts, or use the **Webhooks** tab
6. Paste a Discord webhook URL → **Send Test Ping** → enable notifications → **Save Settings**

## Features

- **Schedule views** — Today, This Week, This Month
- **Airing & Upcoming** — full season lists with search
- **▶ Watch** — stream episodes in-app via AnimeHeaven.me
- **Webhook notifications** — Discord (or any HTTP endpoint) when a tracked show drops a new episode
- **Fast startup** — disk + memory cache, lazy loading for weekly/monthly
- **Grey GodZilla branding** — fiery dark theme, portable `.exe`

## Data source — thank you, Jikan

All anime metadata, schedules, and episode data come from the **[Jikan API](https://jikan.moe)** — the unofficial MyAnimeList API.

**Huge thanks to [Irfan Dahir](https://github.com/irfan-dahir)** and the Jikan team for building and maintaining this project. Without Jikan, this app wouldn't exist.

- Jikan: https://jikan.moe
- Jikan REST docs: https://docs.api.jikan.moe
- Jikan on GitHub: https://github.com/jikan-me/jikan

Please respect Jikan's rate limits and consider [supporting the project on Patreon](https://www.patreon.com/jikan) if you use it heavily.

Anime titles and images are © their respective owners via MyAnimeList.

## Build from source

```bat
pip install pywebview requests pyinstaller
build.bat
```

Output: `dist\Grey GodZilla Anime Tracker v1.1.3.exe`

## Config

Stored in `%APPDATA%\GreyGodZilla\AnimeTracker\` (watchlist, webhook settings, cache).

## License

MIT — see [LICENSE](LICENSE)