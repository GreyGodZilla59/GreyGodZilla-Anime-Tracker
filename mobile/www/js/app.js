const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
const WEEK_COL_WIDTH_KEY = 'weekColWidths';
const DEFAULT_WEEK_COL_WIDTH = 168;
const MIN_WEEK_COL_WIDTH = 100;
const MAX_WEEK_COL_WIDTH = 480;

const CURRENT_YEAR = new Date().getFullYear();
const DAILY_REFRESH_CHECK_MS = 30 * 60 * 1000;

const state = {
  section: 'track', // track | anime | read | saved | settings
  trackTab: 'daily',
  tab: 'daily',
  search: '',
  bootstrap: null,
  weekly: null,
  monthly: null,
  yearly: null,
  yearlyYear: CURRENT_YEAR,
  refreshDate: null,
  season: { now: null, upcoming: null },
  webhook: { config: null, status: null },
  watchlist: [],
  favorites: [],
  history: [],
  searchResults: null,
  searchLoading: false,
  searchError: null,
  searchSource: '',
  searchRequestId: 0,
  filters: {
    media: 'all',
    type: 'any',
    status: 'any',
    order_by: 'popularity',
    min_score: 0,
  },
  readMedia: 'all_print', // all_print | manga | manhwa | webtoon | manhua | novel
  stream: {
    open: false,
    anime: null,
    ahId: null,
    episodes: [],
    currentEp: null,
    loading: false,
    error: null,
    progressTimer: null,
  },
  reader: {
    open: false,
    item: null,
    mdId: null,
    chapters: [],
    currentChapter: null,
    pages: [],
    loading: false,
    error: null,
    dataSaver: true,
    mode: 'chapters', // chapters | pages
  },
  loading: new Set(),
  loaded: new Set(),
  error: null,
};

const $ = (sel) => document.querySelector(sel);

/** Safe textContent — mobile UI omits many desktop count badges. */
function setText(sel, val) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.textContent = val == null ? '' : String(val);
}

function getTodayDay() {
  const map = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return map[new Date().getDay()];
}

function waitForApi() {
  return new Promise((resolve) => {
    if (window.pywebview?.api) return resolve(window.pywebview.api);
    window.addEventListener('pywebviewready', () => resolve(window.pywebview.api), { once: true });
    setTimeout(() => resolve(window.pywebview?.api || null), 2000);
  });
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDate(iso) {
  if (!iso) return 'TBA';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function titleOf(a) {
  return a.title_english || a.title || 'Unknown';
}

function matchesSearch(a, q) {
  if (!q) return true;
  const fields = [a.title, a.title_english, a.title_japanese, ...(a.title_synonyms || []), ...(a.genres || [])];
  return fields.some((f) => f && String(f).toLowerCase().includes(q));
}

function setStatus(text, kind = '') {
  const pill = $('#status-pill');
  const label = $('#status-text');
  setText(label, text);
  if (pill) pill.className = `status-pill ${kind}`;
}

function updateStats() {
  // Stats bar removed for a calmer UI — only tab badges remain.
  setText('#count-favorites', state.favorites.length);
  setText('#count-history', state.history.length);
}

function noteStale(data, label) {
  if (!data) return;
  if (data.stale || data.offline) {
    setStatus('Offline cache', 'loading');
    showToast(`${label}: using saved data (AniList blipped)`, '');
  } else if (data.error) {
    setStatus('Partial', 'loading');
  }
}

function setSubheader(html) {
  const el = $('#subheader');
  if (!el) return;
  if (!html) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = html;
}

function showLoading(msg = 'Loading...') {
  $('#loading')?.classList.remove('hidden');
  setText('#loading-text', msg);
  $('#content')?.classList.add('hidden');
  $('#empty')?.classList.add('hidden');
  $('#error')?.classList.add('hidden');
}

function hideLoading() {
  $('#loading')?.classList.add('hidden');
}

function showError(msg) {
  hideLoading();
  $('#content')?.classList.add('hidden');
  $('#empty')?.classList.add('hidden');
  $('#error')?.classList.remove('hidden');
  setText('#error-message', msg);
  setStatus('Error', '');
}

function showEmpty(msg) {
  hideLoading();
  $('#content')?.classList.add('hidden');
  $('#empty')?.classList.remove('hidden');
  setText('#empty-message', msg);
}

function showContent(html) {
  hideLoading();
  $('#empty')?.classList.add('hidden');
  $('#error')?.classList.add('hidden');
  const content = $('#content');
  if (content) {
    content.innerHTML = html;
    content.classList.remove('hidden');
  }
}

function isTracked(malId) {
  return state.watchlist.some((w) => Number(w.mal_id) === Number(malId));
}

function isFavorite(malId) {
  return state.favorites.some((f) => Number(f.mal_id) === Number(malId));
}

function isCompleted(malId) {
  return state.history.some((h) => Number(h.mal_id) === Number(malId));
}

function findAnimeById(malId) {
  const id = Number(malId);
  const pools = [
    state.bootstrap?.today,
    state.bootstrap?.now,
    state.bootstrap?.upcoming,
    state.season?.now,
    state.season?.upcoming,
    state.monthly?.premieres,
    state.monthly?.ongoing,
    state.monthly?.starting_soon,
    state.yearly?.premieres,
    state.yearly?.announced_tba,
    state.yearly?.airing,
    state.yearly?.finished,
    state.watchlist,
    state.favorites,
    state.history,
    state.searchResults,
  ];
  if (state.weekly?.schedule) {
    pools.push(...Object.values(state.weekly.schedule));
  }
  for (const pool of pools) {
    if (!pool) continue;
    const list = Array.isArray(pool) ? pool : [pool];
    const hit = list.find((a) => Number(a.mal_id) === id);
    if (hit) return hit;
  }
  return null;
}

function isPrintMedia(a) {
  const media = (a?.media || 'anime').toLowerCase();
  return media !== 'anime';
}

function trackButton(a) {
  if (!a.mal_id || isPrintMedia(a)) return '';
  const tracked = isTracked(a.mal_id);
  return `<button type="button" class="track-btn ${tracked ? 'tracked' : ''}" data-track-id="${a.mal_id}" title="Notify via webhook when a new episode releases">${tracked ? '✓ Tracked' : '+ Track'}</button>`;
}

function favoriteButton(a) {
  if (!a.mal_id) return '';
  const fav = isFavorite(a.mal_id);
  return `<button type="button" class="fav-btn ${fav ? 'favorited' : ''}" data-fav-id="${a.mal_id}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★ Favorited' : '☆ Favorite'}</button>`;
}

function completeButton(a) {
  if (!a.mal_id) return '';
  const done = isCompleted(a.mal_id);
  return `<button type="button" class="complete-btn ${done ? 'completed' : ''}" data-complete-id="${a.mal_id}" title="${done ? 'Remove from history' : 'Mark as completed'}">${done ? '✓ Completed' : 'Mark Done'}</button>`;
}

function watchButton(a) {
  if (!a.mal_id || isPrintMedia(a)) return '';
  const title = escapeHtml(titleOf(a));
  return `<button type="button" class="watch-btn" data-watch-mal-id="${a.mal_id}" data-watch-title="${title}" title="Stream in-app">▶ Watch</button>`;
}

function readButton(a) {
  if (!a || !isPrintMedia(a)) return '';
  const title = escapeHtml(titleOf(a));
  const id = a.mal_id || a.anilist_id || '';
  return `<button type="button" class="read-btn" data-read-mal-id="${id}" data-read-title="${title}" title="Read in-app (free)">📖 Read</button>`;
}

function actionButtons(a) {
  return `<div class="detail-actions">${watchButton(a)}${readButton(a)}${favoriteButton(a)}${completeButton(a)}${trackButton(a)}</div>`;
}

function metaChips(a) {
  const chips = [];
  if (a.type) chips.push(`<span class="meta-chip">${escapeHtml(a.type)}</span>`);
  if (a.media) {
    chips.push(`<span class="meta-chip media-chip">${escapeHtml(a.media)}</span>`);
  }
  if (a.episodes) chips.push(`<span class="meta-chip">${a.episodes} eps</span>`);
  if (a.chapters) chips.push(`<span class="meta-chip">${a.chapters} ch</span>`);
  if (a.volumes) chips.push(`<span class="meta-chip">${a.volumes} vol</span>`);
  if (a.airing || a.publishing) {
    chips.push(`<span class="meta-chip airing">${isPrintMedia(a) ? 'Publishing' : 'Airing'}</span>`);
  }
  if (a.broadcast_time) chips.push(`<span class="meta-chip time">${escapeHtml(a.broadcast_time)} JST</span>`);
  if (a.broadcast_day) chips.push(`<span class="meta-chip accent">${escapeHtml(a.broadcast_day)}</span>`);
  (a.genres || []).slice(0, 3).forEach((g) => chips.push(`<span class="meta-chip">${escapeHtml(g)}</span>`));
  (a.studios || []).slice(0, 1).forEach((s) => chips.push(`<span class="meta-chip">${escapeHtml(s)}</span>`));
  return chips.join('');
}

function detailRow(a) {
  const title = escapeHtml(titleOf(a));
  const jp = a.title_japanese && a.title_japanese !== a.title ? escapeHtml(a.title_japanese) : '';
  const synopsis = a.synopsis ? escapeHtml(a.synopsis) + (a.synopsis.length >= 220 ? '…' : '') : '';
  const score = a.score ? `★ ${a.score}` : '—';
  const rank = a.rank ? `#${a.rank}` : '';

  return `
    <article class="detail-row">
      <img class="detail-thumb" src="${a.image || ''}" alt="${title}" loading="lazy">
      <div class="detail-body">
        <a class="detail-title" href="${a.url}" target="_blank" rel="noopener">${title}</a>
        ${jp ? `<div class="detail-jp">${jp}</div>` : ''}
        ${synopsis ? `<p class="detail-synopsis">${synopsis}</p>` : ''}
        <div class="detail-meta">${metaChips(a)}</div>
      </div>
      <div class="detail-side">
        <div class="detail-score">${score}</div>
        ${rank ? `<div class="detail-rank">Rank ${rank}</div>` : ''}
        ${actionButtons(a)}
      </div>
    </article>
  `;
}

function cardHtml(a) {
  try {
    if (!a) return '';
    const title = escapeHtml(titleOf(a));
    const sub = a.title_japanese ? escapeHtml(a.title_japanese) : '';
    const print = isPrintMedia(a);
    let badge = 'badge-upcoming';
    let label = 'Upcoming';
    if (print) {
      const family = (a.media || a.type || 'Manga').toString();
      badge = 'badge-print';
      label = family.charAt(0).toUpperCase() + family.slice(1);
      if (a.airing || a.publishing) {
        badge = 'badge-airing';
        label = 'Publishing';
      } else if ((a.status || '').toLowerCase().includes('finish') || (a.status || '').toLowerCase().includes('complete')) {
        badge = 'badge-done';
        label = 'Finished';
      }
    } else if (a.airing) {
      badge = 'badge-airing';
      label = 'Airing';
    }
    const score = a.score ? `<span class="badge badge-score">★ ${a.score}</span>` : '';
    const air = a.aired_from ? formatDate(a.aired_from) : 'TBA';
    const countChip = a.episodes
      ? `${a.episodes} eps`
      : (a.chapters ? `${a.chapters} ch` : (a.volumes ? `${a.volumes} vol` : ''));
    const mediaChip = a.media && a.media !== 'anime'
      ? `<span class="meta-chip media-chip">${escapeHtml(a.media)}</span>`
      : '';
    const href = escapeHtml(a.url || '#');

    return `
    <article class="card">
      <a class="card-link" href="${href}" target="_blank" rel="noopener">
        <div class="card-image-wrap">
          <img class="card-image" src="${escapeHtml(a.image || '')}" alt="${title}" loading="lazy">
          <div class="card-badges">
            <span class="badge ${badge}">${escapeHtml(label)}</span>
            ${score}
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          ${sub ? `<p class="card-sub">${sub}</p>` : ''}
          <div class="card-meta">
            ${mediaChip}
            ${a.type ? `<span class="meta-chip">${escapeHtml(a.type)}</span>` : ''}
            ${countChip ? `<span class="meta-chip">${escapeHtml(countChip)}</span>` : ''}
            <span class="meta-chip accent">${air}</span>
          </div>
        </div>
      </a>
      <div class="card-track card-actions">${watchButton(a)}${readButton(a)}${favoriteButton(a)}${completeButton(a)}${trackButton(a)}</div>
    </article>
  `;
  } catch {
    return '';
  }
}

function trackFilterQuery() {
  // Tracker must NOT use Anime/Read search text — that was hiding all of today's list
  if (state.section === 'anime' || state.section === 'read') return '';
  return '';
}

function renderDaily() {
  const raw = state.bootstrap?.today || [];
  // Extra safety: only keep entries that actually air on local today
  const todayKeyStr = new Date().toISOString().slice(0, 10);
  const localKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const list = raw.filter((a) => {
    if (a.airing_local_date) return a.airing_local_date === localKey;
    if (a.airing_at) {
      const ms = Number(a.airing_at) * 1000;
      return ms >= dayStart.getTime() && ms < dayEnd.getTime();
    }
    return true;
  });
  const day = state.bootstrap?.today_name || getTodayDay();

  setSubheader(`<strong>📅 Today · ${DAY_LABELS[day] || day}</strong> · ${list.length} episode drop${list.length === 1 ? '' : 's'}`);
  setText('#count-daily', list.length || '—');

  if (!list.length) {
    const err = state.bootstrap?.error;
    showEmpty(err
      ? `Couldn’t load today’s schedule (${err}). Tap ↻ Refresh.`
      : 'No episode drops scheduled for today (your local date). Tap ↻ to refresh.');
    return;
  }
  showContent(`<div class="detail-list">${list.map(detailRow).join('')}</div>`);
}

function getWeekColWidths() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(WEEK_COL_WIDTH_KEY) || '{}');
  } catch {
    saved = {};
  }
  return DAYS.reduce((acc, day) => {
    const width = Number(saved[day]) || DEFAULT_WEEK_COL_WIDTH;
    acc[day] = Math.max(MIN_WEEK_COL_WIDTH, Math.min(MAX_WEEK_COL_WIDTH, width));
    return acc;
  }, {});
}

function saveWeekColWidth(day, width) {
  const widths = getWeekColWidths();
  widths[day] = Math.max(MIN_WEEK_COL_WIDTH, Math.min(MAX_WEEK_COL_WIDTH, Math.round(width)));
  localStorage.setItem(WEEK_COL_WIDTH_KEY, JSON.stringify(widths));
}

function bindWeekBoardEvents() {
  const board = document.querySelector('.week-board');
  if (!board) return;

  board.querySelectorAll('.week-col-resizer').forEach((resizer) => {
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const day = resizer.dataset.resizerDay;
      const col = board.querySelector(`.week-col[data-day="${day}"]`);
      if (!col) return;

      const startX = e.clientX;
      const startWidth = col.offsetWidth;
      resizer.classList.add('active');

      const onMove = (ev) => {
        const nextWidth = Math.max(
          MIN_WEEK_COL_WIDTH,
          Math.min(MAX_WEEK_COL_WIDTH, startWidth + (ev.clientX - startX)),
        );
        col.style.minWidth = `${nextWidth}px`;
        col.style.flex = `1 1 ${nextWidth}px`;
      };

      const onUp = () => {
        saveWeekColWidth(day, col.offsetWidth);
        resizer.classList.remove('active');
        document.body.classList.remove('week-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.body.classList.add('week-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

async function openAnimeHeavenExternal(anime, triggerEl = null) {
  const api = await waitForApi();
  if (!api?.resolve_stream) {
    showToast('AnimeHeaven lookup not available.', 'err');
    return;
  }

  if (triggerEl) triggerEl.classList.add('loading');

  const titles = [
    anime.title_english,
    anime.title,
    anime.title_japanese,
    ...(anime.title_synonyms || []),
  ].filter(Boolean);

  try {
    const resolved = await api.resolve_stream(anime.mal_id, titles);
    if (resolved?.ok && resolved.url) {
      window.open(resolved.url, '_blank', 'noopener');
      return;
    }
    showToast(resolved?.error || 'Could not find this show on AnimeHeaven.', 'err');
  } catch (err) {
    showToast(err.message || 'Could not open AnimeHeaven.', 'err');
  } finally {
    if (triggerEl) triggerEl.classList.remove('loading');
  }
}

function renderWeekly() {
  const schedule = state.weekly?.schedule || {};
  const today = state.bootstrap?.today_name || getTodayDay();
  const widths = getWeekColWidths();
  let total = 0;
  const weekLabel = state.weekly?.week_start && state.weekly?.week_end
    ? `${state.weekly.week_start} → ${state.weekly.week_end}`
    : 'This week';
  const synced = state.weekly?.last_refreshed
    ? new Date(state.weekly.last_refreshed).toLocaleString()
    : '';

  const cols = DAYS.map((day, index) => {
    // Do not apply Anime/Read search text here
    const items = schedule[day] || [];
    total += items.length;
    const body = items.length
      ? items.map((a) => {
          const title = escapeHtml(titleOf(a));
          const ep = a.next_episode || a.episode_label;
          const epBit = ep ? `Ep ${String(ep).replace(/^Ep\s*/i, '')}` : '';
          return `
          <button type="button" class="week-item" data-ah-mal-id="${a.mal_id}"
            data-ah-title="${title}" title="Open on AnimeHeaven.me">
            <img src="${a.image || ''}" alt="" loading="lazy">
            <div>
              <div class="week-item-title">${title}</div>
              <div class="week-item-time">
                ${a.broadcast_time ? escapeHtml(a.broadcast_time) : ''}
                ${epBit ? ` · ${escapeHtml(epBit)}` : ''}
              </div>
            </div>
          </button>
        `;
        }).join('')
      : '<div class="week-empty">No shows</div>';

    const col = `
      <section class="week-col ${day === today ? 'today' : ''}" data-day="${day}"
        style="min-width:${widths[day]}px; flex:1 1 0">
        <div class="week-col-head">
          ${DAY_LABELS[day]}
          <span class="count">${items.length} drop${items.length === 1 ? '' : 's'}</span>
        </div>
        <div class="week-col-body">${body}</div>
      </section>
    `;
    const resizer = index < DAYS.length - 1
      ? `<div class="week-col-resizer" data-resizer-day="${day}" title="Drag to resize column"></div>`
      : '';
    return col + resizer;
  }).join('');

  setSubheader(
    `Episode drops · <strong>${weekLabel}</strong> · <strong>${total}</strong> releases`
    + (synced ? ` · synced ${escapeHtml(synced)}` : '')
    + ' · drag column edges to resize',
  );
  setText('#count-weekly', total || '—');
  showContent(`<div class="week-board">${cols}</div>`);
  bindWeekBoardEvents();
}

function monthDayDrops(m, day, q) {
  const byDay = m.releases_by_day || m.premiere_by_day || {};
  return (byDay[String(day)] || []).filter((a) => matchesSearch(a, q));
}

function renderMonthly() {
  const m = state.monthly;
  if (!m) {
    showLoading('Loading monthly calendar...');
    return;
  }

  // Tracker views ignore Anime/Read search text
  const q = '';
  const premieres = (m.premieres || []).filter((a) => matchesSearch(a, q));
  const ongoing = (m.ongoing || []).filter((a) => matchesSearch(a, q));
  const startingSoon = (m.starting_soon || []).filter((a) => matchesSearch(a, q));
  let releaseTotal = 0;
  for (let d = 1; d <= (m.days_in_month || 31); d += 1) {
    releaseTotal += monthDayDrops(m, d, q).length;
  }
  const monthTotal = releaseTotal || premieres.length + ongoing.length;
  const synced = m.last_refreshed ? new Date(m.last_refreshed).toLocaleString() : '';

  setSubheader(
    `<strong>${m.month_name} ${m.year}</strong> · ${releaseTotal} episode drops · ${premieres.length} new series`
    + (synced ? ` · synced ${escapeHtml(synced)}` : ''),
  );
  setText('#count-monthly', monthTotal);

  const dayCells = [];
  for (let d = 1; d <= m.days_in_month; d++) {
    const drops = monthDayDrops(m, d, q);
    const items = drops.slice(0, 6).map((a) => {
      const ep = a.next_episode ? `Ep ${a.next_episode} · ` : (a.episode_label ? `${a.episode_label} · ` : '');
      const time = a.broadcast_time ? `${a.broadcast_time} ` : '';
      return `
      <a class="month-day-item" href="${a.url || '#'}" target="_blank" rel="noopener"
        title="${escapeHtml(time + ep + titleOf(a))}">${escapeHtml(ep)}${escapeHtml(titleOf(a))}</a>
    `;
    }).join('');
    const more = drops.length > 6 ? `<span class="week-empty">+${drops.length - 6} more</span>` : '';
    const clickable = drops.length
      ? `role="button" tabindex="0" data-month-day="${d}" data-month-year="${m.year}" data-month-num="${m.month}" title="Show all releases for day ${d}"`
      : '';
    dayCells.push(`
      <div class="month-day ${drops.length ? 'has-drop clickable-day' : ''}" ${clickable}>
        <div class="month-day-num">${d}${drops.length ? ` · ${drops.length}` : ''}</div>
        ${items || (drops.length === 0 ? '<span class="week-empty">—</span>' : '')}
        ${more}
      </div>
    `);
  }

  const premiereList = premieres.length
    ? `<div class="detail-list">${premieres.map(detailRow).join('')}</div>`
    : '<p class="week-empty">No new series premieres found this month.</p>';

  const ongoingList = ongoing.length
    ? `<div class="detail-list">${ongoing.slice(0, 40).map(detailRow).join('')}</div>`
    : '<p class="week-empty">No episode releases found this month yet.</p>';

  const soonList = startingSoon.length
    ? `<div class="detail-list">${startingSoon.map(detailRow).join('')}</div>`
    : '';

  showContent(`
    <div class="month-header">
      <h2>${m.month_name} ${m.year}</h2>
      <div class="month-stats">${releaseTotal} episode drops · ${premieres.length} new series · ${ongoing.length} unique titles</div>
    </div>
    <section class="month-section">
      <h3>Episode Release Calendar</h3>
      <div class="month-grid">${dayCells.join('')}</div>
    </section>
    <section class="month-section">
      <h3>New Series This Month</h3>
      ${premiereList}
    </section>
    <section class="month-section">
      <h3>Titles Airing This Month</h3>
      ${ongoingList}
    </section>
    ${soonList ? `<section class="month-section"><h3>Starting Soon</h3>${soonList}</section>` : ''}
  `);
}

function quarterLabel(name) {
  return ({ winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' })[name] || name;
}

function bindYearlyEvents() {
  $('#year-prev-btn')?.addEventListener('click', () => changeYearlyYear(state.yearlyYear - 1));
  $('#year-next-btn')?.addEventListener('click', () => changeYearlyYear(state.yearlyYear + 1));
  $('#year-refresh-btn')?.addEventListener('click', () => forceRefreshAll());
}

async function changeYearlyYear(year) {
  if (year < 2000 || year > CURRENT_YEAR + 2) return;
  state.yearlyYear = year;
  state.yearly = null;
  state.loaded.delete('yearly');
  if (state.tab === 'yearly') {
    showLoading(`Loading ${year} anime...`);
    await loadYearlyBackground(true);
  }
}

function renderYearly() {
  const y = state.yearly;
  if (!y) {
    showLoading(`Loading ${state.yearlyYear} releases...`);
    return;
  }

  const q = '';
  const premieres = (y.premieres || []).filter((a) => matchesSearch(a, q));
  const announced = (y.announced_tba || []).filter((a) => matchesSearch(a, q));
  const airing = (y.airing || []).filter((a) => matchesSearch(a, q));
  const yearTotal = premieres.length + announced.length + airing.length;

  const refreshed = y.last_refreshed
    ? new Date(y.last_refreshed).toLocaleString()
    : '—';

  setSubheader(
    `<strong>${y.year}</strong> releases · ${premieres.length} dated premieres · ${announced.length} announced · auto-refreshes daily`,
  );
  setText('#count-yearly', yearTotal || y.total || '—');
  updateStats();

  const quarterCards = ['winter', 'spring', 'summer', 'fall'].map((quarter) => {
    const items = (y.by_quarter?.[quarter] || []).filter((a) => matchesSearch(a, q));
    return `
      <div class="year-quarter-card">
        <h4>${quarterLabel(quarter)}</h4>
        <div class="count">${items.length}</div>
        <div class="sub">${y.year} season</div>
      </div>
    `;
  }).join('');

  const monthCards = [];
  for (let month = 1; month <= 12; month += 1) {
    const items = (y.by_month?.[String(month)] || []).filter((a) => matchesSearch(a, q));
    const monthName = y.month_names?.[month] || `Month ${month}`;
    const list = items.slice(0, 6).map((a) => {
      const title = escapeHtml(titleOf(a));
      return `
        <button type="button" class="year-month-item" data-ah-mal-id="${a.mal_id}"
          data-ah-title="${title}" title="Open on AnimeHeaven.me">${title}</button>
      `;
    }).join('');
    const more = items.length > 6 ? `<div class="week-empty">+${items.length - 6} more</div>` : '';
    // Card is a div (not a nested button) so per-title actions stay valid HTML.
    monthCards.push(`
      <div class="year-month-card ${items.length ? 'has-shows' : ''}"
        data-open-month="${month}" data-open-year="${y.year}" role="button" tabindex="0"
        title="Open detailed calendar for ${escapeHtml(monthName)} ${y.year}">
        <div class="year-month-name">${monthName} <span class="month-open-hint">Open →</span></div>
        <div class="year-month-count">${items.length} premiere${items.length === 1 ? '' : 's'}</div>
        ${list || '<span class="week-empty">—</span>'}
        ${more}
      </div>
    `);
  }

  const premiereList = premieres.length
    ? `<div class="detail-list">${premieres.map(detailRow).join('')}</div>`
    : '<p class="week-empty">No dated premieres found for this year yet.</p>';

  const announcedList = announced.length
    ? `<div class="detail-list">${announced.map(detailRow).join('')}</div>`
    : '<p class="week-empty">No TBA announcements for this year yet.</p>';

  const airingList = airing.length
    ? `<div class="detail-list">${airing.map(detailRow).join('')}</div>`
    : '<p class="week-empty">Nothing airing from this year\'s list right now.</p>';

  showContent(`
    <div class="year-toolbar">
      <div class="year-nav">
        <button type="button" class="year-nav-btn" id="year-prev-btn" aria-label="Previous year">‹</button>
        <div class="year-title">${y.year}</div>
        <button type="button" class="year-nav-btn" id="year-next-btn"
          ${y.year >= CURRENT_YEAR + 2 ? 'disabled' : ''} aria-label="Next year">›</button>
      </div>
      <div class="year-refresh-note">Last synced ${escapeHtml(refreshed)} · checks for new announcements every day</div>
      <button type="button" class="webhook-btn secondary" id="year-refresh-btn">Refresh Now</button>
    </div>
    <section class="month-section">
      <h3>Season Overview</h3>
      <div class="year-quarter-grid">${quarterCards}</div>
    </section>
    <section class="month-section">
      <h3>Premieres by Month</h3>
      <div class="year-month-grid">${monthCards.join('')}</div>
    </section>
    <section class="month-section">
      <h3>Upcoming Premieres (${premieres.length})</h3>
      ${premiereList}
    </section>
    <section class="month-section">
      <h3>Announced · Date TBA (${announced.length})</h3>
      ${announcedList}
    </section>
    <section class="month-section">
      <h3>Currently Airing (${airing.length})</h3>
      ${airingList}
    </section>
  `);
  bindYearlyEvents();
}

function renderSeason(which) {
  const list = (state.bootstrap?.[which] || state.season[which] || []).filter(Boolean);
  setText(`#count-${which}`, list.length || '—');

  const label = which === 'now' ? 'Current season' : 'Next season';
  setSubheader(`<strong>${label}</strong> · ${list.length} shows`);

  if (!list.length) {
    showEmpty('No anime in this list yet. Tap ↻ Refresh.');
    return;
  }
  showContent(`<div class="grid">${list.map(cardHtml).join('')}</div>`);
}

const LEAD_OPTIONS = [
  [5, '5 min'],
  [15, '15 min'],
  [30, '30 min'],
  [60, '1 hour'],
  [120, '2 hours'],
  [360, '6 hours'],
  [720, '12 hours'],
  [1440, '24 hours'],
];

function leadSelect(id, value) {
  const v = Number(value) || 30;
  return `<select id="${id}">${LEAD_OPTIONS.map(([m, label]) =>
    `<option value="${m}" ${v === m ? 'selected' : ''}>${label} before</option>`).join('')}</select>`;
}

function getNotifyPlugin() {
  try {
    return window.Capacitor?.Plugins?.GgzNotify || null;
  } catch {
    return null;
  }
}

async function syncLocalNotifications() {
  const api = await waitForApi();
  const plugin = getNotifyPlugin();
  if (!api || !plugin) return { scheduled: 0 };

  const settings = await api.get_notify_settings?.() || {};
  if (!settings.enabled) {
    try { await plugin.cancelAll?.(); } catch { /* */ }
    return { scheduled: 0, disabled: true };
  }

  try {
    await plugin.requestPermission?.();
  } catch { /* user may deny */ }

  // Build alert list from favorites + watchlist with known next air times
  const pool = [];
  const seen = new Set();
  const add = (item) => {
    if (!item?.mal_id) return;
    const key = Number(item.mal_id);
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(item);
  };
  (state.favorites || []).forEach(add);
  (state.watchlist || []).forEach(add);
  // Also scan currently loaded schedule cards for next air times
  (state.bootstrap?.today || []).forEach(add);
  (state.bootstrap?.now || []).forEach(add);

  const items = [];
  let id = 1000;
  for (const a of pool) {
    const airAt = Number(a.next_airing_at);
    if (!airAt || airAt * 1000 <= Date.now()) continue;
    const media = (a.media || 'anime').toLowerCase();
    const lead = api.leadMinutesForMedia
      ? api.leadMinutesForMedia(media)
      : (settings[`lead_${media}`] || settings.lead_default || 30);
    const notifyAt = airAt * 1000 - lead * 60 * 1000;
    if (notifyAt <= Date.now() + 20_000) continue;
    const ep = a.next_episode ? `Ep ${a.next_episode}` : 'New release';
    items.push({
      id: id++,
      title: 'Grey GodZilla · dropping soon',
      body: `${titleOf(a)} · ${ep} in ~${lead} min (${media})`,
      at: notifyAt,
    });
    if (items.length >= 40) break;
  }

  try {
    await plugin.cancelAll?.();
  } catch { /* */ }
  if (!items.length) return { scheduled: 0 };

  try {
    const res = await plugin.scheduleMany({ items });
    return { scheduled: res?.scheduled || items.length };
  } catch (e) {
    return { scheduled: 0, error: String(e?.message || e) };
  }
}

async function renderSettings() {
  const api = await waitForApi();
  const cfg = state.webhook.config || {};
  const st = state.webhook.status || {};
  const notify = (await api?.get_notify_settings?.()) || {
    enabled: true,
    lead_anime: 30,
    lead_manga: 60,
    lead_manhwa: 60,
    lead_webtoon: 60,
    lead_manhua: 60,
  };
  setSubheader('<strong>Settings</strong> · alerts, webhooks, comfort');

  const watchHtml = state.watchlist.length
    ? state.watchlist.map((w) => `
        <div class="webhook-watch-item">
          <img src="${w.image || ''}" alt="">
          <span class="title">${escapeHtml(w.title)}</span>
          <button type="button" class="track-btn tracked" data-untrack-id="${w.mal_id}">Remove</button>
        </div>
      `).join('')
    : '<p class="settings-hint">Track shows with <strong>+ Track</strong> to get drop alerts.</p>';

  showContent(`
    <div class="settings-panel">
      <section class="settings-card">
        <h3>Phone notifications (free)</h3>
        <p class="settings-hint">Local alerts before a drop — no paid services. Uses Favorites + Tracked titles with a known air time from AniList.</p>
        <label class="settings-toggle">
          <input type="checkbox" id="notify-enabled" ${notify.enabled ? 'checked' : ''}>
          Enable drop notifications
        </label>
        <div class="settings-row"><label>Anime</label>${leadSelect('lead-anime', notify.lead_anime)}</div>
        <div class="settings-row"><label>Manga</label>${leadSelect('lead-manga', notify.lead_manga)}</div>
        <div class="settings-row"><label>Manhwa</label>${leadSelect('lead-manhwa', notify.lead_manhwa)}</div>
        <div class="settings-row"><label>Webtoon</label>${leadSelect('lead-webtoon', notify.lead_webtoon)}</div>
        <div class="settings-row"><label>Manhua</label>${leadSelect('lead-manhua', notify.lead_manhua)}</div>
        <div class="settings-actions">
          <button type="button" class="webhook-btn" id="save-notify-btn">Save alert times</button>
          <button type="button" class="webhook-btn secondary" id="sync-notify-btn">Refresh schedules</button>
        </div>
        <p class="settings-msg" id="notify-msg"></p>
      </section>

      <section class="settings-card">
        <h3>Discord / webhook (optional)</h3>
        <p class="settings-hint">Optional extra pings while the app is open.</p>
        <div class="webhook-field">
          <label for="webhook-url">Webhook URL</label>
          <input type="url" id="webhook-url" placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(cfg.url || '')}">
        </div>
        <div class="webhook-field">
          <label for="webhook-poll">Check every</label>
          <select id="webhook-poll">
            ${[15, 30, 45, 60].map((m) => `<option value="${m}" ${Number(cfg.poll_minutes) === m ? 'selected' : ''}>${m} min</option>`).join('')}
          </select>
        </div>
        <label class="settings-toggle">
          <input type="checkbox" id="webhook-enabled" ${cfg.enabled ? 'checked' : ''}>
          Enable webhook episode pings
        </label>
        <div class="settings-actions">
          <button type="button" class="webhook-btn" id="save-webhook-btn">Save webhook</button>
          <button type="button" class="webhook-btn secondary" id="test-webhook-btn">Test ping</button>
        </div>
        <p class="settings-msg" id="webhook-save-msg"></p>
      </section>

      <section class="settings-card">
        <h3>Tracked shows</h3>
        <div class="webhook-watchlist">${watchHtml}</div>
      </section>

      <section class="settings-card">
        <h3>About</h3>
        <p class="settings-hint">In-app name: <strong>Grey GodZilla Anime App</strong><br>
        Launcher icon name: <strong>GGZ Anime</strong><br>
        Version: <strong id="settings-version">v1.6.1</strong></p>
      </section>
    </div>
  `);

  $('#save-notify-btn')?.addEventListener('click', async () => {
    const msg = $('#notify-msg');
    const payload = {
      enabled: !!$('#notify-enabled')?.checked,
      lead_anime: Number($('#lead-anime')?.value || 30),
      lead_manga: Number($('#lead-manga')?.value || 60),
      lead_manhwa: Number($('#lead-manhwa')?.value || 60),
      lead_webtoon: Number($('#lead-webtoon')?.value || 60),
      lead_manhua: Number($('#lead-manhua')?.value || 60),
    };
    const res = await api?.save_notify_settings?.(payload);
    if (res?.ok) {
      const sync = await syncLocalNotifications();
      if (msg) {
        msg.className = 'settings-msg ok';
        msg.textContent = `Saved. ${sync.scheduled || 0} alert(s) scheduled.`;
      }
      showToast('Notification settings saved.');
    } else if (msg) {
      msg.className = 'settings-msg err';
      msg.textContent = 'Could not save.';
    }
  });
  $('#sync-notify-btn')?.addEventListener('click', async () => {
    const sync = await syncLocalNotifications();
    const msg = $('#notify-msg');
    if (msg) {
      msg.className = sync.error ? 'settings-msg err' : 'settings-msg ok';
      msg.textContent = sync.error
        ? `Sync failed: ${sync.error}`
        : `Scheduled ${sync.scheduled || 0} upcoming alert(s).`;
    }
  });

  bindWebhookEvents();
}

function renderWebhooks() {
  // Webhooks live under Settings (calmer navigation)
  return renderSettings();
}

function bindWebhookEvents() {
  $('#save-webhook-btn')?.addEventListener('click', saveWebhookSettings);
  $('#test-webhook-btn')?.addEventListener('click', testWebhook);
  $('#check-webhook-btn')?.addEventListener('click', checkWebhookNow);
  $('#picker-search-btn')?.addEventListener('click', runPickerSearch);
  $('#picker-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runPickerSearch();
  });
  document.querySelectorAll('[data-untrack-id]').forEach((btn) => {
    btn.addEventListener('click', () => untrackAnime(Number(btn.dataset.untrackId)));
  });
}

function pickerItemHtml(a) {
  const tracked = isTracked(a.mal_id);
  const title = escapeHtml(titleOf(a));
  const sub = a.type ? escapeHtml(a.type) : (a.airing ? 'Airing' : 'Upcoming');
  return `
    <div class="picker-item">
      <img src="${a.image || ''}" alt="" loading="lazy">
      <div class="info">
        <div class="name" title="${title}">${title}</div>
        <div class="sub">${sub}</div>
      </div>
      <button type="button" class="picker-add-btn ${tracked ? 'added' : ''}" data-pick-id="${a.mal_id}">
        ${tracked ? '✓ Added' : '+ Track'}
      </button>
    </div>
  `;
}

function renderPickerList(container, list) {
  const el = $(container);
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="webhook-hint">No results.</p>';
    return;
  }
  el.innerHTML = list.map(pickerItemHtml).join('');
  el.querySelectorAll('[data-pick-id]').forEach((btn) => {
    btn.addEventListener('click', () => trackAnime(Number(btn.dataset.pickId)));
  });
}

async function loadPickerBrowse() {
  const api = await waitForApi();
  if (!api?.get_picker_anime) return;

  let data = [];
  const cached = [...(state.bootstrap?.now || []), ...(state.bootstrap?.upcoming || [])];
  if (cached.length) {
    const seen = new Set();
    data = cached.filter((a) => {
      if (seen.has(a.mal_id)) return false;
      seen.add(a.mal_id);
      return true;
    });
  } else {
    const result = await api.get_picker_anime();
    data = result.data || [];
  }
  renderPickerList('#picker-browse', data);
}

async function runPickerSearch() {
  const q = ($('#picker-search')?.value || '').trim();
  if (q.length < 2) {
    showToast('Type at least 2 characters to search.', 'err');
    return;
  }
  const api = await waitForApi();
  const result = await api.search_anime(q);
  renderPickerList('#picker-results', result.data || []);
}

function showToast(message, kind = 'ok') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

async function loadWebhookData() {
  const api = await waitForApi();
  if (!api?.get_webhook_config) return;
  const [config, status, watchlist] = await Promise.all([
    api.get_webhook_config(),
    api.get_webhook_status(),
    api.get_watchlist(),
  ]);
  state.webhook.config = config;
  state.webhook.status = status;
  state.watchlist = watchlist || [];
  setText('#count-webhooks', state.watchlist.length);
}

async function saveWebhookSettings() {
  const api = await waitForApi();
  const msg = $('#webhook-save-msg');
  const result = await api.save_webhook_config({
    url: $('#webhook-url').value,
    poll_minutes: Number($('#webhook-poll').value),
    enabled: $('#webhook-enabled').checked,
  });
  if (result?.ok) {
    msg.textContent = 'Settings saved.';
    msg.style.color = 'var(--ok)';
    await loadWebhookData();
    if (state.tab === 'webhooks') renderWebhooks();
  } else {
    msg.textContent = result?.error || 'Save failed.';
    msg.style.color = 'var(--err)';
  }
}

async function testWebhook() {
  const api = await waitForApi();
  const msg = $('#webhook-save-msg');
  const url = ($('#webhook-url')?.value || '').trim();
  if (!url) {
    msg.textContent = 'Enter a webhook URL first.';
    msg.style.color = 'var(--err)';
    return;
  }
  msg.textContent = 'Sending test...';
  msg.style.color = 'var(--muted)';
  const result = await api.test_webhook(url);
  if (result?.ok) {
    msg.textContent = 'Test ping sent — check your Discord channel.';
    msg.style.color = 'var(--ok)';
    await loadWebhookData();
    renderWebhooks();
  } else {
    msg.textContent = result?.error || 'Test failed.';
    msg.style.color = 'var(--err)';
  }
}

async function checkWebhookNow() {
  const api = await waitForApi();
  const msg = $('#webhook-save-msg');
  msg.textContent = 'Checking watchlist...';
  msg.style.color = 'var(--muted)';
  const result = await api.check_webhook_now();
  if (result?.ok) {
    msg.textContent = result.message || 'Check started.';
    msg.style.color = 'var(--ok)';
    setTimeout(async () => {
      await loadWebhookData();
      if (state.tab === 'webhooks') renderWebhooks();
    }, 2500);
  } else {
    msg.textContent = result?.error || 'Check failed.';
    msg.style.color = 'var(--err)';
  }
}

async function trackAnime(malId) {
  const api = await waitForApi();
  if (!api?.add_to_watchlist_by_id) return;

  const btn = document.querySelector(`[data-pick-id="${malId}"], [data-track-id="${malId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding...';
  }

  try {
    const result = await api.add_to_watchlist_by_id(malId);
    if (result?.ok) {
      const label = result.title || 'Show';
      showToast(result.already ? `${label} is already tracked.` : `Now tracking ${label}.`, 'ok');
      await loadWebhookData();
      if (state.tab === 'webhooks') renderWebhooks();
      else render();
    } else {
      showToast(result?.error || 'Could not add show.', 'err');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '+ Track';
      }
    }
  } catch (err) {
    showToast(err.message || 'Could not add show.', 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '+ Track';
    }
  }
}

async function untrackAnime(malId) {
  const api = await waitForApi();
  await api.remove_from_watchlist(malId);
  await loadWebhookData();
  render();
}

function renderFavorites() {
  const list = state.favorites || [];
  setSubheader(`Your <strong>favorites</strong> · ${list.length} saved`);
  setText('#count-favorites', list.length);
  updateStats();
  if (!list.length) {
    showEmpty('No favorites yet — hit ☆ Favorite on any show.');
    return;
  }
  showContent(`<div class="detail-list">${list.map(detailRow).join('')}</div>`);
}

function renderHistory() {
  const list = state.history || [];
  setSubheader(`Watch <strong>history</strong> · ${list.length} completed`);
  setText('#count-history', list.length);
  updateStats();
  if (!list.length) {
    showEmpty('No completed titles yet — use Mark Done on any show.');
    return;
  }
  const rows = list.map((a) => {
    const when = a.completed_at
      ? new Date(a.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    return `
      <div class="history-wrap">
        ${detailRow(a)}
        ${when ? `<div class="history-meta">Completed ${escapeHtml(when)}${a.note ? ` · ${escapeHtml(a.note)}` : ''}</div>` : ''}
      </div>
    `;
  }).join('');
  showContent(`<div class="detail-list">${rows}</div>`);
}

function renderSearchResults() {
  const q = state.search.trim();
  const isRead = state.section === 'read';
  const media = state.filters.media || (isRead ? 'manga' : 'anime');
  if (state.searchLoading) {
    showLoading(isRead
      ? `Looking up reading material for “${q}”…`
      : `Looking up anime for “${q}”…`);
    return;
  }
  let list = (state.searchResults || []).filter(Boolean);
  // Keep anime tab = anime only, read tab = print only
  if (state.section === 'anime') {
    list = list.filter((i) => !isPrintMedia(i));
  } else if (state.section === 'read') {
    list = list.filter((i) => isPrintMedia(i));
  }

  setSubheader(
    isRead
      ? `<strong>📖 Reading</strong> · “${escapeHtml(q)}” · ${list.length} book(s)`
      : `<strong>🎬 Anime</strong> · “${escapeHtml(q)}” · ${list.length} show(s)`,
  );
  setText('#count-search', list.length || '—');

  if (!q || q.length < 2) {
    showEmpty(isRead
      ? 'Type a title above, pick Manga / Manhwa / Webtoon / Novel, then tap Search.'
      : 'Type an anime name above, then tap Search.');
    return;
  }
  if (!list.length) {
    if (state.searchError) {
      showEmpty(`Search failed. Tap Search again.\n(${state.searchError})`);
      return;
    }
    showEmpty(isRead
      ? `No reading results for “${q}”. Try “All” or a shorter name.`
      : `No anime found for “${q}”. Check the spelling and try again.`);
    return;
  }
  showContent(`<div class="grid">${list.map(cardHtml).join('')}</div>`);
}

function updateSectionChrome() {
  const hints = {
    track: 'Track what’s airing',
    anime: 'Search & watch anime',
    read: 'Search & read books',
    saved: 'Favorites & finished',
    settings: 'Alerts & settings',
  };
  setText('#section-hint', hints[state.section] || 'Grey GodZilla');
  document.body.classList.remove('section-track', 'section-anime', 'section-read', 'section-saved', 'section-settings');
  document.body.classList.add(`section-${state.section}`);

  document.querySelectorAll('#bottom-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.section === state.section);
  });
  document.querySelectorAll('.section-panel').forEach((panel) => {
    const match = panel.dataset.section === state.section;
    panel.hidden = !match;
    panel.classList.toggle('active', match);
  });

  // Track chips
  document.querySelectorAll('#track-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.tab === state.trackTab);
  });
  // Saved chips
  document.querySelectorAll('#saved-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.tab === state.tab);
  });
  // Read media chips
  document.querySelectorAll('#read-media-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.readMedia === state.readMedia);
  });
  // Anime order chips
  document.querySelectorAll('#anime-sort-chips .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.animeOrder === state.filters.order_by);
  });

  // Sync legacy tab buttons for any code that still looks at .tab.active
  document.querySelectorAll('.legacy-hidden .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === state.tab);
  });
}

function setSection(section) {
  const next = String(section || 'track');
  state.section = next;

  if (next === 'track') {
    state.tab = state.trackTab || 'daily';
  } else if (next === 'anime') {
    state.tab = 'search';
    state.filters.media = 'anime';
    state.filters.type = 'any';
    state.filters.status = 'any';
    const animeInput = $('#search-anime');
    if (animeInput && state.search) animeInput.value = state.search;
    // Show last anime results or empty prompt
  } else if (next === 'read') {
    state.tab = 'search';
    applyReadMediaFilter(state.readMedia || 'all_print');
    const readInput = $('#search-read');
    if (readInput && state.search) readInput.value = state.search;
  } else if (next === 'saved') {
    if (state.tab !== 'favorites' && state.tab !== 'history') state.tab = 'favorites';
  } else if (next === 'settings') {
    state.tab = 'settings';
  }

  // Keep hidden filter controls in sync
  const fm = $('#filter-media');
  if (fm) fm.value = state.filters.media;
  const fo = $('#filter-order');
  if (fo) fo.value = state.filters.order_by;

  updateSectionChrome();
  render();
  // Lazy-load tracker data when opening track views
  if (next === 'track') ensureTabData(state.tab).then(() => render()).catch(() => {});
}

function applyReadMediaFilter(readMedia) {
  state.readMedia = readMedia || 'all_print';
  // all_print uses manga umbrella (API returns manga+manhwa+novels); we strip anime client-side
  if (state.readMedia === 'all_print') state.filters.media = 'manga';
  else state.filters.media = state.readMedia;
  state.filters.type = 'any';
  state.filters.status = 'any';
  const fm = $('#filter-media');
  if (fm) fm.value = state.filters.media;
}

function render() {
  if (state.loading.has(state.tab) && !state.loaded.has(state.tab) && state.section === 'track') {
    return;
  }

  // Settings always available
  if (state.section === 'settings' || state.tab === 'settings' || state.tab === 'webhooks') {
    setSubheader('<strong>⚙️ More</strong> · Alerts & app info');
    renderSettings();
    return;
  }

  if (state.section === 'anime' || state.section === 'read') {
    // Force search tab content
    state.tab = 'search';
    renderSearchResults();
    return;
  }

  if (state.section === 'saved') {
    if (state.tab === 'history') renderHistory();
    else renderFavorites();
    return;
  }

  // Tracker section
  switch (state.tab) {
    case 'daily': renderDaily(); break;
    case 'weekly':
      if (state.weekly) renderWeekly();
      else showLoading('Loading this week…');
      break;
    case 'monthly':
      if (state.monthly) renderMonthly();
      else showLoading('Loading this month…');
      break;
    case 'yearly':
      if (state.yearly) renderYearly();
      else showLoading(`Loading ${state.yearlyYear}…`);
      break;
    case 'now': renderSeason('now'); break;
    case 'upcoming': renderSeason('upcoming'); break;
    case 'favorites': renderFavorites(); break;
    case 'history': renderHistory(); break;
    case 'search': renderSearchResults(); break;
    default: renderDaily();
  }
}

async function loadLibrary() {
  const api = await waitForApi();
  if (!api) return;
  try {
    const [favorites, history] = await Promise.all([
      api.get_favorites?.() || [],
      api.get_history?.() || [],
    ]);
    state.favorites = favorites || [];
    state.history = history || [];
    updateStats();
  } catch {
    /* library optional on older builds */
  }
}

async function toggleFavorite(malId) {
  const api = await waitForApi();
  if (!api?.toggle_favorite) return;
  const anime = findAnimeById(malId) || { mal_id: malId };
  const result = await api.toggle_favorite(anime);
  if (result?.ok) {
    state.favorites = result.favorites || [];
    updateStats();
    showToast(result.favorited ? 'Added to favorites.' : 'Removed from favorites.');
    render();
  } else {
    showToast(result?.error || 'Could not update favorites.', 'err');
  }
}

async function toggleCompleted(malId) {
  const api = await waitForApi();
  if (!api) return;
  const anime = findAnimeById(malId) || { mal_id: malId };
  if (isCompleted(malId)) {
    const result = await api.remove_from_history(malId);
    if (result?.ok) {
      state.history = result.history || [];
      updateStats();
      showToast('Removed from history.');
      render();
    }
    return;
  }
  const result = await api.mark_completed(anime);
  if (result?.ok) {
    state.history = result.history || [];
    updateStats();
    showToast('Marked as completed.');
    render();
  } else {
    showToast(result?.error || 'Could not update history.', 'err');
  }
}

const ANIME_TYPE_OPTIONS = [
  ['any', 'All formats'],
  ['tv', 'TV'],
  ['movie', 'Movie'],
  ['ova', 'OVA'],
  ['ona', 'ONA'],
  ['special', 'Special'],
];

const MANGA_TYPE_OPTIONS = [
  ['any', 'All formats'],
  ['manga', 'Manga'],
  ['manhwa', 'Manhwa'],
  ['manhua', 'Manhua'],
  ['webtoon', 'Webtoon (Manhwa)'],
  ['one_shot', 'One-shot'],
  ['lightnovel', 'Light Novel'],
  ['novel', 'Novel'],
  ['doujinshi', 'Doujinshi'],
];

function sortForOrder(orderBy) {
  if (orderBy === 'title' || orderBy === 'popularity') return 'asc';
  return 'desc';
}

function syncFormatFilterOptions() {
  const media = $('#filter-media')?.value || 'all';
  const typeSel = $('#filter-type');
  if (!typeSel) return;
  let options;
  if (media === 'anime') options = ANIME_TYPE_OPTIONS;
  else if (media === 'novel') {
    options = [
      ['any', 'All formats'],
      ['novel', 'Novel'],
      ['lightnovel', 'Light Novel'],
    ];
  } else if (media === 'all') {
    options = [
      ['any', 'Any format'],
      ...ANIME_TYPE_OPTIONS.filter(([v]) => v !== 'any'),
      ...MANGA_TYPE_OPTIONS.filter(([v]) => v !== 'any'),
    ];
  } else {
    // manga / manhwa / webtoon / manhua
    options = MANGA_TYPE_OPTIONS;
  }
  const prev = typeSel.value;
  typeSel.innerHTML = options.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  // Always prefer "any" when switching media so filters don't break print searches
  if (options.some(([v]) => v === prev) && prev !== 'tv' && prev !== 'movie') {
    typeSel.value = prev;
  } else {
    typeSel.value = 'any';
  }
  const statusSel = $('#filter-status');
  if (statusSel) {
    const airingOpt = statusSel.querySelector('option[value="airing"]');
    if (airingOpt) {
      airingOpt.textContent = media === 'anime' ? 'Airing' : (media === 'all' ? 'Airing / Publishing' : 'Publishing');
    }
  }
}

function readSearchFilters() {
  state.filters = {
    media: $('#filter-media')?.value || 'all',
    type: $('#filter-type')?.value || 'any',
    status: $('#filter-status')?.value || 'any',
    order_by: $('#filter-order')?.value || 'popularity',
    min_score: Number($('#filter-score')?.value || 0),
  };
  return state.filters;
}

let searchDebounceTimer = null;

async function callSearchApi(api, q, media, opts) {
  media = String(media || 'all').toLowerCase();
  // Prefer multi-arg search_media; fall back to simpler signatures.
  if (api.search_media) {
    try {
      return await api.search_media(
        q,
        media,
        opts.limit,
        opts.type || '',
        opts.status || '',
        opts.order_by || 'popularity',
        opts.sort || 'desc',
        opts.min_score || 0,
      );
    } catch (err) {
      // fall through
      console.warn('search_media failed', err);
    }
  }
  if (api.search) {
    try { return await api.search(q, media, opts.limit); } catch { /* */ }
  }
  if (media === 'anime' && api.search_anime) {
    try { return await api.search_anime(q, opts.limit); } catch { /* */ }
  }
  if (media !== 'anime' && api.search_manga) {
    try { return await api.search_manga(q, opts.limit, media); } catch { /* */ }
  }
  return { data: [], error: 'search_unavailable', query: q, media };
}

async function runDatabaseSearch(forceTab = true) {
  // Prefer the visible search box for the active section
  let q = state.search || '';
  if (state.section === 'anime') q = ($('#search-anime')?.value || q).trim();
  else if (state.section === 'read') q = ($('#search-read')?.value || q).trim();
  else q = ($('#search')?.value || q).trim();
  state.search = q;
  const hidden = $('#search');
  if (hidden) hidden.value = q;

  // Lock filters to the current section so users can't mix modes by accident
  if (state.section === 'anime') {
    state.filters.media = 'anime';
    state.filters.type = 'any';
    state.filters.status = 'any';
  } else if (state.section === 'read') {
    applyReadMediaFilter(state.readMedia || 'all_print');
  }

  const filters = { ...state.filters, ...readSearchFilters(), media: state.filters.media };
  // Section overrides win
  if (state.section === 'anime') filters.media = 'anime';
  if (state.section === 'read') {
    applyReadMediaFilter(state.readMedia || 'all_print');
    filters.media = state.filters.media;
  }
  state.filters = filters;
  const fm = $('#filter-media');
  if (fm) fm.value = filters.media;

  if (q.length < 2) {
    state.searchResults = [];
    state.searchError = null;
    if (forceTab) {
      state.tab = 'search';
      updateSectionChrome();
    }
    renderSearchResults();
    return;
  }

  const api = await waitForApi();
  if (!api) {
    showToast('App not ready — close and reopen.', 'err');
    return;
  }
  if (!api.search_media && !api.search_anime && !api.search) {
    showToast('Search not available in this build.', 'err');
    return;
  }

  const requestId = (state.searchRequestId = (state.searchRequestId || 0) + 1);
  state.searchLoading = true;
  state.searchError = null;
  state.tab = 'search';
  updateSectionChrome();
  renderSearchResults();
  setStatus('Searching...', 'loading');

  try {
    const opts = {
      limit: 36,
      type: '',
      status: '',
      order_by: filters.order_by || 'popularity',
      sort: sortForOrder(filters.order_by),
      min_score: 0,
    };

    let mediaKey = filters.media || 'anime';
    // "all print" → broad search then strip anime
    const wantAllPrint = state.section === 'read' && (state.readMedia === 'all_print');
    if (wantAllPrint) mediaKey = 'all';

    let result = await callSearchApi(api, q, mediaKey, opts);
    if (!result?.data?.length) {
      result = await callSearchApi(api, q, mediaKey, { ...opts, order_by: 'score' }) || result;
    }
    if (!result?.data?.length && state.section === 'read' && mediaKey !== 'manga') {
      const mangaPass = await callSearchApi(api, q, 'manga', opts);
      if (mangaPass?.data?.length) result = mangaPass;
    }
    if (!result?.data?.length && state.section === 'anime') {
      result = await callSearchApi(api, q, 'anime', opts) || result;
    }

    if (requestId !== state.searchRequestId) return;

    let rows = (result?.data || []).filter(Boolean);
    if (state.section === 'anime') rows = rows.filter((i) => !isPrintMedia(i));
    if (state.section === 'read') rows = rows.filter((i) => isPrintMedia(i));

    state.searchResults = rows;
    state.searchError = rows.length ? null : (result?.error || null);
    state.searchSource = result?.source || '';
    state.searchLoading = false;
    if (state.searchError && !rows.length) {
      setStatus('Search error', '');
      showToast('Search failed — tap Search again.', 'err');
    } else {
      setStatus('Ready', 'ready');
      if (!rows.length) showToast(`Nothing found for “${q}”.`, '');
      else showToast(`Found ${rows.length}`, 'ok');
    }
    renderSearchResults();
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    state.searchLoading = false;
    const raw = err?.message || String(err);
    const friendly = /textContent|null|undefined/i.test(raw)
      ? 'Search glitch — tap Search again.'
      : raw;
    state.searchError = friendly;
    state.searchResults = [];
    setStatus('Error', '');
    showToast(friendly, 'err');
    renderSearchResults();
  }
}

function scheduleDatabaseSearch() {
  clearTimeout(searchDebounceTimer);
  // Slightly longer debounce on mobile so mid-typing requests don't stack
  searchDebounceTimer = setTimeout(() => {
    if ((state.search || '').trim().length >= 2 && state.tab === 'search') {
      runDatabaseSearch(false);
    }
  }, 650);
}

async function openMonthDetail(year, month, focusDay = null) {
  const api = await waitForApi();
  if (!api?.get_monthly) return;
  showLoading(`Loading ${month}/${year} releases...`);
  setStatus('Loading month...', 'loading');
  try {
    state.monthly = await api.get_monthly(year, month);
    state.loaded.add('monthly');
    state.tab = 'monthly';
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === 'monthly');
    });
    setStatus('Ready', 'ready');
    renderMonthly();
    updateStats();
    if (focusDay) {
      showDayPremiereDetail(Number(focusDay));
    }
  } catch (err) {
    showError(err.message || 'Could not load month.');
  }
}

function showDayPremiereDetail(day) {
  const m = state.monthly;
  if (!m || !day) return;
  const drops = monthDayDrops(m, day, state.search.trim().toLowerCase());
  if (!drops.length) {
    showToast(`No releases on day ${day}.`, '');
    return;
  }
  const listHtml = drops.map((a) => {
    const ep = a.next_episode ? `Episode ${a.next_episode}` : (a.episode_label || '');
    const time = a.broadcast_time || '';
    const extra = [time, ep].filter(Boolean).join(' · ');
    return `
      <div class="history-wrap">
        ${detailRow(a)}
        ${extra ? `<div class="history-meta">${escapeHtml(extra)}</div>` : ''}
      </div>
    `;
  }).join('');
  setSubheader(
    `<strong>${m.month_name} ${day}, ${m.year}</strong> · ${drops.length} release${drops.length === 1 ? '' : 's'} · <button type="button" class="linkish-btn" id="back-to-month-btn">← Full month</button>`,
  );
  showContent(`
    <div class="day-detail-panel">
      <div class="month-header">
        <h2>${m.month_name} ${day}</h2>
        <div class="month-stats">${drops.length} episode drop${drops.length === 1 ? '' : 's'}</div>
      </div>
      <div class="detail-list">${listHtml}</div>
    </div>
  `);
  $('#back-to-month-btn')?.addEventListener('click', () => renderMonthly());
}

async function loadBootstrap(force = false) {
  const api = await waitForApi();
  if (!api?.get_bootstrap) throw new Error('App API not available');

  setStatus('Loading today...', 'loading');
  if (state.section === 'track') {
    showLoading('Loading today’s episode drops…');
  }

  const data = force && api.get_bootstrap.length
    ? await api.get_bootstrap(true)
    : await api.get_bootstrap(force);
  state.bootstrap = data;
  state.loaded.add('daily');
  state.loaded.add('now');
  state.loaded.add('upcoming');

  setText('#count-now', data.now?.length ?? 0);
  setText('#count-upcoming', data.upcoming?.length ?? 0);
  setText('#count-daily', data.today?.length ?? 0);
  setText('#last-updated', data.stale
    ? `Cached: ${new Date().toLocaleString()}`
    : `Updated: ${new Date().toLocaleString()}`);
  updateStats();

  const hasAny = (data.now?.length || 0) + (data.today?.length || 0) + (data.upcoming?.length || 0);
  if (!hasAny && data.error) {
    // Still render empty states instead of hard-crashing the whole Track tab
    setStatus('Partial', 'loading');
    showToast(`Schedule load issue: ${data.error}`, 'err');
  } else {
    noteStale(data, 'Today');
    if (!data.stale && !data.offline) setStatus('Ready', 'ready');
  }

  // Always paint Track after bootstrap (even if empty)
  if (state.section === 'track' || !state.section) {
    state.section = 'track';
    state.tab = state.trackTab || 'daily';
  }
  updateSectionChrome();
  render();

  // Stagger background loads so AniList is less likely to rate-limit on mobile data
  setTimeout(() => loadWeeklyBackground(force), 400);
  setTimeout(() => loadMonthlyBackground(force), 1400);
  setTimeout(() => loadYearlyBackground(true), 2400);
  startDailyRefreshWatcher();
}

async function loadWeeklyBackground(force = false) {
  if (state.loading.has('weekly')) return;
  if (state.weekly && !force) return;
  state.loading.add('weekly');
  setStatus('Syncing week...', 'loading');

  try {
    const api = await waitForApi();
    const data = api.get_weekly.length
      ? await api.get_weekly(force)
      : await api.get_weekly();
    const total = Object.values(data.schedule || {}).reduce((n, arr) => n + arr.length, 0);
    if (!total && data.error && !data.stale && !state.weekly) {
      throw new Error(String(data.error));
    }
    state.weekly = data;
    state.loaded.add('weekly');
    setText('#count-weekly', total);
    updateStats();
    noteStale(data, 'Week');
    if (state.tab === 'weekly') render();
    if (!data.stale && !data.offline) setStatus('Ready', 'ready');
  } catch (err) {
    if (state.tab === 'weekly' && !state.weekly) {
      showError(`Weekly schedule failed: ${err.message}`);
    } else {
      showToast(`Week sync: ${err.message}`, 'err');
      setStatus('Ready', 'ready');
    }
  } finally {
    state.loading.delete('weekly');
  }
}

async function loadMonthlyBackground(force = false) {
  if (state.loading.has('monthly')) return;
  if (state.monthly && !force) return;
  state.loading.add('monthly');

  try {
    const api = await waitForApi();
    const data = await api.get_monthly();
    const count = data.release_count || data.premieres?.length || 0;
    if (!count && data.error && !data.stale && !state.monthly) {
      throw new Error(String(data.error));
    }
    state.monthly = data;
    state.loaded.add('monthly');
    setText('#count-monthly', count);
    updateStats();
    noteStale(data, 'Month');
    if (state.tab === 'monthly') render();
  } catch (err) {
    if (state.tab === 'monthly' && !state.monthly) {
      showError(`Monthly view failed: ${err.message}`);
    } else {
      showToast(`Month sync: ${err.message}`, 'err');
    }
  } finally {
    state.loading.delete('monthly');
  }
}

async function loadYearlyBackground(force = false) {
  if (!force && (state.loading.has('yearly') || state.yearly)) return;
  state.loading.add('yearly');

  try {
    const api = await waitForApi();
    const data = await api.get_yearly(state.yearlyYear);
    const total = (data.premieres?.length || 0) + (data.announced_tba?.length || 0);
    if (!total && !data.total && data.error && !data.stale && !state.yearly) {
      throw new Error(String(data.error));
    }
    state.yearly = data;
    state.loaded.add('yearly');
    setText('#count-yearly', total || data.total || '—');
    updateStats();
    noteStale(data, 'Year');
    if (state.tab === 'yearly') render();
  } catch (err) {
    if (state.tab === 'yearly' && !state.yearly) {
      showError(`Yearly view failed: ${err.message}`);
    } else {
      showToast(`Year sync: ${err.message}`, 'err');
    }
  } finally {
    state.loading.delete('yearly');
  }
}

async function forceRefreshAll() {
  const api = await waitForApi();
  const btn = $('#refresh-btn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
  setStatus('Refreshing...', 'loading');
  showToast('Refreshing schedules…', '');
  try {
    let result = null;
    if (api?.refresh_all_data) {
      result = await api.refresh_all_data(true);
    }
    if (result?.bootstrap) {
      state.bootstrap = result.bootstrap;
    } else {
      await loadBootstrap(true);
    }
    state.weekly = result?.weekly || null;
    state.monthly = result?.monthly || null;
    state.yearly = result?.yearly || null;
    state.loaded.clear();
    state.loaded.add('daily');
    state.loaded.add('now');
    state.loaded.add('upcoming');
    if (state.weekly) state.loaded.add('weekly');
    if (state.monthly) state.loaded.add('monthly');
    if (state.yearly) state.loaded.add('yearly');
    setText('#last-updated', `Updated: ${new Date().toLocaleString()}`);
    state.refreshDate = result?.today || null;
    updateStats();
    await Promise.all([
      state.weekly ? Promise.resolve() : loadWeeklyBackground(true),
      state.monthly ? Promise.resolve() : loadMonthlyBackground(true),
      state.yearly ? Promise.resolve() : loadYearlyBackground(true),
    ]);
    setStatus('Ready', 'ready');
    const weekN = state.weekly
      ? Object.values(state.weekly.schedule || {}).reduce((n, arr) => n + (arr?.length || 0), 0)
      : 0;
    const monthN = state.monthly?.release_count
      || (state.monthly?.premieres?.length || 0);
    showToast(
      `Refreshed · ${state.bootstrap?.today?.length || 0} today · ${weekN} this week · ${monthN} this month`,
      'ok',
    );
    state.section = 'track';
    state.tab = state.trackTab || 'daily';
    updateSectionChrome();
    render();
  } catch (err) {
    setStatus('Error', '');
    showToast(err.message || 'Refresh failed.', 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function checkDailyRefresh() {
  const api = await waitForApi();
  if (!api?.get_refresh_status) return;

  const status = await api.get_refresh_status();
  const today = status.today || todayKey();
  if (state.refreshDate && state.refreshDate === today) return;

  if (state.refreshDate && state.refreshDate !== today) {
    await forceRefreshAll();
    return;
  }

  state.refreshDate = today;
}

function startDailyRefreshWatcher() {
  state.refreshDate = todayKey();
  checkDailyRefresh();
  setInterval(checkDailyRefresh, DAILY_REFRESH_CHECK_MS);
}

async function ensureTabData(tab) {
  try {
    if (tab === 'weekly' && !state.weekly) {
      showLoading('Loading weekly schedule...');
      await loadWeeklyBackground();
    }
    if (tab === 'monthly' && !state.monthly) {
      showLoading('Loading monthly calendar...');
      await loadMonthlyBackground();
    }
    if (tab === 'yearly' && !state.yearly) {
      showLoading(`Loading ${state.yearlyYear} releases...`);
      await loadYearlyBackground(true);
    }
  } catch (err) {
    // Keep previous tab content when possible — don't hard-crash on flaky AniList
    if (!state.bootstrap) showError(err.message || 'Connection failed');
    else showToast(err.message || 'Could not load tab', 'err');
  }
}

function setTab(tab) {
  state.tab = tab;
  if (['daily', 'weekly', 'monthly', 'now', 'upcoming', 'yearly'].includes(tab)) {
    state.trackTab = tab;
    state.section = 'track';
  } else if (tab === 'favorites' || tab === 'history') {
    state.section = 'saved';
  } else if (tab === 'search') {
    // keep current anime/read section
    if (state.section !== 'anime' && state.section !== 'read') state.section = 'anime';
  } else if (tab === 'settings' || tab === 'webhooks') {
    state.section = 'settings';
  }

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  updateSectionChrome();

  ensureTabData(tab)
    .then(() => render())
    .catch((err) => {
      if (!state.bootstrap) showError(err.message || 'Connection failed');
      else showToast(err.message || 'Tab load failed', 'err');
    });
}

function setStreamStatus(message, kind = '') {
  const el = $('#stream-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = `stream-status ${kind}`.trim();
}

function renderStreamEpisodes() {
  const wrap = $('#stream-episodes');
  if (!wrap) return;
  const current = state.stream.currentEp;
  wrap.innerHTML = (state.stream.episodes || []).map((ep) => `
    <button type="button" class="stream-ep-btn ${current === ep.episode ? 'active' : ''}"
      data-stream-ep="${ep.episode}" data-stream-hash="${ep.gate_hash}">
      Ep ${ep.episode}
    </button>
  `).join('');
  wrap.querySelectorAll('[data-stream-hash]').forEach((btn) => {
    btn.addEventListener('click', () => playStreamEpisode(Number(btn.dataset.streamEp), btn.dataset.streamHash));
  });
}

function stopProgressTracking() {
  if (state.stream.progressTimer) {
    clearInterval(state.stream.progressTimer);
    state.stream.progressTimer = null;
  }
}

async function flushWatchProgress() {
  const api = await waitForApi();
  const video = $('#stream-video');
  const anime = state.stream.anime;
  const ep = state.stream.currentEp;
  if (!api?.save_watch_progress || !video || !anime?.mal_id || !ep) return;
  if (!video.duration || Number.isNaN(video.duration)) return;
  try {
    await api.save_watch_progress(
      anime.mal_id,
      ep,
      video.currentTime,
      video.duration,
      titleOf(anime),
    );
  } catch {
    /* best-effort */
  }
}

function startProgressTracking() {
  stopProgressTracking();
  state.stream.progressTimer = setInterval(() => {
    flushWatchProgress();
  }, 5000);
}

function exitStreamFullscreen() {
  const overlay = $('#stream-overlay');
  overlay?.classList.remove('is-fullscreen');
  document.body.classList.remove('stream-fullscreen');
  const btn = $('#stream-fullscreen-btn');
  if (btn) btn.textContent = '⛶ Full';
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

async function toggleStreamFullscreen() {
  // Android WebView often blocks the Fullscreen API — CSS immersive mode always works.
  const overlay = $('#stream-overlay');
  const panel = $('#stream-panel') || overlay;
  if (!overlay) return;

  const isFs = overlay.classList.contains('is-fullscreen') || document.body.classList.contains('stream-fullscreen');
  if (isFs) {
    exitStreamFullscreen();
    return;
  }

  overlay.classList.add('is-fullscreen');
  document.body.classList.add('stream-fullscreen');
  const btn = $('#stream-fullscreen-btn');
  if (btn) btn.textContent = '⛶ Exit';

  // Best-effort native fullscreen on top of CSS mode
  try {
    const target = panel || overlay;
    if (target.requestFullscreen) await target.requestFullscreen();
    else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
  } catch {
    /* CSS mode is enough */
  }
}

function closeStreamOverlay() {
  flushWatchProgress();
  stopProgressTracking();
  exitStreamFullscreen();
  const overlay = $('#stream-overlay');
  const video = $('#stream-video');
  if (video) {
    video.pause();
    video.onloadedmetadata = null;
    video.ontimeupdate = null;
    video.removeAttribute('src');
    video.load();
  }
  state.stream = {
    open: false, anime: null, ahId: null, episodes: [],
    currentEp: null, loading: false, error: null, progressTimer: null,
  };
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function getAhPlayer() {
  try {
    return window.Capacitor?.Plugins?.AhPlayer || null;
  } catch {
    return null;
  }
}

function setReaderStatus(message, kind = '') {
  const el = $('#reader-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = `stream-status ${kind}`.trim();
}

function closeReaderOverlay() {
  state.reader = {
    open: false,
    item: null,
    mdId: null,
    chapters: [],
    currentChapter: null,
    pages: [],
    loading: false,
    error: null,
    dataSaver: state.reader?.dataSaver !== false,
    mode: 'chapters',
  };
  const overlay = $('#reader-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }
  const pages = $('#reader-pages');
  if (pages) {
    pages.innerHTML = '';
    pages.classList.add('hidden');
  }
  const ch = $('#reader-chapters');
  if (ch) ch.classList.remove('hidden');
}

function renderReaderChapters() {
  const list = state.reader.chapters || [];
  const wrap = $('#reader-chapters');
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<p class="week-empty">No English chapters found yet for this title.</p>';
    return;
  }
  const cur = state.reader.currentChapter?.chapter_id;
  wrap.innerHTML = list.map((c) => {
    const label = escapeHtml(c.title || (c.chapter != null ? `Chapter ${c.chapter}` : 'Chapter'));
    const meta = [
      c.chapter != null ? `Ch ${escapeHtml(String(c.chapter))}` : '',
      c.pages ? `${c.pages}p` : '',
      c.volume != null ? `Vol ${escapeHtml(String(c.volume))}` : '',
    ].filter(Boolean).join(' · ');
    return `<button type="button" class="reader-ch-btn ${cur === c.chapter_id ? 'active' : ''}"
      data-reader-chapter="${escapeHtml(c.chapter_id)}"
      data-reader-chapter-label="${escapeHtml(c.chapter != null ? String(c.chapter) : c.title || '')}">
      <span>${label}</span>
      <span class="ch-meta">${meta}</span>
    </button>`;
  }).join('');
}

function showReaderChapterList() {
  state.reader.mode = 'chapters';
  state.reader.pages = [];
  $('#reader-pages')?.classList.add('hidden');
  $('#reader-chapters')?.classList.remove('hidden');
  const pages = $('#reader-pages');
  if (pages) pages.innerHTML = '';
  setText('#reader-page-label', `${state.reader.chapters.length} chapter(s)`);
  setReaderStatus('Pick a chapter to read in-app.');
  renderReaderChapters();
}

async function openReaderChapter(chapterId, chapterLabel, { autoAdvance = true } = {}) {
  const api = await waitForApi();
  if (!api?.get_reader_pages) {
    setReaderStatus('Reader API unavailable in this build.', 'err');
    return;
  }
  const chapter = (state.reader.chapters || []).find((c) => c.chapter_id === chapterId)
    || { chapter_id: chapterId, chapter: chapterLabel, title: chapterLabel };
  state.reader.currentChapter = chapter;
  state.reader.loading = true;
  state.reader.mode = 'pages';
  setReaderStatus(`Loading chapter${chapterLabel ? ` ${chapterLabel}` : ''}…`);
  $('#reader-chapters')?.classList.add('hidden');
  const pagesEl = $('#reader-pages');
  if (pagesEl) {
    pagesEl.classList.remove('hidden');
    pagesEl.innerHTML = '<p class="stream-subtitle" style="padding:1rem;text-align:center;">Loading pages…</p>';
  }
  renderReaderChapters();

  try {
    let result = await api.get_reader_pages(chapterId, { dataSaver: state.reader.dataSaver !== false });
    // Retry opposite quality if empty
    if ((!result?.pages?.length)) {
      result = await api.get_reader_pages(chapterId, { dataSaver: !(state.reader.dataSaver !== false) });
    }
    state.reader.loading = false;
    if (!result?.ok || !(result.pages || []).length) {
      // Auto-skip broken/licensed-empty chapters
      if (autoAdvance) {
        const idx = (state.reader.chapters || []).findIndex((c) => c.chapter_id === chapterId);
        const next = idx >= 0 ? state.reader.chapters[idx + 1] : null;
        if (next) {
          setReaderStatus('Chapter unavailable — trying next…');
          await openReaderChapter(next.chapter_id, next.chapter ?? next.title, { autoAdvance: true });
          return;
        }
      }
      setReaderStatus(result?.error || 'No pages for this chapter.', 'err');
      if (pagesEl) {
        pagesEl.innerHTML = `<p class="week-empty" style="padding:1rem;text-align:center;">${escapeHtml(result?.error || 'No pages')}<br><br>Try another chapter — some titles are official-only.</p>`;
      }
      return;
    }
    state.reader.pages = result.pages;
    setText('#reader-page-label', `Ch ${chapter.chapter ?? chapterLabel ?? '—'} · ${result.pages.length} pages`);
    setReaderStatus('Scroll to read · Next/Prev changes chapter');
    if (pagesEl) {
      pagesEl.innerHTML = result.pages.map((p) =>
        `<img src="${escapeHtml(p.url)}" alt="Page ${p.index}" loading="${p.index <= 3 ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer">`,
      ).join('');
      pagesEl.scrollTop = 0;
      $('#reader-body')?.scrollTo?.({ top: 0 });
    }
    try {
      await api.set_read_progress?.(state.reader.mdId, chapterId, chapter.chapter ?? chapterLabel, 1);
    } catch { /* optional */ }
  } catch (err) {
    state.reader.loading = false;
    setReaderStatus(err?.message || String(err), 'err');
  }
}

async function openReaderCatalogFallback(url, title) {
  const plugin = getAhPlayer();
  if (plugin?.openUrl && url) {
    try {
      await plugin.openUrl({ url, title: title || 'Read' });
      showToast('Opened catalog in-app browser', 'ok');
      return true;
    } catch { /* fall through */ }
  }
  return false;
}

function readerChapterIndex() {
  const id = state.reader.currentChapter?.chapter_id;
  if (!id) return -1;
  return (state.reader.chapters || []).findIndex((c) => c.chapter_id === id);
}

async function readerStep(delta) {
  const idx = readerChapterIndex();
  if (idx < 0) return;
  const next = state.reader.chapters[idx + delta];
  if (!next) {
    setReaderStatus(delta > 0 ? 'End of available chapters.' : 'Already on the first chapter.');
    return;
  }
  await openReaderChapter(next.chapter_id, next.chapter ?? next.title);
}

async function openReaderOverlay(item) {
  const api = await waitForApi();
  if (!api?.resolve_reader && !api?.search_reader) {
    showToast('Reader not available in this build.', 'err');
    return;
  }
  // Close stream if open
  try { closeStreamOverlay(); } catch { /* */ }

  state.reader.open = true;
  state.reader.item = item;
  state.reader.mdId = null;
  state.reader.chapters = [];
  state.reader.currentChapter = null;
  state.reader.pages = [];
  state.reader.loading = true;
  state.reader.mode = 'chapters';
  state.reader.error = null;

  const overlay = $('#reader-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
  }
  const title = titleOf(item);
  setText('#reader-title', title);
  setText('#reader-subtitle', 'Finding free chapters…');
  setText('#reader-page-label', '');
  setReaderStatus('Matching title for in-app reading…');
  const ch = $('#reader-chapters');
  if (ch) {
    ch.classList.remove('hidden');
    ch.innerHTML = '<p class="stream-subtitle" style="padding:0.8rem;text-align:center;">Searching free catalog…</p>';
  }
  $('#reader-pages')?.classList.add('hidden');
  const qBtn = $('#reader-quality-btn');
  if (qBtn) qBtn.textContent = state.reader.dataSaver !== false ? 'Data saver' : 'HQ';

  const titles = [
    item.title_english,
    item.title,
    item.title_japanese,
    ...(item.title_synonyms || []),
  ].filter(Boolean);

  try {
    let resolved = null;
    if (api.resolve_reader) {
      resolved = await api.resolve_reader(item.mal_id || item.anilist_id, titles, item.media);
    }
    if (!resolved?.ok) {
      // Fallback: direct search
      const hit = await api.search_reader?.(titles[0] || title, 8);
      const first = (hit?.data || [])[0];
      if (first?.md_id) {
        resolved = { ok: true, ...first };
      }
    }
    if (!resolved?.ok || !resolved.md_id) {
      state.reader.loading = false;
      setReaderStatus(resolved?.error || 'No readable match found.', 'err');
      setText('#reader-subtitle', 'Not available for in-app reading');
      if (ch) {
        ch.innerHTML = `<p class="week-empty" style="padding:1rem;text-align:center;">${escapeHtml(resolved?.error || 'No match')}<br><br>Try searching the English/romaji title.</p>`;
      }
      return;
    }

    state.reader.mdId = resolved.md_id;
    setText('#reader-title', resolved.title || title);
    setText('#reader-subtitle', `${resolved.media || item.media || 'manga'} · free in-app reader`);
    setReaderStatus('Loading chapter list…');

    const feed = await api.get_reader_chapters(resolved.md_id, { limit: 100, language: 'en' });
    state.reader.loading = false;
    state.reader.catalogUrl = feed?.catalog_url || resolved.url || `https://mangadex.org/title/${resolved.md_id}`;

    if (!feed?.ok || !(feed.chapters || []).length) {
      setReaderStatus(feed?.error || 'No chapters found for free in-app reading.', 'err');
      if (ch) {
        ch.innerHTML = `
          <p class="week-empty" style="padding:1rem;text-align:center;">
            ${escapeHtml(feed?.error || 'No chapters available')}<br><br>
            Some titles are official-only and can’t host pages here.<br>
            <button type="button" class="read-btn" id="reader-open-catalog-btn" style="margin-top:0.75rem;">Open catalog in-app</button>
          </p>`;
        $('#reader-open-catalog-btn')?.addEventListener('click', () => {
          openReaderCatalogFallback(state.reader.catalogUrl, resolved.title || title);
        });
      }
      return;
    }
    state.reader.chapters = feed.chapters;
    setText('#reader-page-label', `${feed.chapters.length} chapter(s)`);
    setReaderStatus('Tap a chapter to read in-app.');
    renderReaderChapters();

    // Resume last chapter if we have progress
    try {
      const prog = await api.get_read_progress?.(resolved.md_id);
      if (prog?.chapter_id && feed.chapters.some((c) => c.chapter_id === prog.chapter_id)) {
        setReaderStatus(`Resume available — last: Ch ${prog.chapter || prog.chapter_id}`);
      }
    } catch { /* optional */ }
  } catch (err) {
    state.reader.loading = false;
    setReaderStatus(err?.message || String(err), 'err');
  }
}

/** Always stays inside the app — never opens Chrome/system browser. */
async function openInAppPlayer({ gateHash = '', url = '', urls = [], title = 'Watch', referer = 'https://animeheaven.me/' } = {}) {
  const plugin = getAhPlayer();
  if (!plugin) return { ok: false, error: 'Native player not available' };

  // Preferred: native ExoPlayer with Referer (true in-app video)
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (url && !list.includes(url)) list.unshift(url);
  if (list.length && plugin.playNative) {
    await plugin.playNative({
      urls: list,
      url: list[0],
      referer: referer || 'https://animeheaven.me/',
      title: title || 'Watch',
    });
    return { ok: true, mode: 'native' };
  }

  // Fallback: in-app WebView with Grey GodZilla title bar (still our app)
  if (plugin.openEpisode) {
    await plugin.openEpisode({
      gateHash: gateHash || '',
      url: url || list[0] || '',
      title: title || 'Watch',
    });
    return { ok: true, mode: 'webview' };
  }
  return { ok: false, error: 'No in-app player methods' };
}

async function playStreamEpisode(episode, gateHash) {
  const api = await waitForApi();
  const video = $('#stream-video');
  const isNative = !!(getAhPlayer() || window.Capacitor?.isNativePlatform?.());

  await flushWatchProgress();
  stopProgressTracking();

  state.stream.currentEp = episode;
  state.stream.loading = true;
  renderStreamEpisodes();
  setStreamStatus(`Loading episode ${episode}…`);
  $('#stream-ep-label').textContent = `Episode ${episode}`;

  const showUrl = state.stream.showUrl || state.stream.ahUrl || '';
  const title = state.stream.anime ? titleOf(state.stream.anime) : 'Watch';
  const epTitle = `${title} · Ep ${episode}`;

  // Resolve stream URLs (with Referer-capable native player on Android)
  let result = null;
  if (api?.get_stream_sources) {
    try {
      result = await api.get_stream_sources(gateHash);
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
  }
  state.stream.loading = false;

  const candidates = [];
  const pushSrc = (u) => {
    if (u && !String(u).includes('&error') && !candidates.includes(u)) candidates.push(u);
  };
  if (result?.ok) {
    pushSrc(result.playback_url);
    pushSrc(result.primary);
    (result.sources || []).forEach(pushSrc);
  }

  // --- Android: always stay in-app ---
  if (isNative && getAhPlayer()) {
    try {
      if (candidates.length) {
        const opened = await openInAppPlayer({
          urls: candidates,
          title: epTitle,
          referer: result?.referer || 'https://animeheaven.me/',
          gateHash,
          url: showUrl,
        });
        if (opened.ok) {
          setStreamStatus(
            opened.mode === 'native'
              ? `Playing episode ${episode} in-app. Close player (X) to return.`
              : `Episode ${episode} in-app player. Close (X) to return.`,
          );
          try {
            await api?.set_watch_progress?.(state.stream.anime?.mal_id, episode, 1, 0);
          } catch { /* optional */ }
          return;
        }
      }
      // No CDN urls — still in-app WebView with cookie for gate.php
      await openInAppPlayer({ gateHash, url: showUrl, title: epTitle });
      setStreamStatus(`Episode ${episode} in-app. Close (X) to return.`);
      return;
    } catch (e) {
      setStreamStatus(`In-app player error: ${e?.message || e}`, 'err');
      return;
    }
  }

  // --- Desktop / web fallback: HTML5 video ---
  if (!candidates.length || !video) {
    setStreamStatus(result?.error || 'No playable sources for this episode.', 'err');
    return;
  }

  let resumeAt = 0;
  try {
    const saved = await api.get_watch_progress?.(state.stream.anime?.mal_id, episode);
    if (saved?.seconds && saved.seconds > 5) resumeAt = Number(saved.seconds);
  } catch { resumeAt = 0; }

  let srcIndex = 0;
  const tryPlay = async (idx) => {
    const src = candidates[idx];
    if (!src) {
      setStreamStatus('Playback failed for this episode.', 'err');
      return;
    }
    video.removeAttribute('crossorigin');
    video.setAttribute('playsinline', '');
    video.src = src;
    video.load();
    try {
      await video.play();
      if (!resumeAt) setStreamStatus(`Now playing episode ${episode}`);
      startProgressTracking();
    } catch {
      setStreamStatus('Press play to start.', '');
      startProgressTracking();
    }
  };
  video.onerror = () => {
    srcIndex += 1;
    if (srcIndex < candidates.length) tryPlay(srcIndex);
    else setStreamStatus('Playback failed for this episode.', 'err');
  };
  video.onloadedmetadata = () => {
    if (resumeAt > 0 && resumeAt < (video.duration || Infinity) - 15) {
      video.currentTime = resumeAt;
    }
  };
  await tryPlay(0);
}

async function openStreamOverlay(anime) {
  const api = await waitForApi();
  if (!api?.resolve_stream) {
    showToast('Streaming API not available.', 'err');
    return;
  }

  const overlay = $('#stream-overlay');
  const title = titleOf(anime);
  $('#stream-title').textContent = title;
  $('#stream-subtitle').textContent = 'Finding on AnimeHeaven.me...';
  setStreamStatus('Searching AnimeHeaven...');
  overlay?.classList.remove('hidden');
  overlay?.setAttribute('aria-hidden', 'false');

  state.stream = {
    open: true,
    anime,
    ahId: null,
    episodes: [],
    currentEp: null,
    loading: true,
    error: null,
  };
  renderStreamEpisodes();

  const titles = [
    anime.title_english,
    anime.title,
    anime.title_japanese,
    ...(anime.title_synonyms || []),
  ].filter(Boolean);

  const resolved = await api.resolve_stream(anime.mal_id, titles);
  state.stream.loading = false;

  if (!resolved?.ok) {
    setStreamStatus(resolved?.error || 'Show not found on AnimeHeaven.', 'err');
    $('#stream-subtitle').textContent = 'No match found';
    return;
  }

  state.stream.ahId = resolved.ah_id;
  state.stream.episodes = resolved.episodes || [];
  state.stream.showUrl = resolved.url || (resolved.ah_id ? `https://animeheaven.me/anime.php?${resolved.ah_id}` : '');
  state.stream.ahUrl = state.stream.showUrl;
  $('#stream-title').textContent = resolved.title || title;
  $('#stream-subtitle').textContent = resolved.title_japanese || 'AnimeHeaven.me (free player)';
  const ahLink = $('#stream-ah-link');
  if (ahLink) {
    ahLink.href = state.stream.showUrl || 'https://animeheaven.me';
    ahLink.textContent = 'Open full show on AnimeHeaven.me';
    ahLink.onclick = (e) => {
      if (getAhPlayer()) {
        e.preventDefault();
        openInAppPlayer({ url: state.stream.showUrl, title: resolved.title || title });
      }
    };
  }

  if (!state.stream.episodes.length) {
    setStreamStatus('Matched show but no episodes listed yet.', 'err');
    return;
  }

  renderStreamEpisodes();

  // Resume the last watched episode when progress exists; otherwise play latest.
  let target = state.stream.episodes[0];
  try {
    const last = await api.get_last_watch_progress?.(anime.mal_id);
    if (last?.episode) {
      const match = state.stream.episodes.find((ep) => Number(ep.episode) === Number(last.episode));
      if (match) target = match;
    }
  } catch {
    /* fall through to latest */
  }
  await playStreamEpisode(target.episode, target.gate_hash);
}

async function loadAppInfo() {
  try {
    const api = await waitForApi();
    if (api?.get_app_info) {
      const info = await api.get_app_info();
      if (info?.version) {
        const ver = `v${info.version}`;
        const badge = $('#version-badge');
        if (badge) badge.textContent = ver;
        const footVer = $('#footer-version');
        if (footVer) footVer.textContent = ver;
        const line = $('#app-version-line');
        // Keep in-app branding as Grey GodZilla Anime App (launcher is GGZ Anime)
        if (line) {
          line.innerHTML = `<strong>Grey GodZilla Anime App</strong> · ${escapeHtml(ver)}`;
        }
        document.title = `Grey GodZilla Anime App ${ver}`;
        const h1 = document.querySelector('.brand-text h1');
        if (h1) h1.textContent = 'Grey GodZilla Anime App';
        const aboutVer = $('#settings-version');
        if (aboutVer) aboutVer.textContent = ver;
      }
    }
  } catch {
    /* keep default badge */
  }
}

function init() {
  loadAppInfo();
  loadWebhookData().then(() => {
    const cw = $('#count-webhooks');
    if (cw) cw.textContent = state.watchlist.length;
    syncLocalNotifications().catch(() => {});
  });
  loadLibrary().then(() => {
    syncLocalNotifications().catch(() => {});
  });

  $('#refresh-btn')?.addEventListener('click', () => forceRefreshAll());

  document.body.addEventListener('click', (e) => {
    // Per-title actions inside month cards take priority over opening the month.
    if (e.target.closest('[data-ah-mal-id], [data-watch-mal-id], a')) {
      /* handled below */
    } else {
      const openMonth = e.target.closest('[data-open-month]');
      if (openMonth) {
        e.preventDefault();
        e.stopPropagation();
        openMonthDetail(Number(openMonth.dataset.openYear), Number(openMonth.dataset.openMonth));
        return;
      }
    }

    const monthDay = e.target.closest('[data-month-day]');
    if (monthDay && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      showDayPremiereDetail(Number(monthDay.dataset.monthDay));
      return;
    }

    const watchBtn = e.target.closest('[data-watch-mal-id]');
    if (watchBtn) {
      e.preventDefault();
      e.stopPropagation();
      const malId = Number(watchBtn.dataset.watchMalId);
      const anime = findAnimeById(malId) || {
        mal_id: malId,
        title: watchBtn.dataset.watchTitle,
      };
      openStreamOverlay(anime);
      return;
    }

    const readBtn = e.target.closest('[data-read-mal-id]');
    if (readBtn) {
      e.preventDefault();
      e.stopPropagation();
      const malId = Number(readBtn.dataset.readMalId) || readBtn.dataset.readMalId;
      const item = findAnimeById(malId) || {
        mal_id: malId,
        title: readBtn.dataset.readTitle,
        media: 'manga',
      };
      // Ensure print media so reader path is used
      if (!item.media || item.media === 'anime') item.media = 'manga';
      openReaderOverlay(item);
      return;
    }

    const readerCh = e.target.closest('[data-reader-chapter]');
    if (readerCh) {
      e.preventDefault();
      e.stopPropagation();
      openReaderChapter(readerCh.dataset.readerChapter, readerCh.dataset.readerChapterLabel);
      return;
    }

    const favBtn = e.target.closest('[data-fav-id]');
    if (favBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(Number(favBtn.dataset.favId));
      return;
    }

    const completeBtn = e.target.closest('[data-complete-id]');
    if (completeBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleCompleted(Number(completeBtn.dataset.completeId));
      return;
    }

    const trackBtn = e.target.closest('[data-track-id]');
    if (trackBtn) {
      e.preventDefault();
      e.stopPropagation();
      trackAnime(Number(trackBtn.dataset.trackId));
      return;
    }

    const ahItem = e.target.closest('[data-ah-mal-id]');
    if (ahItem) {
      e.preventDefault();
      e.stopPropagation();
      const malId = Number(ahItem.dataset.ahMalId);
      const anime = findAnimeById(malId) || {
        mal_id: malId,
        title: ahItem.dataset.ahTitle,
      };
      openAnimeHeavenExternal(anime, ahItem);
    }
  });

  $('#stream-close-btn')?.addEventListener('click', closeStreamOverlay);
  $('#stream-fullscreen-btn')?.addEventListener('click', toggleStreamFullscreen);
  $('#stream-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'stream-overlay') closeStreamOverlay();
  });

  $('#reader-close-btn')?.addEventListener('click', closeReaderOverlay);
  $('#reader-back-btn')?.addEventListener('click', () => showReaderChapterList());
  $('#reader-prev-btn')?.addEventListener('click', () => readerStep(-1));
  $('#reader-next-btn')?.addEventListener('click', () => readerStep(1));
  $('#reader-quality-btn')?.addEventListener('click', async () => {
    state.reader.dataSaver = !(state.reader.dataSaver !== false);
    const qBtn = $('#reader-quality-btn');
    if (qBtn) qBtn.textContent = state.reader.dataSaver ? 'Data saver' : 'HQ';
    if (state.reader.mode === 'pages' && state.reader.currentChapter) {
      await openReaderChapter(
        state.reader.currentChapter.chapter_id,
        state.reader.currentChapter.chapter ?? state.reader.currentChapter.title,
      );
    } else {
      showToast(state.reader.dataSaver ? 'Data saver pages on' : 'HQ pages on', 'ok');
    }
  });
  $('#reader-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'reader-overlay') closeReaderOverlay();
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      $('#stream-overlay')?.classList.remove('is-fullscreen');
      document.body.classList.remove('stream-fullscreen');
    } else {
      $('#stream-overlay')?.classList.add('is-fullscreen');
      document.body.classList.add('stream-fullscreen');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (state.reader.open) {
      if (e.key === 'Escape') {
        if (state.reader.mode === 'pages') showReaderChapterList();
        else closeReaderOverlay();
      }
      if (e.key === 'ArrowRight') readerStep(1);
      if (e.key === 'ArrowLeft') readerStep(-1);
      return;
    }
    if (!state.stream.open) return;
    if (e.key === 'Escape') {
      if (document.fullscreenElement || $('#stream-overlay')?.classList.contains('is-fullscreen')) {
        exitStreamFullscreen();
      } else {
        closeStreamOverlay();
      }
    }
    if (e.key === 'f' || e.key === 'F') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      e.preventDefault();
      toggleStreamFullscreen();
    }
  });

  // Bottom navigation — main app modes
  document.querySelectorAll('#bottom-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setSection(btn.dataset.section));
  });

  // Tracker chips
  document.querySelectorAll('#track-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.section = 'track';
      setTab(chip.dataset.tab);
    });
  });

  // Saved chips
  document.querySelectorAll('#saved-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.section = 'saved';
      setTab(chip.dataset.tab);
    });
  });

  // Reading type chips
  document.querySelectorAll('#read-media-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      applyReadMediaFilter(chip.dataset.readMedia);
      updateSectionChrome();
      if ((state.search || '').trim().length >= 2 && state.section === 'read') {
        runDatabaseSearch(false);
      }
    });
  });

  // Anime sort chips
  document.querySelectorAll('#anime-sort-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filters.order_by = chip.dataset.animeOrder || 'popularity';
      const fo = $('#filter-order');
      if (fo) fo.value = state.filters.order_by;
      updateSectionChrome();
      if ((state.search || '').trim().length >= 2 && state.section === 'anime') {
        runDatabaseSearch(false);
      }
    });
  });

  // Legacy tab buttons (hidden) still work
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  // Anime search box
  const bindSearchBox = (inputSel, goSel) => {
    const input = $(inputSel);
    const go = $(goSel);
    input?.addEventListener('input', (e) => {
      state.search = e.target.value;
      const hidden = $('#search');
      if (hidden) hidden.value = state.search;
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runDatabaseSearch(true);
      }
    });
    go?.addEventListener('click', () => runDatabaseSearch(true));
  };
  bindSearchBox('#search-anime', '#search-anime-go');
  bindSearchBox('#search-read', '#search-read-go');

  // Hidden legacy search (kept for desktop/compat)
  $('#search')?.addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.tab === 'search') scheduleDatabaseSearch();
    else if (state.section === 'track') render();
  });
  $('#search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runDatabaseSearch(true);
    }
  });
  $('#search-go-btn')?.addEventListener('click', () => runDatabaseSearch(true));
  syncFormatFilterOptions();

  // Keyboard activation for year-month cards and calendar days.
  document.body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const openMonth = e.target.closest?.('[data-open-month]');
    if (openMonth && !e.target.closest('[data-ah-mal-id]')) {
      e.preventDefault();
      openMonthDetail(Number(openMonth.dataset.openYear), Number(openMonth.dataset.openMonth));
      return;
    }
    const monthDay = e.target.closest?.('[data-month-day]');
    if (monthDay) {
      e.preventDefault();
      showDayPremiereDetail(Number(monthDay.dataset.monthDay));
    }
  });

  $('#retry-btn').addEventListener('click', () => {
    state.weekly = null;
    state.monthly = null;
    state.yearly = null;
    state.bootstrap = null;
    state.loaded.clear();
    state.loading.clear();
    loadBootstrap().catch((err) => showError(err.message));
  });

  // Start on Tracker with a clear chrome state
  updateSectionChrome();
  loadBootstrap().catch((err) => showError(err.message));
}

document.addEventListener('DOMContentLoaded', init);