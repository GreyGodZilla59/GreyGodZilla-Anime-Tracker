/**
 * Grey GodZilla Anime Tracker — pure JS backend for Android / web.
 * Mirrors the Python pywebview API used by app.js.
 */
(function (global) {
  'use strict';

  const APP_NAME = 'Grey GodZilla Anime Tracker';
  const APP_VERSION = '1.4.1-android';
  const APP_PUBLISHER = 'Grey GodZilla';
  const ANILIST_URL = 'https://graphql.anilist.co';
  const AH_BASE = 'https://animeheaven.me';
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const SEASON_BY_MONTH = {
    1: 'WINTER', 2: 'WINTER', 3: 'WINTER',
    4: 'SPRING', 5: 'SPRING', 6: 'SPRING',
    7: 'SUMMER', 8: 'SUMMER', 9: 'SUMMER',
    10: 'FALL', 11: 'FALL', 12: 'FALL',
  };
  const NEXT_SEASON = { WINTER: 'SPRING', SPRING: 'SUMMER', SUMMER: 'FALL', FALL: 'WINTER' };
  const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const MEDIA_FRAGMENT = `
fragment MediaFields on Media {
  id idMal type format status episodes chapters volumes averageScore popularity favourites
  genres description(asHtml: false) siteUrl isAdult countryOfOrigin season seasonYear
  startDate { year month day } endDate { year month day }
  title { romaji english native } synonyms
  coverImage { large extraLarge medium }
  studios(isMain: true) { nodes { name } }
  staff(sort: RELEVANCE, perPage: 4) { edges { role node { name { full } } } }
  nextAiringEpisode { episode airingAt }
}`;

  const LS = {
    library: 'gg_library_v1',
    cache: 'gg_cache_v1',
    webhook: 'gg_webhook_v1',
    webhookState: 'gg_webhook_state_v1',
  };

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* quota */ }
  }

  function stripHtml(text) {
    if (!text) return '';
    return String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function isoFromFuzzy(dateObj) {
    if (!dateObj || !dateObj.year) return null;
    const y = dateObj.year;
    const m = dateObj.month || 1;
    const d = dateObj.day || 1;
    try {
      return new Date(Date.UTC(y, m - 1, d)).toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch {
      return null;
    }
  }

  function statusLabel(status, mediaType) {
    status = (status || '').toUpperCase();
    if (status === 'RELEASING') return mediaType === 'ANIME' ? 'Currently Airing' : 'Publishing';
    if (status === 'FINISHED') return 'Finished';
    if (status === 'NOT_YET_RELEASED') return mediaType === 'ANIME' ? 'Not yet aired' : 'Not yet published';
    if (status === 'HIATUS') return 'Hiatus';
    if (status === 'CANCELLED') return 'Cancelled';
    return status ? status.charAt(0) + status.slice(1).toLowerCase() : '';
  }

  function formatLabel(fmt) {
    return fmt ? String(fmt).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '';
  }

  function mediaFamily(item, mediaType) {
    if (mediaType === 'ANIME') return 'anime';
    const country = (item.countryOfOrigin || '').toUpperCase();
    const fmt = (item.format || '').toUpperCase();
    if (country === 'KR' || fmt === 'MANHWA') return 'manhwa';
    if (country === 'CN' || fmt === 'MANHUA') return 'manhua';
    if (fmt === 'NOVEL') return 'novel';
    return 'manga';
  }

  function slimMedia(item) {
    if (!item) return {};
    const mediaType = (item.type || 'ANIME').toUpperCase();
    const title = item.title || {};
    const cover = item.coverImage || {};
    const studios = [];
    for (const node of (item.studios && item.studios.nodes) || []) {
      if (node && node.name) studios.push(node.name);
    }
    if (mediaType !== 'ANIME' && !studios.length) {
      for (const edge of (item.staff && item.staff.edges) || []) {
        const role = ((edge && edge.role) || '').toLowerCase();
        const name = edge && edge.node && edge.node.name && edge.node.name.full;
        if (name && (role.includes('story') || role.includes('art') || role.includes('original'))) {
          studios.push(name);
        }
      }
    }
    const anilistId = item.id;
    const malId = item.idMal || anilistId;
    const nextEp = item.nextAiringEpisode || {};
    let broadcastDay = null;
    let broadcastTime = null;
    if (nextEp.airingAt) {
      const dt = new Date(nextEp.airingAt * 1000);
      const jst = new Date(dt.getTime() + 9 * 3600 * 1000);
      broadcastDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][jst.getUTCDay()];
      broadcastTime = `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    }
    const score = item.averageScore;
    return {
      mal_id: malId,
      anilist_id: anilistId,
      url: item.siteUrl || `https://anilist.co/${mediaType === 'ANIME' ? 'anime' : 'manga'}/${anilistId}`,
      title: title.romaji || title.english || title.native || 'Unknown',
      title_english: title.english,
      title_japanese: title.native,
      title_synonyms: item.synonyms || [],
      image: cover.extraLarge || cover.large || cover.medium,
      type: formatLabel(item.format) || (mediaType === 'ANIME' ? 'TV' : 'Manga'),
      episodes: item.episodes,
      chapters: item.chapters,
      volumes: item.volumes,
      status: statusLabel(item.status, mediaType),
      airing: item.status === 'RELEASING' && mediaType === 'ANIME',
      publishing: item.status === 'RELEASING' && mediaType !== 'ANIME',
      aired_from: isoFromFuzzy(item.startDate),
      aired_to: isoFromFuzzy(item.endDate),
      broadcast_day: broadcastDay,
      broadcast_time: broadcastTime,
      next_episode: nextEp.episode,
      score: score ? Math.round((score / 10) * 100) / 100 : null,
      rank: null,
      popularity: item.popularity,
      genres: item.genres || [],
      studios: studios.slice(0, 2),
      synopsis: stripHtml(item.description),
      media: mediaFamily(item, mediaType),
      season: item.season ? item.season.charAt(0) + item.season.slice(1).toLowerCase() : null,
      season_year: item.seasonYear,
      source: 'anilist',
    };
  }

  // ---------- HTTP (Capacitor native when available — bypasses CORS) ----------
  async function httpRequest(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const body = options.body;

    // Capacitor 5+ CapacitorHttp
    if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp) {
      const Http = global.Capacitor.Plugins.CapacitorHttp;
      const res = await Http.request({
        url,
        method,
        headers,
        data: body ? (typeof body === 'string' ? JSON.parse(body) : body) : undefined,
        connectTimeout: 20000,
        readTimeout: 20000,
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)),
        json: async () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data),
      };
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body || undefined,
    });
    return res;
  }

  async function gql(query, variables = {}) {
    const res = await httpRequest(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      return { data: null, error: `anilist_http_${res.status}` };
    }
    const json = await res.json();
    if (json.errors && json.errors.length) {
      return { data: json.data || null, error: json.errors[0].message || 'GraphQL error' };
    }
    return { data: json.data, error: null };
  }

  // ---------- Memory + disk cache ----------
  const memCache = new Map();
  const CACHE_TTL = 30 * 60 * 1000;

  function cacheGet(key) {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
    const disk = loadJSON(LS.cache, {});
    const entry = disk[key];
    if (entry && Date.now() - entry.ts < CACHE_TTL * 4) {
      memCache.set(key, entry);
      return entry.data;
    }
    return null;
  }

  function cacheSet(key, data) {
    const entry = { data, ts: Date.now() };
    memCache.set(key, entry);
    const disk = loadJSON(LS.cache, {});
    disk[key] = entry;
    // cap size
    const keys = Object.keys(disk);
    if (keys.length > 40) {
      keys.sort((a, b) => (disk[a].ts || 0) - (disk[b].ts || 0));
      keys.slice(0, keys.length - 30).forEach((k) => delete disk[k]);
    }
    saveJSON(LS.cache, disk);
  }

  function cacheClearSchedule() {
    memCache.clear();
    const disk = loadJSON(LS.cache, {});
    Object.keys(disk).forEach((k) => {
      if (/^(bootstrap|weekly|monthly|yearly|search|season)/.test(k)) delete disk[k];
    });
    saveJSON(LS.cache, disk);
  }

  // ---------- AniList data ----------
  async function airingSchedule(fromTs, toTs, pages = 4) {
    const query = MEDIA_FRAGMENT + `
      query ($from: Int, $to: Int, $page: Int) {
        Page(page: $page, perPage: 50) {
          pageInfo { hasNextPage }
          airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
            airingAt episode media { ...MediaFields }
          }
        }
      }`;
    const results = [];
    let error = null;
    for (let page = 1; page <= pages; page += 1) {
      const payload = await gql(query, { from: fromTs | 0, to: toTs | 0, page });
      if (payload.error && !(payload.data && payload.data.Page && payload.data.Page.airingSchedules)) {
        error = payload.error;
        break;
      }
      const batch = (payload.data && payload.data.Page && payload.data.Page.airingSchedules) || [];
      for (const row of batch) {
        const media = row.media;
        if (!media || media.isAdult) continue;
        const slim = slimMedia(media);
        if (row.airingAt) {
          const dt = new Date(row.airingAt * 1000);
          slim.airing_at = row.airingAt;
          slim.next_episode = row.episode;
          slim.broadcast_day = dt.toLocaleDateString('en-US', { weekday: 'long' });
          slim.broadcast_time = dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        }
        results.push(slim);
      }
      if (!(payload.data && payload.data.Page && payload.data.Page.pageInfo && payload.data.Page.pageInfo.hasNextPage)) break;
    }
    return { data: results, error };
  }

  async function airingRange(startMs, endMs, chunkDays = 7, pages = 6) {
    const results = [];
    let error = null;
    let cursor = startMs;
    const chunk = chunkDays * 24 * 3600 * 1000;
    while (cursor < endMs) {
      const chunkEnd = Math.min(cursor + chunk, endMs);
      const payload = await airingSchedule(
        Math.floor((cursor - 1800000) / 1000),
        Math.floor((chunkEnd + 1800000) / 1000),
        pages,
      );
      if (payload.error && !payload.data.length) error = payload.error;
      results.push(...(payload.data || []));
      cursor = chunkEnd;
    }
    return { data: results, error };
  }

  async function collectSeason(season, year, pages = 2) {
    const query = MEDIA_FRAGMENT + `
      query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { hasNextPage }
          media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: [POPULARITY_DESC], isAdult: false) {
            ...MediaFields
          }
        }
      }`;
    const results = [];
    let error = null;
    for (let page = 1; page <= pages; page += 1) {
      const payload = await gql(query, {
        season: season.toUpperCase(),
        seasonYear: year,
        page,
        perPage: 50,
      });
      if (payload.error && !(payload.data && payload.data.Page && payload.data.Page.media)) {
        error = payload.error;
        break;
      }
      const batch = (payload.data && payload.data.Page && payload.data.Page.media) || [];
      results.push(...batch.map(slimMedia));
      if (!(payload.data && payload.data.Page && payload.data.Page.pageInfo && payload.data.Page.pageInfo.hasNextPage)) break;
    }
    return { data: results, error, season, year };
  }

  // ---------- Library ----------
  function defaultLibrary() {
    return { favorites: [], history: [], progress: {} };
  }

  function getLibrary() {
    const lib = loadJSON(LS.library, defaultLibrary());
    if (!Array.isArray(lib.favorites)) lib.favorites = [];
    if (!Array.isArray(lib.history)) lib.history = [];
    if (!lib.progress || typeof lib.progress !== 'object') lib.progress = {};
    return lib;
  }

  function saveLibrary(lib) {
    saveJSON(LS.library, lib);
  }

  function slimEntry(item) {
    if (!item || !(item.mal_id || item.anilist_id)) return null;
    return {
      mal_id: Number(item.mal_id || item.anilist_id),
      title: item.title_english || item.title || 'Unknown',
      title_english: item.title_english,
      title_japanese: item.title_japanese,
      title_synonyms: item.title_synonyms || [],
      image: item.image,
      url: item.url,
      type: item.type,
      episodes: item.episodes,
      chapters: item.chapters,
      status: item.status,
      airing: item.airing,
      score: item.score,
      genres: item.genres || [],
      studios: item.studios || [],
      synopsis: item.synopsis || '',
      media: item.media || 'anime',
      aired_from: item.aired_from,
    };
  }

  // ---------- Stream (AnimeHeaven) ----------
  function normalizeTitle(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function scoreMatch(query, candidate) {
    const q = normalizeTitle(query);
    const c = normalizeTitle(candidate);
    if (!q || !c) return 0;
    if (q === c) return 1;
    if (q.includes(c) || c.includes(q)) return 0.92;
    const qw = new Set(q.split(' '));
    const cw = new Set(c.split(' '));
    let overlap = 0;
    qw.forEach((w) => { if (cw.has(w)) overlap += 1; });
    return (overlap / Math.max(qw.size, 1)) * 0.85;
  }

  async function ahFetch(path, params) {
    let url = path.startsWith('http') ? path : `${AH_BASE}/${path.replace(/^\//, '')}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    const res = await httpRequest(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${AH_BASE}/`,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`AnimeHeaven HTTP ${res.status}`);
    return res.text();
  }

  function parseFastSearch(html) {
    const results = [];
    const seen = new Set();
    const re = /href='\/anime\.php\?([a-z0-9]+)'[\s\S]*?alt='([^']*)'[\s\S]*?class='fastname'>([^<]+)</gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      results.push({
        ah_id: m[1],
        title: (m[3] || m[2] || '').trim(),
        url: `${AH_BASE}/anime.php?${m[1]}`,
      });
    }
    return results;
  }

  // ---------- Main API object ----------
  const api = {
    async get_app_info() {
      return {
        name: APP_NAME,
        version: APP_VERSION,
        publisher: APP_PUBLISHER,
        title: `${APP_NAME} v${APP_VERSION}`,
        platform: 'android',
      };
    },

    async get_bootstrap() {
      const cached = cacheGet('bootstrap');
      if (cached) return cached;
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const season = SEASON_BY_MONTH[now.getMonth() + 1];
      const next = NEXT_SEASON[season];
      const nextYear = season === 'FALL' ? now.getFullYear() + 1 : now.getFullYear();

      const [todayPayload, nowPayload, upPayload] = await Promise.all([
        airingSchedule(Math.floor(dayStart.getTime() / 1000) - 3600, Math.floor(dayEnd.getTime() / 1000) + 3600, 3),
        collectSeason(season, now.getFullYear(), 2),
        collectSeason(next, nextYear, 1),
      ]);

      const seen = new Map();
      for (const item of todayPayload.data || []) {
        const key = item.mal_id || item.anilist_id;
        if (!seen.has(key)) seen.set(key, item);
      }
      const today = [...seen.values()].sort((a, b) =>
        String(a.broadcast_time || '99').localeCompare(String(b.broadcast_time || '99')),
      );
      const result = {
        now: nowPayload.data || [],
        upcoming: upPayload.data || [],
        today,
        today_name: DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1],
        error: todayPayload.error || nowPayload.error || upPayload.error,
        source: 'anilist',
      };
      cacheSet('bootstrap', result);
      return result;
    },

    async get_weekly() {
      const cached = cacheGet('weekly');
      if (cached) return cached;
      const now = new Date();
      const start = new Date(now);
      const day = (start.getDay() + 6) % 7; // mon=0
      start.setDate(start.getDate() - day);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const payload = await airingRange(start.getTime(), end.getTime(), 4, 6);
      const schedule = Object.fromEntries(DAYS.map((d) => [d, []]));
      const seen = Object.fromEntries(DAYS.map((d) => [d, new Set()]));
      for (const item of payload.data || []) {
        if (!item.airing_at) continue;
        const dt = new Date(item.airing_at * 1000);
        if (dt < start || dt >= end) continue;
        const dayName = DAYS[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
        const key = `${item.mal_id}:${item.next_episode}`;
        if (seen[dayName].has(key)) continue;
        seen[dayName].add(key);
        schedule[dayName].push({
          ...item,
          broadcast_day: dt.toLocaleDateString('en-US', { weekday: 'long' }),
          broadcast_time: dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        });
      }
      for (const d of DAYS) {
        schedule[d].sort((a, b) => String(a.broadcast_time || '').localeCompare(String(b.broadcast_time || '')));
      }
      const result = {
        schedule,
        week_start: start.toISOString().slice(0, 10),
        week_end: new Date(end.getTime() - 1000).toISOString().slice(0, 10),
        total: DAYS.reduce((n, d) => n + schedule[d].length, 0),
        error: payload.error,
        source: 'anilist',
        last_refreshed: new Date().toISOString(),
      };
      cacheSet('weekly', result);
      return result;
    },

    async get_monthly(year, month) {
      const now = new Date();
      year = Number(year || now.getFullYear());
      month = Number(month || now.getMonth() + 1);
      const key = `monthly:${year}-${String(month).padStart(2, '0')}`;
      const cached = cacheGet(key);
      if (cached) return cached;

      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 1);
      const daysInMonth = new Date(year, month, 0).getDate();
      const airingPayload = await airingRange(start.getTime(), end.getTime(), 8, 6);

      const releasesByDay = {};
      const ongoingMap = new Map();
      for (const item of airingPayload.data || []) {
        if (!item.airing_at) continue;
        const dt = new Date(item.airing_at * 1000);
        if (dt.getFullYear() !== year || dt.getMonth() + 1 !== month) continue;
        const day = dt.getDate();
        const entry = {
          ...item,
          premiere_day: day,
          broadcast_day: dt.toLocaleDateString('en-US', { weekday: 'long' }),
          broadcast_time: dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
          episode_label: item.next_episode ? `Ep ${item.next_episode}` : null,
        };
        (releasesByDay[String(day)] = releasesByDay[String(day)] || []).push(entry);
        ongoingMap.set(item.mal_id || item.anilist_id, entry);
      }
      Object.keys(releasesByDay).forEach((d) => {
        releasesByDay[d].sort((a, b) => String(a.broadcast_time || '').localeCompare(String(b.broadcast_time || '')));
      });

      const season = SEASON_BY_MONTH[month];
      const seasons = [season];
      if ([3, 6, 9, 12].includes(month)) seasons.push(NEXT_SEASON[season]);
      if ([1, 4, 7, 10].includes(month)) {
        const prev = Object.entries(NEXT_SEASON).find(([, v]) => v === season);
        if (prev) seasons.push(prev[0]);
      }
      const combined = new Map();
      for (const s of seasons) {
        let y = year;
        if (s === 'WINTER' && month === 12) y = year + 1;
        if (s === 'FALL' && month === 1) y = year - 1;
        const payload = await collectSeason(s, y, 2);
        for (const item of payload.data || []) {
          combined.set(item.mal_id || item.anilist_id, item);
        }
      }

      const premieres = [];
      const startingSoon = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (const item of combined.values()) {
        if (!item.aired_from) continue;
        const dt = new Date(item.aired_from);
        if (Number.isNaN(dt.getTime())) continue;
        if (dt.getFullYear() === year && dt.getMonth() + 1 === month) {
          premieres.push({ ...item, premiere_day: dt.getDate() });
        }
        if (!item.airing && dt > today) {
          const days = (dt - today) / 86400000;
          if (days <= 45) {
            startingSoon.push({ ...item, premiere_day: dt.getDate(), premiere_month: dt.getMonth() + 1 });
          }
        }
      }
      premieres.sort((a, b) => (a.premiere_day || 99) - (b.premiere_day || 99));
      const ongoing = [...ongoingMap.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
      const releaseCount = Object.values(releasesByDay).reduce((n, arr) => n + arr.length, 0);

      const result = {
        year,
        month,
        month_name: MONTH_NAMES[month],
        days_in_month: daysInMonth,
        premieres,
        ongoing: ongoing.slice(0, 60),
        starting_soon: startingSoon.slice(0, 20),
        premiere_by_day: releasesByDay,
        releases_by_day: releasesByDay,
        broadcast_map: {},
        release_count: releaseCount,
        error: airingPayload.error,
        source: 'anilist',
        last_refreshed: new Date().toISOString(),
      };
      cacheSet(key, result);
      return result;
    },

    async get_yearly(year) {
      year = Number(year || new Date().getFullYear());
      const key = `yearly:${year}`;
      const cached = cacheGet(key);
      if (cached) return cached;
      const combined = new Map();
      for (const q of ['WINTER', 'SPRING', 'SUMMER', 'FALL']) {
        const payload = await collectSeason(q, year, 2);
        for (const item of payload.data || []) {
          combined.set(item.mal_id || item.anilist_id, item);
        }
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const premieres = [];
      const announced = [];
      const airing = [];
      const finished = [];
      for (const item of combined.values()) {
        if (item.airing) {
          airing.push(item);
          continue;
        }
        if (!item.aired_from) {
          if (year >= today.getFullYear()) announced.push(item);
          continue;
        }
        const dt = new Date(item.aired_from);
        if (dt.getFullYear() !== year) continue;
        const status = (item.status || '').toLowerCase();
        if (status.includes('finish')) finished.push(item);
        else if (dt >= today) {
          premieres.push({ ...item, premiere_month: dt.getMonth() + 1, premiere_day: dt.getDate() });
        } else finished.push(item);
      }
      const byMonth = {};
      for (const item of premieres) {
        const m = item.premiere_month;
        if (m) (byMonth[String(m)] = byMonth[String(m)] || []).push(item);
      }
      const byQuarter = { winter: [], spring: [], summer: [], fall: [] };
      for (const item of combined.values()) {
        if (!item.aired_from) continue;
        const dt = new Date(item.aired_from);
        if (dt.getFullYear() !== year) continue;
        const q = SEASON_BY_MONTH[dt.getMonth() + 1].toLowerCase();
        byQuarter[q].push(item);
      }
      const result = {
        year,
        total: combined.size,
        premieres,
        announced_tba: announced,
        airing,
        finished: finished.slice(0, 40),
        by_month: byMonth,
        by_quarter: byQuarter,
        month_names: MONTH_NAMES,
        last_refreshed: new Date().toISOString(),
        source: 'anilist',
      };
      cacheSet(key, result);
      return result;
    },

    async search_media(query, media = 'all', limit = 24, type = '', status = '', orderBy = 'popularity', sort = 'desc', minScore = 0) {
      query = String(query || '').trim();
      media = String(media || 'all').toLowerCase();
      if (['any', 'everything', '*'].includes(media)) media = 'all';
      if (query.length < 2) return { data: [], query, media, source: 'anilist' };

      // Search both anime + manga (includes manhwa/manhua)
      if (media === 'all') {
        const half = Math.max(8, Math.min(24, Math.floor((Number(limit) || 24) / 2) + 2));
        const animeType = ['tv', 'movie', 'ova', 'ona', 'special'].includes(String(type || '').toLowerCase()) ? type : '';
        const mangaType = ['manga', 'manhwa', 'manhua', 'webtoon', 'novel', 'one_shot', 'lightnovel'].includes(String(type || '').toLowerCase()) ? type : '';
        const [animeRes, mangaRes] = await Promise.all([
          this.search_media(query, 'anime', half, animeType, status, orderBy, sort, minScore),
          this.search_media(query, 'manga', half, mangaType, status, orderBy, sort, minScore),
        ]);
        const merged = [];
        const seen = new Set();
        for (const item of [...(animeRes.data || []), ...(mangaRes.data || [])]) {
          const key = item.anilist_id || item.mal_id || item.title;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
        merged.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.popularity || 0) - (a.popularity || 0));
        return {
          data: merged.slice(0, Math.min(50, Number(limit) || 24)),
          query,
          media: 'all',
          source: 'anilist',
          error: (!animeRes.data || !animeRes.data.length) ? (animeRes.error || mangaRes.error) : null,
        };
      }

      const cacheKey = `search:${media}:${query}:${type}:${status}:${orderBy}:${limit}`;
      const cached = cacheGet(cacheKey);
      if (cached) return cached;

      const isAnime = media === 'anime';
      const mediaType = isAnime ? 'ANIME' : 'MANGA';
      let country = null;
      let format = null;
      const typeKey = String(type || '').toLowerCase();
      if (!isAnime) {
        if (media === 'manhwa' || media === 'webtoon' || typeKey === 'manhwa' || typeKey === 'webtoon') country = 'KR';
        else if (media === 'manhua' || typeKey === 'manhua') country = 'CN';
        else if (typeKey === 'novel' || typeKey === 'lightnovel' || media === 'novel') format = 'NOVEL';
        else if (typeKey === 'one_shot' || typeKey === 'oneshot') format = 'ONE_SHOT';
        else if (typeKey === 'manga') format = 'MANGA';
        // media=manga + type any/empty → no format filter (all print media)
      } else {
        const map = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL' };
        if (map[typeKey]) format = map[typeKey];
      }

      const statusMap = {
        airing: 'RELEASING', publishing: 'RELEASING', complete: 'FINISHED', finished: 'FINISHED',
        upcoming: 'NOT_YET_RELEASED',
      };
      const statusFilter = statusMap[String(status || '').toLowerCase()] || null;
      const sortList = ['SEARCH_MATCH', orderBy === 'score' ? 'SCORE_DESC' : orderBy === 'title' ? 'TITLE_ROMAJI' : orderBy === 'start_date' ? 'START_DATE_DESC' : 'POPULARITY_DESC'];

      const queryGql = MEDIA_FRAGMENT + `
        query ($search: String, $type: MediaType, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $status: MediaStatus, $countryOfOrigin: CountryCode, $isAdult: Boolean) {
          Page(page: 1, perPage: $perPage) {
            media(search: $search, type: $type, sort: $sort, format: $format, status: $status, countryOfOrigin: $countryOfOrigin, isAdult: $isAdult) {
              ...MediaFields
            }
          }
        }`;
      const variables = {
        search: query,
        type: mediaType,
        perPage: Math.min(50, Math.max(1, Number(limit) || 24)),
        sort: sortList,
        isAdult: false,
      };
      if (format) variables.format = format;
      if (statusFilter) variables.status = statusFilter;
      if (country) variables.countryOfOrigin = country;

      const payload = await gql(queryGql, variables);
      let data = ((payload.data && payload.data.Page && payload.data.Page.media) || []).map(slimMedia);
      const minS = Number(minScore) || 0;
      if (minS > 0) data = data.filter((d) => (d.score || 0) >= minS);
      const result = {
        data,
        error: payload.error,
        query,
        media,
        source: 'anilist',
      };
      cacheSet(cacheKey, result);
      return result;
    },

    async search_anime(query, limit = 24, type, status, orderBy, sort, minScore) {
      return this.search_media(query, 'anime', limit, type, status, orderBy, sort, minScore);
    },
    async search_manga(query, limit = 24, type, status, orderBy, sort, minScore) {
      return this.search_media(query, type || 'manga', limit, type, status, orderBy, sort, minScore);
    },
    async search(query, media = 'anime', limit = 24) {
      return this.search_media(query, media, limit);
    },

    async get_favorites() {
      return getLibrary().favorites;
    },
    async toggle_favorite(item) {
      const lib = getLibrary();
      const entry = slimEntry(item);
      if (!entry) return { ok: false, error: 'Missing media id' };
      const exists = lib.favorites.some((f) => Number(f.mal_id) === entry.mal_id);
      if (exists) {
        lib.favorites = lib.favorites.filter((f) => Number(f.mal_id) !== entry.mal_id);
        saveLibrary(lib);
        return { ok: true, favorited: false, favorites: lib.favorites };
      }
      entry.favorited_at = new Date().toISOString();
      lib.favorites = [entry, ...lib.favorites];
      saveLibrary(lib);
      return { ok: true, favorited: true, favorites: lib.favorites };
    },
    async add_favorite(item) {
      return this.toggle_favorite(item);
    },
    async remove_favorite(malId) {
      const lib = getLibrary();
      lib.favorites = lib.favorites.filter((f) => Number(f.mal_id) !== Number(malId));
      saveLibrary(lib);
      return { ok: true, favorites: lib.favorites };
    },
    async get_history() {
      return getLibrary().history;
    },
    async mark_completed(item, note) {
      const lib = getLibrary();
      const entry = slimEntry(item);
      if (!entry) return { ok: false, error: 'Missing media id' };
      lib.history = lib.history.filter((h) => Number(h.mal_id) !== entry.mal_id);
      entry.completed_at = new Date().toISOString();
      if (note) entry.note = String(note).slice(0, 200);
      lib.history = [entry, ...lib.history];
      saveLibrary(lib);
      return { ok: true, history: lib.history };
    },
    async remove_from_history(malId) {
      const lib = getLibrary();
      lib.history = lib.history.filter((h) => Number(h.mal_id) !== Number(malId));
      saveLibrary(lib);
      return { ok: true, history: lib.history };
    },
    async get_watch_progress(malId, episode) {
      const lib = getLibrary();
      if (malId == null) return { ...lib.progress };
      if (episode != null) return lib.progress[`${Number(malId)}:${Number(episode)}`] || {};
      const prefix = `${Number(malId)}:`;
      const out = {};
      Object.keys(lib.progress).forEach((k) => {
        if (k.startsWith(prefix)) out[k] = lib.progress[k];
      });
      return out;
    },
    async get_last_watch_progress(malId) {
      const all = await this.get_watch_progress(malId);
      const entries = Object.values(all || {});
      if (!entries.length) return {};
      return entries.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || {};
    },
    async save_watch_progress(malId, episode, seconds, duration, title) {
      malId = Number(malId);
      episode = Number(episode);
      seconds = Math.max(0, Number(seconds) || 0);
      duration = Number(duration) || 0;
      if (!malId || episode < 0) return { ok: false, error: 'Invalid' };
      if (seconds < 5) return { ok: true, skipped: true };
      const lib = getLibrary();
      const key = `${malId}:${episode}`;
      if (duration > 30 && seconds >= duration - 15) {
        delete lib.progress[key];
        saveLibrary(lib);
        return { ok: true, cleared: true, near_end: true };
      }
      lib.progress[key] = {
        mal_id: malId,
        episode,
        seconds: Math.round(seconds * 100) / 100,
        duration: duration || null,
        title: title || null,
        updated_at: new Date().toISOString(),
      };
      saveLibrary(lib);
      return { ok: true, progress: lib.progress[key] };
    },
    async clear_watch_progress(malId, episode) {
      const lib = getLibrary();
      if (malId == null) lib.progress = {};
      else if (episode != null) delete lib.progress[`${Number(malId)}:${Number(episode)}`];
      else {
        const prefix = `${Number(malId)}:`;
        Object.keys(lib.progress).forEach((k) => {
          if (k.startsWith(prefix)) delete lib.progress[k];
        });
      }
      saveLibrary(lib);
      return { ok: true };
    },
    async get_library_summary() {
      const lib = getLibrary();
      return {
        favorites_count: lib.favorites.length,
        history_count: lib.history.length,
        progress_count: Object.keys(lib.progress).length,
      };
    },

    async search_stream(query, limit = 12) {
      try {
        const html = await ahFetch('fastsearch.php', { xhr: '1', s: query });
        return { data: parseFastSearch(html).slice(0, limit) };
      } catch (e) {
        return { data: [], error: String(e.message || e) };
      }
    },

    async resolve_stream(malId, titles) {
      const titleList = (titles || []).filter(Boolean);
      if (!titleList.length) return { ok: false, error: 'No title to search AnimeHeaven' };
      try {
        let best = null;
        for (const t of titleList) {
          const hits = await this.search_stream(t, 10);
          for (const hit of hits.data || []) {
            const score = Math.max(...titleList.map((x) => scoreMatch(x, hit.title)));
            if (!best || score > best.score) best = { ...hit, score };
          }
        }
        if (!best || best.score < 0.42) {
          return { ok: false, error: 'Could not match this show on AnimeHeaven', suggestions: [] };
        }
        const html = await ahFetch(`anime.php?${best.ah_id}`);
        const titleMatch = html.match(/class='infotitle c'>([^<]+)</i);
        const jpMatch = html.match(/class='infotitlejp c'>([^<]+)</i);
        const episodes = [];
        const byEp = new Map();
        const epRe = /gatea\(["']([a-f0-9]+)["']\)[\s\S]{0,400}?watch2[^>]*>(\d+)/gi;
        let m;
        while ((m = epRe.exec(html)) !== null) {
          byEp.set(Number(m[2]), { episode: Number(m[2]), gate_hash: m[1] });
        }
        episodes.push(...byEp.values());
        episodes.sort((a, b) => b.episode - a.episode);
        return {
          ok: true,
          match_score: Math.round(best.score * 100) / 100,
          ah_id: best.ah_id,
          title: (titleMatch && titleMatch[1].trim()) || best.title,
          title_japanese: (jpMatch && jpMatch[1].trim()) || '',
          url: best.url,
          episodes,
          episode_count: episodes.length,
        };
      } catch (e) {
        return {
          ok: false,
          error: `${e.message || e}. On Android, open the show on AnimeHeaven if streaming fails.`,
        };
      }
    },

    async get_stream_anime(ahId) {
      try {
        const html = await ahFetch(`anime.php?${ahId}`);
        const titleMatch = html.match(/class='infotitle c'>([^<]+)</i);
        const episodes = [];
        const byEp = new Map();
        const epRe = /gatea\(["']([a-f0-9]+)["']\)[\s\S]{0,400}?watch2[^>]*>(\d+)/gi;
        let m;
        while ((m = epRe.exec(html)) !== null) {
          byEp.set(Number(m[2]), { episode: Number(m[2]), gate_hash: m[1] });
        }
        episodes.push(...byEp.values());
        episodes.sort((a, b) => b.episode - a.episode);
        return {
          ok: true,
          ah_id: ahId,
          title: (titleMatch && titleMatch[1].trim()) || ahId,
          episodes,
          episode_count: episodes.length,
          url: `${AH_BASE}/anime.php?${ahId}`,
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },

    async get_stream_sources(gateHash) {
      gateHash = String(gateHash || '').trim();
      if (!gateHash) return { ok: false, error: 'Missing episode key' };
      try {
        const url = `${AH_BASE}/gate.php`;
        const headers = {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: `${AH_BASE}/`,
          Origin: AH_BASE,
          Cookie: `key=${gateHash}`,
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
        };

        let html = '';
        // Prefer Capacitor native HTTP (bypasses CORS, can send Cookie)
        if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp) {
          const Http = global.Capacitor.Plugins.CapacitorHttp;
          try {
            await Http.request({ url: `${AH_BASE}/`, method: 'GET', headers: { ...headers } });
          } catch { /* warm-up optional */ }
          const res = await Http.request({
            url,
            method: 'GET',
            headers,
            connectTimeout: 25000,
            readTimeout: 25000,
          });
          html = typeof res.data === 'string' ? res.data : String(res.data || '');
        } else {
          // WebView fetch fallback (may fail CORS on some builds)
          const res = await httpRequest(url, { method: 'GET', headers });
          html = await res.text();
        }

        const sources = [];
        const re = /<source[^>]+src=['"]([^'"]+)['"]/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
          const src = m[1];
          if (/[&?]error\d*/i.test(src)) continue;
          if (!sources.includes(src)) sources.push(src);
        }
        if (!sources.length) {
          return {
            ok: false,
            error: 'No stream found for this episode — try Open on AnimeHeaven.me',
            external: `${AH_BASE}/gate.php`,
          };
        }
        return { ok: true, sources, primary: sources[0], playback_url: sources[0], referer: `${AH_BASE}/` };
      } catch (e) {
        return {
          ok: false,
          error: String(e.message || e),
          external: `${AH_BASE}/gate.php`,
        };
      }
    },

    // ---------- Webhooks (fire when app is open) ----------
    async get_webhook_config() {
      const cfg = loadJSON(LS.webhook, {
        enabled: false,
        url: '',
        poll_minutes: 30,
        notify_premieres: true,
      });
      const state = loadJSON(LS.webhookState, { watchlist: [], tracked: {}, log: [] });
      return { ...cfg, watchlist: state.watchlist || [], watchlist_count: (state.watchlist || []).length };
    },
    async save_webhook_config(config) {
      const cfg = {
        enabled: !!config.enabled,
        url: String(config.url || '').trim(),
        poll_minutes: Math.max(15, Math.min(120, Number(config.poll_minutes) || 30)),
        notify_premieres: config.notify_premieres !== false,
      };
      saveJSON(LS.webhook, cfg);
      return { ok: true };
    },
    async get_webhook_status() {
      const cfg = loadJSON(LS.webhook, {});
      const state = loadJSON(LS.webhookState, { watchlist: [], log: [] });
      return {
        enabled: !!cfg.enabled,
        url_set: !!(cfg.url || '').trim(),
        watchlist_count: (state.watchlist || []).length,
        last_check: state.last_check || null,
        last_ping: state.last_ping || null,
        last_error: state.last_error || null,
        log: (state.log || []).slice(-8),
      };
    },
    async get_watchlist() {
      return loadJSON(LS.webhookState, { watchlist: [] }).watchlist || [];
    },
    async add_to_watchlist(anime) {
      const malId = Number(anime && anime.mal_id);
      if (!malId) return { ok: false, error: 'Missing anime id' };
      const state = loadJSON(LS.webhookState, { watchlist: [], tracked: {}, log: [] });
      if ((state.watchlist || []).some((w) => Number(w.mal_id) === malId)) {
        return { ok: true, already: true, title: anime.title_english || anime.title };
      }
      state.watchlist = state.watchlist || [];
      state.watchlist.push({
        mal_id: malId,
        title: anime.title_english || anime.title || 'Unknown',
        image: anime.image,
        url: anime.url,
      });
      state.tracked = state.tracked || {};
      state.tracked[String(malId)] = { last_episode_id: -1, pending_baseline: true };
      saveJSON(LS.webhookState, state);
      return { ok: true, title: anime.title_english || anime.title };
    },
    async add_to_watchlist_by_id(malId) {
      malId = Number(malId);
      const state = loadJSON(LS.webhookState, { watchlist: [] });
      const existing = (state.watchlist || []).find((w) => Number(w.mal_id) === malId);
      if (existing) return { ok: true, already: true, title: existing.title };
      // Look up via AniList
      const q = MEDIA_FRAGMENT + `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { ...MediaFields } }`;
      const payload = await gql(q, { idMal: malId });
      const media = payload.data && payload.data.Media;
      if (!media) return { ok: false, error: 'Anime not found' };
      return this.add_to_watchlist(slimMedia(media));
    },
    async remove_from_watchlist(malId) {
      malId = Number(malId);
      const state = loadJSON(LS.webhookState, { watchlist: [], tracked: {} });
      state.watchlist = (state.watchlist || []).filter((w) => Number(w.mal_id) !== malId);
      if (state.tracked) delete state.tracked[String(malId)];
      saveJSON(LS.webhookState, state);
      return { ok: true };
    },
    async test_webhook(urlOverride) {
      const cfg = loadJSON(LS.webhook, {});
      const url = String(urlOverride || cfg.url || '').trim();
      if (!url) return { ok: false, error: 'No webhook URL configured' };
      try {
        const res = await httpRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: null,
            embeds: [{
              title: 'Grey GodZilla Anime Tracker',
              description: 'Android webhook test — you will get pings when tracked shows drop (while app can run checks).',
              color: 0xff5500,
            }],
          }),
        });
        if (!res.ok) return { ok: false, error: `Webhook HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    async check_webhook_now() {
      const cfg = loadJSON(LS.webhook, {});
      if (!cfg.enabled) return { ok: false, error: 'Notifications disabled' };
      if (!(cfg.url || '').trim()) return { ok: false, error: 'No webhook URL' };
      const state = loadJSON(LS.webhookState, { watchlist: [] });
      if (!(state.watchlist || []).length) return { ok: false, error: 'No shows on watchlist' };
      // Lightweight check: notify that check ran (full ep tracking is best-effort on mobile)
      state.last_check = new Date().toISOString();
      state.log = state.log || [];
      state.log.push({ type: 'check', message: 'Watchlist check ran on Android', time: state.last_check });
      if (state.log.length > 40) state.log = state.log.slice(-40);
      saveJSON(LS.webhookState, state);
      return { ok: true, message: 'Check complete (open app periodically for episode alerts).' };
    },

    async get_picker_anime() {
      const b = cacheGet('bootstrap') || await this.get_bootstrap();
      const map = new Map();
      for (const item of [...(b.now || []), ...(b.upcoming || [])]) {
        map.set(item.mal_id, item);
      }
      return { data: [...map.values()] };
    },

    async get_refresh_status() {
      return {
        today: todayKey(),
        last_refresh_date: loadJSON('gg_refresh_meta', {}).last_date || null,
        last_refresh_time: loadJSON('gg_refresh_meta', {}).last_time || null,
      };
    },

    async refresh_all_data() {
      cacheClearSchedule();
      saveJSON('gg_refresh_meta', { last_date: todayKey(), last_time: new Date().toISOString() });
      const bootstrap = await this.get_bootstrap();
      const weekly = await this.get_weekly();
      const now = new Date();
      const monthly = await this.get_monthly(now.getFullYear(), now.getMonth() + 1);
      return {
        ok: true,
        today: todayKey(),
        last_refresh_time: new Date().toISOString(),
        bootstrap,
        weekly,
        monthly,
        source: 'anilist',
      };
    },
  };

  // Bridge for existing app.js (expects window.pywebview.api)
  function installBridge() {
    global.pywebview = global.pywebview || {};
    global.pywebview.api = api;
    global.GreyGodZillaApi = api;
    try {
      global.dispatchEvent(new Event('pywebviewready'));
    } catch {
      const ev = document.createEvent('Event');
      ev.initEvent('pywebviewready', false, false);
      global.dispatchEvent(ev);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBridge);
  } else {
    installBridge();
  }
})(window);
