/**
 * Grey GodZilla Anime Tracker — pure JS backend for Android / web.
 * Mirrors the Python pywebview API used by app.js.
 */
(function (global) {
  'use strict';

  const APP_NAME = 'Grey GodZilla Anime Tracker';
  const APP_VERSION = '1.6.2';
  const APP_PUBLISHER = 'Grey GodZilla';
  const ANILIST_URL = 'https://graphql.anilist.co';
  const AH_BASES = ['https://animeheaven.me', 'https://animeheaven.ru'];
  const AH_BASE = AH_BASES[0];
  // Free public reading catalog (manga / manhwa / webtoons / novels)
  const MD_API = 'https://api.mangadex.org';
  const MD_UA = 'GreyGodZillaAnimeApp/1.6.2 (free personal reader; github.com/GreyGodZilla59)';
  const AH_UA = 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
  const HTTP_TIMEOUT_MS = 25000;
  const GQL_MAX_ATTEMPTS = 4;
  const GQL_BASE_DELAY_MS = 450;
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
    notify: 'gg_notify_settings_v1',
  };

  const DEFAULT_NOTIFY = {
    enabled: true,
    // Minutes before drop (per media family)
    lead_anime: 30,
    lead_manga: 60,
    lead_manhwa: 60,
    lead_webtoon: 60,
    lead_manhua: 60,
    lead_novel: 60,
    lead_default: 30,
  };

  function getNotifySettings() {
    return { ...DEFAULT_NOTIFY, ...loadJSON(LS.notify, {}) };
  }

  function saveNotifySettings(partial) {
    const next = { ...getNotifySettings(), ...partial };
    saveJSON(LS.notify, next);
    return next;
  }

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
    if ((mediaType || item.type || '').toUpperCase() === 'ANIME') return 'anime';
    const country = (item.countryOfOrigin || '').toUpperCase();
    const fmt = (item.format || '').toUpperCase();
    if (fmt === 'NOVEL' || fmt === 'LIGHT_NOVEL') return 'novel';
    if (fmt === 'ONE_SHOT') return 'manga';
    // AniList stores manhwa + webtoons as MANGA with country KR
    if (country === 'KR' || fmt === 'MANHWA') return 'manhwa';
    if (country === 'CN' || fmt === 'MANHUA') return 'manhua';
    if (country === 'TW') return 'manhua';
    return 'manga';
  }

  function slimMedia(item) {
    try {
      if (!item || !item.id) return null;
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
      const family = mediaFamily(item, mediaType);
      const fmtLabel = formatLabel(item.format)
        || (mediaType === 'ANIME' ? 'TV' : (family === 'novel' ? 'Novel' : family === 'manhwa' ? 'Manhwa' : family === 'manhua' ? 'Manhua' : 'Manga'));
      return {
        mal_id: malId,
        anilist_id: anilistId,
        url: item.siteUrl || `https://anilist.co/${mediaType === 'ANIME' ? 'anime' : 'manga'}/${anilistId}`,
        title: title.romaji || title.english || title.native || 'Unknown',
        title_english: title.english || null,
        title_japanese: title.native || null,
        title_synonyms: item.synonyms || [],
        image: cover.extraLarge || cover.large || cover.medium || '',
        type: fmtLabel,
        episodes: item.episodes || null,
        chapters: item.chapters || null,
        volumes: item.volumes || null,
        status: statusLabel(item.status, mediaType),
        airing: item.status === 'RELEASING' && mediaType === 'ANIME',
        publishing: item.status === 'RELEASING' && mediaType !== 'ANIME',
        aired_from: isoFromFuzzy(item.startDate),
        aired_to: isoFromFuzzy(item.endDate),
        broadcast_day: broadcastDay,
        broadcast_time: broadcastTime,
        next_episode: nextEp.episode || null,
        next_airing_at: nextEp.airingAt || null,
        score: score ? Math.round((score / 10) * 100) / 100 : null,
        rank: null,
        popularity: item.popularity || 0,
        genres: item.genres || [],
        studios: studios.slice(0, 2),
        synopsis: stripHtml(item.description),
        media: family,
        country: item.countryOfOrigin || null,
        season: item.season ? item.season.charAt(0) + item.season.slice(1).toLowerCase() : null,
        season_year: item.seasonYear || null,
        source: 'anilist',
      };
    } catch {
      return null;
    }
  }

  // ---------- HTTP (Capacitor native when available — bypasses CORS) ----------
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function httpRequestOnce(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const body = options.body;
    const timeoutMs = Number(options.timeoutMs) || HTTP_TIMEOUT_MS;

    // Capacitor 5+ CapacitorHttp (native stack — more stable on mobile than WebView fetch)
    if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp) {
      const Http = global.Capacitor.Plugins.CapacitorHttp;
      const res = await Http.request({
        url,
        method,
        headers,
        data: body ? (typeof body === 'string' ? JSON.parse(body) : body) : undefined,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        text: async () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)),
        json: async () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data),
      };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        signal: controller ? controller.signal : undefined,
      });
      return res;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function httpRequest(url, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 1);
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const res = await httpRequestOnce(url, options);
        if (res.ok || !isRetryableStatus(res.status) || i === attempts - 1) return res;
        // Retry rate-limits / transient server errors
        const delay = GQL_BASE_DELAY_MS * (2 ** i) + Math.floor(Math.random() * 200);
        await sleep(delay);
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) throw err;
        const delay = GQL_BASE_DELAY_MS * (2 ** i) + Math.floor(Math.random() * 250);
        await sleep(delay);
      }
    }
    if (lastErr) throw lastErr;
    throw new Error('http_request_failed');
  }

  async function gql(query, variables = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < GQL_MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await httpRequest(ANILIST_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          attempts: 1,
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        if (!res.ok) {
          lastError = `anilist_http_${res.status}`;
          if (isRetryableStatus(res.status) && attempt < GQL_MAX_ATTEMPTS - 1) {
            await sleep(GQL_BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 300));
            continue;
          }
          return { data: null, error: lastError };
        }
        const json = await res.json();
        if (json.errors && json.errors.length) {
          const msg = json.errors[0].message || 'GraphQL error';
          // Partial data can still be usable (e.g. one field failed)
          if (json.data) return { data: json.data, error: msg };
          lastError = msg;
          if (/too many requests|rate.?limit|timeout|temporar/i.test(msg) && attempt < GQL_MAX_ATTEMPTS - 1) {
            await sleep(GQL_BASE_DELAY_MS * (2 ** attempt) + 400);
            continue;
          }
          return { data: null, error: lastError };
        }
        return { data: json.data, error: null };
      } catch (err) {
        lastError = String(err && err.message ? err.message : err);
        if (attempt < GQL_MAX_ATTEMPTS - 1) {
          await sleep(GQL_BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * 350));
          continue;
        }
      }
    }
    return { data: null, error: lastError || 'anilist_unreachable' };
  }

  // ---------- Memory + disk cache (fresh + stale-while-revalidate) ----------
  const memCache = new Map();
  const CACHE_TTL = 45 * 60 * 1000; // prefer fresh for 45m
  const CACHE_STALE_TTL = 7 * 24 * 60 * 60 * 1000; // keep usable offline for 7 days

  function cacheEntryGet(key) {
    const hit = memCache.get(key);
    if (hit) return hit;
    const disk = loadJSON(LS.cache, {});
    const entry = disk[key];
    if (entry && entry.data != null) {
      memCache.set(key, entry);
      return entry;
    }
    return null;
  }

  function cacheGet(key) {
    const entry = cacheEntryGet(key);
    if (entry && Date.now() - (entry.ts || 0) < CACHE_TTL) return entry.data;
    return null;
  }

  /** Return cached payload even if expired (for offline / flaky AniList). */
  function cacheGetStale(key) {
    const entry = cacheEntryGet(key);
    if (!entry || entry.data == null) return null;
    if (Date.now() - (entry.ts || 0) > CACHE_STALE_TTL) return null;
    return entry.data;
  }

  function cacheSet(key, data) {
    const entry = { data, ts: Date.now() };
    memCache.set(key, entry);
    const disk = loadJSON(LS.cache, {});
    disk[key] = entry;
    // cap size
    const keys = Object.keys(disk);
    if (keys.length > 50) {
      keys.sort((a, b) => (disk[a].ts || 0) - (disk[b].ts || 0));
      keys.slice(0, keys.length - 40).forEach((k) => delete disk[k]);
    }
    saveJSON(LS.cache, disk);
  }

  function withStaleFallback(key, live, error) {
    const stale = cacheGetStale(key);
    if (stale) {
      return {
        ...stale,
        error: error || live?.error || 'stale_cache',
        offline: true,
        stale: true,
        source: stale.source || 'anilist-cache',
      };
    }
    return live;
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
  function localDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function localDayBounds(date = new Date()) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return { dayStart, dayEnd, key: localDayKey(dayStart) };
  }

  function isAiringOnLocalDay(airingAtSec, dayStart, dayEnd) {
    if (!airingAtSec) return false;
    const ms = Number(airingAtSec) * 1000;
    return ms >= dayStart.getTime() && ms < dayEnd.getTime();
  }

  async function airingSchedule(fromTs, toTs, pages = 6) {
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
        if (!slim) continue;
        if (row.airingAt) {
          const dt = new Date(row.airingAt * 1000);
          slim.airing_at = row.airingAt;
          slim.next_episode = row.episode;
          slim.next_airing_at = row.airingAt;
          // Local device timezone — this is what "Today" means for the user
          slim.broadcast_day = dt.toLocaleDateString('en-US', { weekday: 'long' });
          slim.broadcast_time = dt.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          slim.airing_local_date = localDayKey(dt);
        }
        results.push(slim);
      }
      if (!(payload.data && payload.data.Page && payload.data.Page.pageInfo && payload.data.Page.pageInfo.hasNextPage)) break;
      // Soft pacing between pages so AniList is less likely to 429
      if (page < pages) await sleep(120);
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
    return { favorites: [], history: [], progress: {}, read_progress: {} };
  }

  function getLibrary() {
    const lib = loadJSON(LS.library, defaultLibrary());
    if (!Array.isArray(lib.favorites)) lib.favorites = [];
    if (!Array.isArray(lib.history)) lib.history = [];
    if (!lib.progress || typeof lib.progress !== 'object') lib.progress = {};
    if (!lib.read_progress || typeof lib.read_progress !== 'object') lib.read_progress = {};
    return lib;
  }

  async function mdGet(path, params) {
    let url = path.startsWith('http') ? path : `${MD_API}${path.startsWith('/') ? path : `/${path}`}`;
    if (params && typeof params === 'object') {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v == null || v === '') return;
        if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)));
        else qs.append(k, String(v));
      });
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const res = await httpRequest(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': MD_UA,
      },
      attempts: 3,
      timeoutMs: 28000,
    });
    if (!res.ok) throw new Error(`MangaDex HTTP ${res.status}`);
    return res.json();
  }

  function mdTitle(attributes) {
    const t = (attributes && attributes.title) || {};
    return t.en || t['ja-ro'] || t.ja || Object.values(t)[0] || 'Unknown';
  }

  function mdAltTitles(attributes) {
    const out = [];
    const t = (attributes && attributes.title) || {};
    Object.values(t).forEach((v) => { if (v) out.push(String(v)); });
    for (const row of (attributes && attributes.altTitles) || []) {
      Object.values(row || {}).forEach((v) => { if (v) out.push(String(v)); });
    }
    return [...new Set(out)];
  }

  function mdCoverUrl(mangaId, relationships) {
    const cover = (relationships || []).find((r) => r && r.type === 'cover_art');
    const file = cover && cover.attributes && cover.attributes.fileName;
    if (!mangaId || !file) return '';
    return `https://uploads.mangadex.org/covers/${mangaId}/${file}.256.jpg`;
  }

  function mdTags(attributes) {
    return ((attributes && attributes.tags) || [])
      .map((t) => (t && t.attributes && t.attributes.name && (t.attributes.name.en || Object.values(t.attributes.name)[0])) || '')
      .filter(Boolean)
      .slice(0, 8);
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
      next_episode: item.next_episode || null,
      next_airing_at: item.next_airing_at || null,
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
    if (q === c) return 1.0;
    // Exact after stripping season noise
    const stripNoise = (s) => s
      .replace(/\b(tv|ova|ona|movie|special|dub|sub|uncut|hd)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripNoise(q) === stripNoise(c)) return 0.98;
    // "Naruto" should beat "Naruto Shippuden" when query is just Naruto
    if (c.startsWith(`${q} `) || c.endsWith(` ${q}`)) {
      const extra = c.length - q.length;
      return Math.max(0.72, 0.9 - extra * 0.01);
    }
    if (q.startsWith(`${c} `)) return 0.9;
    if (c.includes(q) || q.includes(c)) {
      const longer = Math.max(q.length, c.length);
      const shorter = Math.min(q.length, c.length);
      return 0.7 + (shorter / longer) * 0.2;
    }
    const qw = q.split(' ').filter(Boolean);
    const cw = new Set(c.split(' ').filter(Boolean));
    let overlap = 0;
    qw.forEach((w) => { if (cw.has(w)) overlap += 1; });
    if (!overlap) return 0;
    return (overlap / Math.max(qw.length, cw.size || 1)) * 0.82;
  }

  function isPlayableMediaUrl(u) {
    const s = String(u || '');
    if (!s || /[&?]error\d*/i.test(s)) return false;
    if (/anime\.php|gate\.php|mangadex\.org/i.test(s) && !/video\.mp4/i.test(s)) return false;
    return /video\.mp4|\.mp4(\?|$)|\.m3u8(\?|$)|\.webm(\?|$)/i.test(s);
  }

  function rankStreamUrl(u) {
    // Prefer working co.* CDN mirrors first
    if (/\/\/co\./i.test(u)) return 0;
    if (/\/\/c[a-z]\./i.test(u) && !/error/i.test(u)) return 1;
    if (/\.m3u8/i.test(u)) return 2;
    return 3;
  }

  async function ahFetch(path, params, baseOverride) {
    const bases = baseOverride ? [baseOverride] : AH_BASES.slice();
    let lastErr = null;
    for (const base of bases) {
      try {
        let url = path.startsWith('http') ? path : `${base}/${String(path).replace(/^\//, '')}`;
        if (params) {
          const qs = new URLSearchParams(params).toString();
          url += (url.includes('?') ? '&' : '?') + qs;
        }
        const res = await httpRequest(url, {
          method: 'GET',
          headers: {
            Accept: 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${base}/`,
            Origin: base,
            'User-Agent': AH_UA,
          },
          attempts: 2,
          timeoutMs: 28000,
        });
        if (!res.ok) {
          lastErr = new Error(`AnimeHeaven HTTP ${res.status}`);
          continue;
        }
        const text = await res.text();
        if (text && text.length > 40) return { html: text, base };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('AnimeHeaven unreachable');
  }

  function parseFastSearch(html, base = AH_BASE) {
    const results = [];
    const seen = new Set();
    const patterns = [
      /href=['"]\/anime\.php\?([a-z0-9]+)['"][\s\S]*?alt=['"]([^'"]*)['"][\s\S]*?class=['"]fastname['"]>([^<]+)/gi,
      /href=['"]\/anime\.php\?([a-z0-9]+)['"][\s\S]*?class=['"]fastname['"]>([^<]+)/gi,
      /anime\.php\?([a-z0-9]+)[^>]*>[\s\S]*?fastname['"]?>([^<]+)/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        const title = (m[3] || m[2] || '').trim();
        if (!title) continue;
        results.push({
          ah_id: id,
          title,
          url: `${base}/anime.php?${id}`,
        });
      }
      if (results.length) break;
    }
    return results;
  }

  function parseEpisodes(html) {
    const byEp = new Map();
    const patterns = [
      // gatea("hash") ... watch2 ... >N
      /gatea\(["']([a-f0-9]+)["']\)[\s\S]{0,800}?watch2[^>]*>\s*(\d+)/gi,
      // id="hash" ... watch2 ... >N
      /\bid=["']([a-f0-9]{16,})["'][\s\S]{0,800}?watch2[^>]*>\s*(\d+)/gi,
      // gatea then Episode then number nearby
      /gatea\(["']([a-f0-9]+)["']\)[\s\S]{0,500}?Episode[\s\S]{0,80}?>\s*(\d+)/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html)) !== null) {
        const hash = m[1];
        const ep = Number(m[2]);
        if (!hash || !ep) continue;
        if (!byEp.has(ep)) byEp.set(ep, { episode: ep, gate_hash: hash });
      }
    }
    const episodes = [...byEp.values()];
    episodes.sort((a, b) => b.episode - a.episode);
    return episodes;
  }

  function extractStreamSources(html) {
    const sources = [];
    const push = (raw) => {
      if (!raw) return;
      let src = String(raw).trim().replace(/&amp;/g, '&');
      // strip accidental trailing quotes/junk from bad parses
      src = src.replace(/['"<>].*$/, '').trim();
      if (!isPlayableMediaUrl(src)) return;
      if (!sources.includes(src)) sources.push(src);
    };
    let m;
    const reSource = /<source[^>]+src=['"]([^'"]+)['"]/gi;
    while ((m = reSource.exec(html)) !== null) push(m[1]);
    const reVideo = /https?:\/\/[a-z0-9.-]*animeheaven\.[a-z.]+\/video\.mp4\?[a-z0-9&._=-]+/gi;
    while ((m = reVideo.exec(html)) !== null) push(m[0]);
    const reAnyMp4 = /https?:\/\/[^'"\s<>]+video\.mp4\?[^'"\s<>]+/gi;
    while ((m = reAnyMp4.exec(html)) !== null) push(m[0]);
    sources.sort((a, b) => rankStreamUrl(a) - rankStreamUrl(b));
    return sources;
  }

  // ---------- Main API object ----------
  const api = {
    async get_app_info() {
      return {
        name: APP_NAME,
        display_name: 'Grey GodZilla Anime App',
        launcher_name: 'GGZ Anime',
        version: APP_VERSION,
        publisher: APP_PUBLISHER,
        title: `Grey GodZilla Anime App v${APP_VERSION}`,
        platform: 'android',
      };
    },

    async get_notify_settings() {
      return getNotifySettings();
    },
    async save_notify_settings(cfg) {
      const cleaned = {
        enabled: !!(cfg && cfg.enabled),
        lead_anime: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_anime) || 30)),
        lead_manga: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_manga) || 60)),
        lead_manhwa: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_manhwa) || 60)),
        lead_webtoon: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_webtoon) || 60)),
        lead_manhua: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_manhua) || 60)),
        lead_novel: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_novel) || 60)),
        lead_default: Math.max(1, Math.min(24 * 60, Number(cfg?.lead_default) || 30)),
      };
      return { ok: true, settings: saveNotifySettings(cleaned) };
    },

    leadMinutesForMedia(media) {
      const s = getNotifySettings();
      const m = String(media || 'anime').toLowerCase();
      if (m === 'anime') return s.lead_anime;
      if (m === 'manga') return s.lead_manga;
      if (m === 'manhwa') return s.lead_manhwa;
      if (m === 'webtoon') return s.lead_webtoon;
      if (m === 'manhua') return s.lead_manhua;
      if (m === 'novel') return s.lead_novel;
      return s.lead_default;
    },

    async get_bootstrap(force = false) {
      const { dayStart, dayEnd, key: dayKey } = localDayBounds(new Date());
      const cacheKey = `bootstrap:${dayKey}`;
      if (!force) {
        const cached = cacheGet(cacheKey);
        // Only reuse cache if it actually has today's list (or a real error snapshot)
        if (cached && Array.isArray(cached.today) && (cached.today.length || cached.error)) {
          return cached;
        }
      }
      try {
        const now = new Date();
        const season = SEASON_BY_MONTH[now.getMonth() + 1];
        const next = NEXT_SEASON[season];
        const nextYear = season === 'FALL' ? now.getFullYear() + 1 : now.getFullYear();

        // Pull a wider AniList window, then STRICT-filter to local calendar day.
        // This stops "week junk" and yesterday/tomorrow bleed from showing under Today.
        const fromTs = Math.floor(dayStart.getTime() / 1000) - 6 * 3600;
        const toTs = Math.floor(dayEnd.getTime() / 1000) + 6 * 3600;

        // Fetch today airings first (most important), then season lists
        const todayPayload = await airingSchedule(fromTs, toTs, 8);
        const [nowPayload, upPayload] = await Promise.all([
          collectSeason(season, now.getFullYear(), 2),
          collectSeason(next, nextYear, 1),
        ]);

        const seen = new Map();
        for (const item of todayPayload.data || []) {
          if (!isAiringOnLocalDay(item.airing_at, dayStart, dayEnd)) continue;
          const key = `${item.mal_id || item.anilist_id}:${item.next_episode || ''}`;
          if (!seen.has(key)) seen.set(key, item);
        }
        const today = [...seen.values()].sort((a, b) =>
          (a.airing_at || 0) - (b.airing_at || 0)
          || String(a.broadcast_time || '99').localeCompare(String(b.broadcast_time || '99')),
        );

        const result = {
          now: (nowPayload.data || []).filter(Boolean),
          upcoming: (upPayload.data || []).filter(Boolean),
          today,
          today_name: DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1],
          today_key: dayKey,
          day_start: dayStart.toISOString(),
          day_end: dayEnd.toISOString(),
          error: todayPayload.error || nowPayload.error || upPayload.error || null,
          source: 'anilist',
          last_refreshed: new Date().toISOString(),
        };
        const hasData = today.length || result.now.length || result.upcoming.length;
        if (!hasData && result.error) {
          return withStaleFallback(cacheKey, result, result.error);
        }
        cacheSet(cacheKey, result);
        // Also keep a short alias for older callers
        cacheSet('bootstrap', result);
        return result;
      } catch (err) {
        return withStaleFallback(cacheKey, {
          now: [], upcoming: [], today: [], today_name: '', today_key: dayKey,
          error: String(err.message || err), source: 'anilist',
        }, String(err.message || err));
      }
    },

    async get_weekly(force = false) {
      const now = new Date();
      const start = new Date(now);
      const day = (start.getDay() + 6) % 7; // mon=0
      start.setDate(start.getDate() - day);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const weekKey = `weekly:${localDayKey(start)}`;
      if (!force) {
        const cached = cacheGet(weekKey) || cacheGet('weekly');
        if (cached && cached.schedule && cached.week_start === localDayKey(start)) {
          return cached;
        }
      }
      try {
        const payload = await airingRange(start.getTime(), end.getTime(), 3, 6);
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
            airing_local_date: localDayKey(dt),
          });
        }
        for (const d of DAYS) {
          schedule[d].sort((a, b) => (a.airing_at || 0) - (b.airing_at || 0)
            || String(a.broadcast_time || '').localeCompare(String(b.broadcast_time || '')));
        }
        const total = DAYS.reduce((n, d) => n + schedule[d].length, 0);
        const result = {
          schedule,
          week_start: localDayKey(start),
          week_end: localDayKey(new Date(end.getTime() - 1000)),
          total,
          error: payload.error,
          source: 'anilist',
          last_refreshed: new Date().toISOString(),
        };
        if (!total && payload.error) {
          return withStaleFallback(weekKey, result, payload.error);
        }
        cacheSet(weekKey, result);
        cacheSet('weekly', result);
        return result;
      } catch (err) {
        return withStaleFallback(weekKey, {
          schedule: Object.fromEntries(DAYS.map((d) => [d, []])),
          total: 0,
          error: String(err.message || err),
          source: 'anilist',
        }, String(err.message || err));
      }
    },

    async get_monthly(year, month) {
      const now = new Date();
      year = Number(year || now.getFullYear());
      month = Number(month || now.getMonth() + 1);
      const key = `monthly:${year}-${String(month).padStart(2, '0')}`;
      const cached = cacheGet(key);
      if (cached) return cached;

      try {
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
        if (!releaseCount && !premieres.length && airingPayload.error) {
          return withStaleFallback(key, result, airingPayload.error);
        }
        cacheSet(key, result);
        return result;
      } catch (err) {
        return withStaleFallback(key, {
          year, month, month_name: MONTH_NAMES[month], premieres: [], ongoing: [],
          starting_soon: [], premiere_by_day: {}, releases_by_day: {}, release_count: 0,
          error: String(err.message || err), source: 'anilist',
        }, String(err.message || err));
      }
    },

    async get_yearly(year) {
      year = Number(year || new Date().getFullYear());
      const key = `yearly:${year}`;
      const cached = cacheGet(key);
      if (cached) return cached;
      try {
        const combined = new Map();
        let lastErr = null;
        for (const q of ['WINTER', 'SPRING', 'SUMMER', 'FALL']) {
          const payload = await collectSeason(q, year, 2);
          if (payload.error) lastErr = payload.error;
          for (const item of payload.data || []) {
            combined.set(item.mal_id || item.anilist_id, item);
          }
        }
        if (!combined.size && lastErr) {
          return withStaleFallback(key, {
            year, total: 0, premieres: [], announced_tba: [], airing: [], finished: [],
            by_month: {}, by_quarter: { winter: [], spring: [], summer: [], fall: [] },
            month_names: MONTH_NAMES, error: lastErr, source: 'anilist',
          }, lastErr);
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
          error: lastErr,
        };
        cacheSet(key, result);
        return result;
      } catch (err) {
        return withStaleFallback(key, {
          year, total: 0, premieres: [], announced_tba: [], airing: [], finished: [],
          by_month: {}, by_quarter: { winter: [], spring: [], summer: [], fall: [] },
          month_names: MONTH_NAMES, error: String(err.message || err), source: 'anilist',
        }, String(err.message || err));
      }
    },

    /**
     * Core AniList page search.
     * Builds GraphQL with ONLY the filters we actually set — null enums make AniList return empty.
     */
    async _anilistSearchPage({
      search,
      mediaType, // 'ANIME' | 'MANGA'
      perPage = 25,
      format = null,
      status = null,
      country = null,
      orderBy = 'popularity',
    }) {
      const sortSecondary =
        orderBy === 'score' ? 'SCORE_DESC'
          : orderBy === 'title' ? 'TITLE_ROMAJI'
            : orderBy === 'start_date' ? 'START_DATE_DESC'
              : 'POPULARITY_DESC';
      const sortList = ['SEARCH_MATCH', sortSecondary];

      const varDecls = [
        '$search: String',
        '$type: MediaType',
        '$perPage: Int',
        '$sort: [MediaSort]',
        '$isAdult: Boolean',
      ];
      const argList = [
        'search: $search',
        'type: $type',
        'sort: $sort',
        'isAdult: $isAdult',
      ];
      const variables = {
        search,
        type: mediaType,
        perPage: Math.min(50, Math.max(1, Number(perPage) || 25)),
        sort: sortList,
        isAdult: false,
      };
      if (format) {
        varDecls.push('$format: MediaFormat');
        argList.push('format: $format');
        variables.format = format;
      }
      if (status) {
        varDecls.push('$status: MediaStatus');
        argList.push('status: $status');
        variables.status = status;
      }
      if (country) {
        varDecls.push('$countryOfOrigin: CountryCode');
        argList.push('countryOfOrigin: $countryOfOrigin');
        variables.countryOfOrigin = country;
      }

      // Full fragment first
      let queryGql = MEDIA_FRAGMENT + `
        query (${varDecls.join(', ')}) {
          Page(page: 1, perPage: $perPage) {
            media(${argList.join(', ')}) { ...MediaFields }
          }
        }`;
      let payload = await gql(queryGql, variables);
      let rows = (payload.data && payload.data.Page && payload.data.Page.media) || [];

      // Lightweight fallback query (fewer fields) if fragment/staff blows up
      if ((!rows.length) && payload.error) {
        const light = `
          query (${varDecls.join(', ')}) {
            Page(page: 1, perPage: $perPage) {
              media(${argList.join(', ')}) {
                id idMal type format status episodes chapters volumes averageScore popularity
                genres description(asHtml: false) siteUrl isAdult countryOfOrigin
                startDate { year month day } endDate { year month day }
                title { romaji english native } synonyms
                coverImage { large extraLarge medium }
              }
            }
          }`;
        payload = await gql(light, variables);
        rows = (payload.data && payload.data.Page && payload.data.Page.media) || [];
      }

      const data = rows.map(slimMedia).filter(Boolean);
      return { data, error: data.length ? null : (payload.error || null) };
    },

    async _searchOneBucket(query, bucket, limit, type, status, orderBy, minScore) {
      // bucket: anime | manga | manhwa | webtoon | manhua | novel
      const typeKey = String(type || '').toLowerCase();
      const statusKey = String(status || '').toLowerCase();
      const statusMap = {
        airing: 'RELEASING',
        publishing: 'RELEASING',
        complete: 'FINISHED',
        finished: 'FINISHED',
        upcoming: 'NOT_YET_RELEASED',
      };
      let statusFilter = statusMap[statusKey] || null;
      if (statusKey === 'any' || statusKey === '') statusFilter = null;

      let mediaType = 'MANGA';
      let format = null;
      let country = null;

      if (bucket === 'anime') {
        mediaType = 'ANIME';
        const map = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL' };
        if (map[typeKey]) format = map[typeKey];
      } else if (bucket === 'manhwa' || bucket === 'webtoon') {
        country = 'KR';
        if (typeKey === 'novel' || typeKey === 'lightnovel') format = 'NOVEL';
        else if (typeKey === 'one_shot' || typeKey === 'oneshot') format = 'ONE_SHOT';
      } else if (bucket === 'manhua') {
        country = 'CN';
        if (typeKey === 'novel' || typeKey === 'lightnovel') format = 'NOVEL';
      } else if (bucket === 'novel' || bucket === 'book' || bucket === 'books' || bucket === 'lightnovel') {
        format = 'NOVEL';
      } else {
        // manga / books umbrella — do NOT force format=MANGA (that hides novels)
        if (typeKey === 'manhwa' || typeKey === 'webtoon') country = 'KR';
        else if (typeKey === 'manhua') country = 'CN';
        else if (typeKey === 'novel' || typeKey === 'lightnovel') format = 'NOVEL';
        else if (typeKey === 'one_shot' || typeKey === 'oneshot') format = 'ONE_SHOT';
        else if (typeKey === 'manga') format = 'MANGA';
      }

      const perPage = Math.min(50, Math.max(8, Number(limit) || 25));
      let result = await this._anilistSearchPage({
        search: query,
        mediaType,
        perPage,
        format,
        status: statusFilter,
        country,
        orderBy,
      });

      // Loosen filters if empty (keep media type; drop format/status; keep country for KR/CN specialty)
      if (!result.data.length && (format || statusFilter)) {
        const loose = await this._anilistSearchPage({
          search: query,
          mediaType,
          perPage,
          format: null,
          status: null,
          country,
          orderBy,
        });
        if (loose.data.length) result = loose;
      }

      // For specialty country searches that still fail, drop country as last resort
      if (!result.data.length && country) {
        const open = await this._anilistSearchPage({
          search: query,
          mediaType,
          perPage,
          format: null,
          status: null,
          country: null,
          orderBy,
        });
        if (open.data.length) {
          // Prefer matching country when present, else keep all print results
          const preferred = open.data.filter((d) => {
            const c = (d.country || '').toUpperCase();
            if (country === 'KR') return c === 'KR' || d.media === 'manhwa';
            if (country === 'CN') return c === 'CN' || c === 'TW' || d.media === 'manhua';
            return true;
          });
          result = { data: preferred.length ? preferred : open.data, error: null };
        } else if (open.error) {
          result = open;
        }
      }

      let data = result.data || [];
      // Client-side family filter for webtoon label (same AniList bucket as manhwa)
      if (bucket === 'webtoon') {
        const kr = data.filter((d) => (d.country || '').toUpperCase() === 'KR' || d.media === 'manhwa');
        if (kr.length) data = kr;
      }
      if (bucket === 'novel' || bucket === 'book' || bucket === 'books') {
        const novels = data.filter((d) => d.media === 'novel' || /novel/i.test(d.type || ''));
        if (novels.length) data = novels;
      }

      const minS = Number(minScore) || 0;
      if (minS > 0) data = data.filter((d) => (d.score || 0) >= minS);

      return {
        data,
        error: data.length ? null : (result.error || null),
        query,
        media: bucket,
        source: 'anilist',
      };
    },

    async search_media(query, media = 'all', limit = 24, type = '', status = '', orderBy = 'popularity', sort = 'desc', minScore = 0) {
      try {
        query = String(query || '').trim();
        media = String(media || 'all').toLowerCase();
        if (['any', 'everything', '*', 'all media'].includes(media)) media = 'all';
        if (['book', 'books', 'lightnovel', 'light novel', 'ln'].includes(media)) media = 'novel';
        if (query.length < 2) return { data: [], query, media, source: 'anilist' };

        const cacheKey = `search_v2:${media}:${query}:${type || ''}:${status || ''}:${orderBy}:${limit}:${minScore || 0}`;
        const cached = cacheGet(cacheKey);
        if (cached && Array.isArray(cached.data) && cached.data.length) return cached;

        const cap = Math.min(50, Math.max(1, Number(limit) || 30));

        // ALL MEDIA: anime + manga-family (manga, manhwa, webtoon, manhua, novels)
        if (media === 'all') {
          const half = Math.max(12, Math.min(30, Math.ceil(cap / 2) + 4));
          const typeKey = String(type || '').toLowerCase();
          const animeType = ['tv', 'movie', 'ova', 'ona', 'special'].includes(typeKey) ? typeKey : '';
          const printType = ['manga', 'manhwa', 'manhua', 'webtoon', 'novel', 'one_shot', 'lightnovel', 'oneshot'].includes(typeKey)
            ? typeKey
            : '';

          const tasks = [
            this._searchOneBucket(query, 'anime', half, animeType, status, orderBy, minScore),
            this._searchOneBucket(query, 'manga', half, printType, status, orderBy, minScore),
          ];
          // Extra KR pass when user asked for webtoon/manhwa OR unrestricted "all"
          if (!printType || printType === 'manhwa' || printType === 'webtoon') {
            tasks.push(this._searchOneBucket(query, 'manhwa', Math.min(15, half), '', status, orderBy, minScore));
          }
          if (!printType || printType === 'novel' || printType === 'lightnovel') {
            tasks.push(this._searchOneBucket(query, 'novel', Math.min(12, half), '', status, orderBy, minScore));
          }

          const settled = await Promise.allSettled(tasks);
          const merged = [];
          const seen = new Set();
          let lastErr = null;
          for (const s of settled) {
            if (s.status !== 'fulfilled') {
              lastErr = String(s.reason && s.reason.message ? s.reason.message : s.reason);
              continue;
            }
            const res = s.value || {};
            if (res.error && !(res.data && res.data.length)) lastErr = res.error;
            for (const item of res.data || []) {
              const key = item.anilist_id || item.mal_id || item.title;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(item);
            }
          }
          merged.sort((a, b) =>
            (b.score || 0) - (a.score || 0) || (b.popularity || 0) - (a.popularity || 0),
          );
          const result = {
            data: merged.slice(0, cap),
            query,
            media: 'all',
            source: 'anilist',
            error: merged.length ? null : lastErr,
          };
          if (result.data.length) cacheSet(cacheKey, result);
          else {
            const stale = cacheGetStale(cacheKey);
            if (stale && stale.data && stale.data.length) {
              return { ...stale, stale: true, error: result.error || 'stale_cache' };
            }
          }
          return result;
        }

        // Single family
        const bucket = media === 'webtoon' ? 'webtoon'
          : media === 'manhwa' ? 'manhwa'
            : media === 'manhua' ? 'manhua'
              : media === 'novel' ? 'novel'
                : media === 'anime' ? 'anime'
                  : 'manga';
        const result = await this._searchOneBucket(query, bucket, cap, type, status, orderBy, minScore);
        result.media = media;
        if (result.data.length) cacheSet(cacheKey, result);
        else {
          const stale = cacheGetStale(cacheKey);
          if (stale && stale.data && stale.data.length) {
            return { ...stale, stale: true, error: result.error || 'stale_cache' };
          }
        }
        return result;
      } catch (err) {
        return {
          data: [],
          query: String(query || ''),
          media: String(media || 'all'),
          source: 'anilist',
          error: String(err && err.message ? err.message : err),
        };
      }
    },

    async search_anime(query, limit = 24, type, status, orderBy, sort, minScore) {
      return this.search_media(query, 'anime', limit, type, status, orderBy, sort, minScore);
    },
    async search_manga(query, limit = 24, type, status, orderBy, sort, minScore) {
      // Accept manhwa/webtoon/novel as the "type" shortcut
      const t = String(type || 'manga').toLowerCase();
      if (['manhwa', 'webtoon', 'manhua', 'novel'].includes(t)) {
        return this.search_media(query, t, limit, '', status, orderBy, sort, minScore);
      }
      return this.search_media(query, 'manga', limit, type, status, orderBy, sort, minScore);
    },
    async search(query, media = 'all', limit = 24) {
      return this.search_media(query, media || 'all', limit);
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
        const { html, base } = await ahFetch('fastsearch.php', { xhr: '1', s: query });
        return { data: parseFastSearch(html, base).slice(0, limit), base };
      } catch (e) {
        return { data: [], error: String(e.message || e) };
      }
    },

    async resolve_stream(malId, titles) {
      const titleList = (titles || []).map((t) => String(t || '').trim()).filter(Boolean);
      if (!titleList.length) return { ok: false, error: 'No title to search for streaming' };
      try {
        const candidates = [];
        const seenIds = new Set();
        // Prefer shorter English titles first (better exact matches like "Naruto")
        const ordered = [...titleList].sort((a, b) => a.length - b.length);
        for (const t of ordered.slice(0, 6)) {
          const hits = await this.search_stream(t, 15);
          for (const hit of hits.data || []) {
            if (seenIds.has(hit.ah_id)) continue;
            seenIds.add(hit.ah_id);
            const score = Math.max(...titleList.map((x) => scoreMatch(x, hit.title)));
            candidates.push({ ...hit, score, base: hits.base || AH_BASE });
          }
        }
        candidates.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
        const best = candidates[0];
        if (!best || best.score < 0.42) {
          return {
            ok: false,
            error: 'Could not match this show for streaming. Try a shorter English title.',
            suggestions: candidates.slice(0, 6),
          };
        }

        // Try best match; if it has no episodes, try next suggestions
        let chosen = null;
        let pageHtml = '';
        let pageBase = best.base || AH_BASE;
        for (const cand of candidates.slice(0, 5)) {
          try {
            const page = await ahFetch(`anime.php?${cand.ah_id}`, null, cand.base || AH_BASE);
            const eps = parseEpisodes(page.html);
            if (eps.length) {
              chosen = cand;
              pageHtml = page.html;
              pageBase = page.base;
              chosen.episodes = eps;
              break;
            }
          } catch { /* try next */ }
        }
        if (!chosen) {
          return {
            ok: false,
            error: 'Matched a title but found no playable episodes.',
            suggestions: candidates.slice(0, 6),
          };
        }

        const titleMatch = pageHtml.match(/class=['"]infotitle[^'"]*['"]>([^<]+)/i);
        const jpMatch = pageHtml.match(/class=['"]infotitlejp[^'"]*['"]>([^<]+)/i);
        return {
          ok: true,
          match_score: Math.round(chosen.score * 100) / 100,
          ah_id: chosen.ah_id,
          title: (titleMatch && titleMatch[1].trim()) || chosen.title,
          title_japanese: (jpMatch && jpMatch[1].trim()) || '',
          url: `${pageBase}/anime.php?${chosen.ah_id}`,
          base: pageBase,
          episodes: chosen.episodes,
          episode_count: chosen.episodes.length,
          suggestions: candidates.slice(0, 6).filter((c) => c.ah_id !== chosen.ah_id),
        };
      } catch (e) {
        return {
          ok: false,
          error: String(e.message || e),
        };
      }
    },

    async get_stream_anime(ahId, base) {
      try {
        const page = await ahFetch(`anime.php?${ahId}`, null, base || AH_BASE);
        const titleMatch = page.html.match(/class=['"]infotitle[^'"]*['"]>([^<]+)/i);
        const episodes = parseEpisodes(page.html);
        return {
          ok: true,
          ah_id: ahId,
          title: (titleMatch && titleMatch[1].trim()) || ahId,
          episodes,
          episode_count: episodes.length,
          url: `${page.base}/anime.php?${ahId}`,
          base: page.base,
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },

    async get_stream_sources(gateHash, base) {
      gateHash = String(gateHash || '').trim();
      if (!gateHash) return { ok: false, error: 'Missing episode key' };
      const bases = base ? [base, ...AH_BASES.filter((b) => b !== base)] : AH_BASES.slice();
      let lastErr = null;
      for (const site of bases) {
        try {
          const url = `${site}/gate.php`;
          const headers = {
            Accept: 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${site}/`,
            Origin: site,
            Cookie: `key=${gateHash}; Path=/`,
            'User-Agent': AH_UA,
          };

          let html = '';
          if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.CapacitorHttp) {
            const Http = global.Capacitor.Plugins.CapacitorHttp;
            try {
              // Warm cookies on the domain
              await Http.setCookie?.({ url: site, key: 'key', value: gateHash });
            } catch { /* plugin may not support setCookie */ }
            try {
              await Http.request({
                url: `${site}/`,
                method: 'GET',
                headers: { 'User-Agent': AH_UA, Referer: `${site}/` },
                connectTimeout: 15000,
                readTimeout: 15000,
              });
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
            const res = await httpRequest(url, { method: 'GET', headers, attempts: 2, timeoutMs: 28000 });
            html = await res.text();
          }

          const sources = extractStreamSources(html);
          if (sources.length) {
            return {
              ok: true,
              sources,
              primary: sources[0],
              playback_url: sources[0],
              referer: `${site}/`,
              origin: site,
              gate_hash: gateHash,
            };
          }
          lastErr = 'No stream urls in gate page';
        } catch (e) {
          lastErr = e;
        }
      }
      return {
        ok: false,
        error: String(lastErr && lastErr.message ? lastErr.message : lastErr || 'No stream found'),
        gate_hash: gateHash,
        external: `${AH_BASE}/gate.php`,
      };
    },

    // ---------- Free in-app reader (MangaDex public API) ----------
    async search_reader(query, limit = 12) {
      query = String(query || '').trim();
      if (query.length < 2) return { data: [], query, source: 'mangadex' };
      try {
        const lim = Math.min(20, Math.max(1, Number(limit) || 12));
        // Don't require EN availability at search time — chapter feed handles language fallbacks
        const url = `${MD_API}/manga?title=${encodeURIComponent(query)}&limit=${lim}`
          + '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica'
          + '&includes[]=cover_art&order[relevance]=desc';
        const res = await httpRequest(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': MD_UA },
          attempts: 3,
          timeoutMs: 28000,
        });
        if (!res.ok) throw new Error(`MangaDex HTTP ${res.status}`);
        const json = await res.json();
        const rows = (json && json.data) || [];
        const data = rows.map((row) => {
          const attrs = row.attributes || {};
          const title = mdTitle(attrs);
          const alts = mdAltTitles(attrs);
          const demos = attrs.publicationDemographic || '';
          const orig = (attrs.originalLanguage || '').toLowerCase();
          let family = 'manga';
          if (orig === 'ko') family = 'manhwa';
          else if (orig === 'zh' || orig === 'zh-hk') family = 'manhua';
          if ((attrs.tags || []).some((t) => {
            const n = ((t.attributes && t.attributes.name && t.attributes.name.en) || '').toLowerCase();
            return n.includes('webtoon') || n.includes('full color');
          })) {
            if (family === 'manga' && orig === 'ko') family = 'manhwa';
          }
          if ((attrs.tags || []).some((t) => {
            const n = ((t.attributes && t.attributes.name && t.attributes.name.en) || '').toLowerCase();
            return n.includes('official adaptation') || n === 'adaptation';
          })) { /* keep */ }
          // Novels sometimes appear as text-based works; demographic or tag
          const isNovel = (attrs.tags || []).some((t) => {
            const n = ((t.attributes && t.attributes.name && t.attributes.name.en) || '').toLowerCase();
            return n.includes('adaptation') === false && n.includes('novel');
          }) || String(demos).toLowerCase() === 'novel';
          if (isNovel) family = 'novel';
          return {
            md_id: row.id,
            title,
            title_english: (attrs.title && attrs.title.en) || title,
            title_japanese: (attrs.title && (attrs.title.ja || attrs.title['ja-ro'])) || '',
            title_synonyms: alts,
            image: mdCoverUrl(row.id, row.relationships),
            status: attrs.status || '',
            year: attrs.year || null,
            media: family,
            original_language: attrs.originalLanguage || '',
            description: stripHtml((attrs.description && (attrs.description.en || Object.values(attrs.description)[0])) || ''),
            genres: mdTags(attrs),
            content_rating: attrs.contentRating || 'safe',
            source: 'mangadex',
            url: `https://mangadex.org/title/${row.id}`,
          };
        });
        return { data, query, source: 'mangadex' };
      } catch (e) {
        return { data: [], query, source: 'mangadex', error: String(e.message || e) };
      }
    },

    async resolve_reader(malId, titles, mediaHint) {
      const titleList = (titles || []).map((t) => String(t || '').trim()).filter(Boolean);
      if (!titleList.length) return { ok: false, error: 'No title to search for reading' };
      try {
        let best = null;
        for (const t of titleList.slice(0, 4)) {
          const hits = await this.search_reader(t, 12);
          for (const hit of (hits.data || [])) {
            let score = Math.max(...titleList.map((x) => scoreMatch(x, hit.title)));
            for (const alt of hit.title_synonyms || []) {
              score = Math.max(score, ...titleList.map((x) => scoreMatch(x, alt)));
            }
            // Soft boost when family matches AniList media
            const hint = String(mediaHint || '').toLowerCase();
            if (hint && hit.media === hint) score += 0.05;
            if (hint === 'webtoon' && hit.media === 'manhwa') score += 0.04;
            if (!best || score > best.score) best = { ...hit, score };
          }
          if (best && best.score >= 0.9) break;
        }
        if (!best || best.score < 0.38) {
          return {
            ok: false,
            error: 'Could not match this title for in-app reading. Try a shorter English/romaji name.',
            suggestions: [],
          };
        }
        return {
          ok: true,
          match_score: Math.round(best.score * 100) / 100,
          md_id: best.md_id,
          title: best.title,
          title_english: best.title_english,
          title_japanese: best.title_japanese,
          image: best.image,
          media: best.media,
          url: best.url,
          description: best.description,
          genres: best.genres || [],
          source: 'mangadex',
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },

    async get_reader_chapters(mdId, { limit = 100, offset = 0, language = 'en' } = {}) {
      mdId = String(mdId || '').trim();
      if (!mdId) return { ok: false, error: 'Missing manga id', chapters: [] };

      async function fetchFeed(langs) {
        const chapters = [];
        let off = Math.max(0, Number(offset) || 0);
        const pageSize = Math.min(100, Math.max(1, Number(limit) || 100));
        for (let page = 0; page < 4; page += 1) {
          let url = `${MD_API}/manga/${encodeURIComponent(mdId)}/feed`
            + `?limit=${pageSize}&offset=${off}`
            + '&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica'
            + '&order[chapter]=asc&order[volume]=asc'
            + '&includeEmptyPages=0&includeFuturePublishAt=0&includeExternalUrl=0';
          for (const lang of langs) {
            url += `&translatedLanguage[]=${encodeURIComponent(lang)}`;
          }
          const res = await httpRequest(url, {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': MD_UA },
            attempts: 3,
            timeoutMs: 28000,
          });
          if (!res.ok) throw new Error(`MangaDex feed HTTP ${res.status}`);
          const json = await res.json();
          const rows = (json && json.data) || [];
          for (const row of rows) {
            const a = row.attributes || {};
            if (a.externalUrl) continue;
            const chap = a.chapter != null && a.chapter !== '' ? String(a.chapter) : null;
            chapters.push({
              chapter_id: row.id,
              chapter: chap,
              volume: a.volume != null ? String(a.volume) : null,
              title: a.title || (chap ? `Chapter ${chap}` : 'Oneshot'),
              pages: a.pages || 0,
              language: a.translatedLanguage || (langs[0] || 'en'),
              publish_at: a.publishAt || a.readableAt || null,
            });
          }
          const total = (json && json.total) || 0;
          off += rows.length;
          if (!rows.length || off >= total) break;
        }
        return chapters;
      }

      try {
        // Prefer English, then fall back to any language available
        let chapters = await fetchFeed([language, 'en', 'en-us'].filter((v, i, a) => a.indexOf(v) === i));
        if (!chapters.length) {
          chapters = await fetchFeed([]); // no language filter
        }
        // Prefer chapters that report page counts when de-duping
        chapters.sort((a, b) => (b.pages || 0) - (a.pages || 0));
        const byKey = new Map();
        for (const c of chapters) {
          const key = c.chapter != null ? `c:${c.chapter}:${c.language}` : `id:${c.chapter_id}`;
          if (!byKey.has(key)) byKey.set(key, c);
        }
        // Collapse same chapter number across languages — keep highest page count / en first
        const byChap = new Map();
        for (const c of byKey.values()) {
          const key = c.chapter != null ? `n:${c.chapter}` : `id:${c.chapter_id}`;
          const prev = byChap.get(key);
          if (!prev) {
            byChap.set(key, c);
            continue;
          }
          const prevEn = String(prev.language || '').startsWith('en');
          const curEn = String(c.language || '').startsWith('en');
          if ((!prevEn && curEn) || ((c.pages || 0) > (prev.pages || 0) && !(prevEn && !curEn))) {
            byChap.set(key, c);
          }
        }
        const unique = [...byChap.values()];
        unique.sort((a, b) => {
          const na = parseFloat(a.chapter);
          const nb = parseFloat(b.chapter);
          if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
          if (!Number.isNaN(na)) return -1;
          if (!Number.isNaN(nb)) return 1;
          return String(a.title).localeCompare(String(b.title));
        });
        return {
          ok: true,
          md_id: mdId,
          chapters: unique,
          chapter_count: unique.length,
          source: 'mangadex',
          catalog_url: `https://mangadex.org/title/${mdId}`,
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e), chapters: [], catalog_url: `https://mangadex.org/title/${mdId}` };
      }
    },

    async get_reader_pages(chapterId, { dataSaver = true } = {}) {
      chapterId = String(chapterId || '').trim();
      if (!chapterId) return { ok: false, error: 'Missing chapter id', pages: [] };
      try {
        const url = `${MD_API}/at-home/server/${encodeURIComponent(chapterId)}?forcePort443=true`;
        const res = await httpRequest(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': MD_UA },
          attempts: 3,
          timeoutMs: 28000,
        });
        if (!res.ok) {
          return { ok: false, error: `Chapter pages unavailable (HTTP ${res.status})`, pages: [] };
        }
        const json = await res.json();
        if (json.result === 'error') {
          const detail = (json.errors && json.errors[0] && json.errors[0].detail) || 'Chapter not hostable';
          return { ok: false, error: String(detail), pages: [] };
        }
        const baseUrl = json.baseUrl;
        const chapter = json.chapter || {};
        const hash = chapter.hash;
        const saver = chapter.dataSaver || [];
        const full = chapter.data || [];
        const useSaver = dataSaver && saver.length;
        const files = useSaver ? saver : (full.length ? full : saver);
        if (!baseUrl || !hash || !files.length) {
          return { ok: false, error: 'No page images for this chapter (may be licensed/external only)', pages: [] };
        }
        const quality = useSaver ? 'data-saver' : 'data';
        const pages = files.map((file, i) => ({
          index: i + 1,
          url: `${baseUrl}/${quality}/${hash}/${file}`,
        }));
        return {
          ok: true,
          chapter_id: chapterId,
          pages,
          page_count: pages.length,
          data_saver: quality === 'data-saver',
          source: 'mangadex',
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e), pages: [] };
      }
    },

    async get_read_progress(mdId) {
      const lib = getLibrary();
      const key = String(mdId || '');
      return lib.read_progress[key] || null;
    },

    async set_read_progress(mdId, chapterId, chapterLabel, pageIndex) {
      const lib = getLibrary();
      const key = String(mdId || '');
      if (!key) return { ok: false, error: 'Missing id' };
      lib.read_progress[key] = {
        md_id: key,
        chapter_id: chapterId || null,
        chapter: chapterLabel != null ? String(chapterLabel) : null,
        page: Number(pageIndex) || 1,
        updated_at: new Date().toISOString(),
      };
      // Cap map size
      const keys = Object.keys(lib.read_progress);
      if (keys.length > 80) {
        keys.sort((a, b) => String(lib.read_progress[a].updated_at || '').localeCompare(String(lib.read_progress[b].updated_at || '')));
        keys.slice(0, keys.length - 60).forEach((k) => delete lib.read_progress[k]);
      }
      saveLibrary(lib);
      return { ok: true, progress: lib.read_progress[key] };
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
      const bootstrap = await this.get_bootstrap(true);
      const weekly = await this.get_weekly(true);
      const now = new Date();
      const monthly = await this.get_monthly(now.getFullYear(), now.getMonth() + 1);
      const yearly = await this.get_yearly(now.getFullYear());
      return {
        ok: true,
        today: todayKey(),
        last_refresh_time: new Date().toISOString(),
        bootstrap,
        weekly,
        monthly,
        yearly,
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
