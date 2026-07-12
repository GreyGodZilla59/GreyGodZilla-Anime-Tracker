const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };
const WEEK_COL_WIDTH_KEY = 'weekColWidths';
const DEFAULT_WEEK_COL_WIDTH = 168;
const MIN_WEEK_COL_WIDTH = 100;
const MAX_WEEK_COL_WIDTH = 480;

const CURRENT_YEAR = new Date().getFullYear();
const DAILY_REFRESH_CHECK_MS = 30 * 60 * 1000;

const state = {
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
  loading: new Set(),
  loaded: new Set(),
  error: null,
};

const $ = (sel) => document.querySelector(sel);

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
  if (label) label.textContent = text;
  pill.className = `status-pill ${kind}`;
}

function updateStats() {
  const daily = state.bootstrap?.today?.length ?? '—';
  const weeklyTotal = state.weekly
    ? (state.weekly.total
      || Object.values(state.weekly.schedule || {}).reduce((n, arr) => n + arr.length, 0))
    : '—';
  const monthlyTotal = state.monthly
    ? (state.monthly.release_count
      || (state.monthly.premieres?.length || 0) + (state.monthly.ongoing?.length || 0))
    : '—';
  const yearlyTotal = state.yearly
    ? (state.yearly.premieres?.length || 0) + (state.yearly.announced_tba?.length || 0)
    : '—';

  $('#stat-daily').textContent = daily;
  $('#stat-weekly').textContent = weeklyTotal;
  $('#stat-monthly').textContent = monthlyTotal;
  $('#stat-yearly').textContent = yearlyTotal;
  const favEl = $('#stat-favorites');
  const histEl = $('#stat-history');
  if (favEl) favEl.textContent = state.favorites.length;
  if (histEl) histEl.textContent = state.history.length;
  const countFav = $('#count-favorites');
  const countHist = $('#count-history');
  if (countFav) countFav.textContent = state.favorites.length;
  if (countHist) countHist.textContent = state.history.length;
}

function setSubheader(html) {
  const el = $('#subheader');
  if (!html) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = html;
}

function showLoading(msg = 'Loading...') {
  $('#loading').classList.remove('hidden');
  $('#loading-text').textContent = msg;
  $('#content').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#error').classList.add('hidden');
}

function hideLoading() {
  $('#loading').classList.add('hidden');
}

function showError(msg) {
  hideLoading();
  $('#content').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#error').classList.remove('hidden');
  $('#error-message').textContent = msg;
  setStatus('Error', '');
}

function showEmpty(msg) {
  hideLoading();
  $('#content').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  $('#empty-message').textContent = msg;
}

function showContent(html) {
  hideLoading();
  $('#empty').classList.add('hidden');
  $('#error').classList.add('hidden');
  $('#content').innerHTML = html;
  $('#content').classList.remove('hidden');
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
  return `<button type="button" class="watch-btn" data-watch-mal-id="${a.mal_id}" data-watch-title="${title}" title="Stream on AnimeHeaven.me">▶ Watch</button>`;
}

function actionButtons(a) {
  return `<div class="detail-actions">${watchButton(a)}${favoriteButton(a)}${completeButton(a)}${trackButton(a)}</div>`;
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
  const title = escapeHtml(titleOf(a));
  const sub = a.title_japanese ? escapeHtml(a.title_japanese) : '';
  const print = isPrintMedia(a);
  let badge = 'badge-upcoming';
  let label = 'Upcoming';
  if (print) {
    const t = (a.type || a.media || 'Manga').toString();
    badge = 'badge-print';
    label = t;
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

  return `
    <article class="card">
      <a class="card-link" href="${a.url}" target="_blank" rel="noopener">
        <div class="card-image-wrap">
          <img class="card-image" src="${a.image || ''}" alt="${title}" loading="lazy">
          <div class="card-badges">
            <span class="badge ${badge}">${escapeHtml(label)}</span>
            ${score}
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          ${sub ? `<p class="card-sub">${sub}</p>` : ''}
          <div class="card-meta">
            ${a.type ? `<span class="meta-chip">${escapeHtml(a.type)}</span>` : ''}
            ${countChip ? `<span class="meta-chip">${escapeHtml(countChip)}</span>` : ''}
            <span class="meta-chip accent">${air}</span>
          </div>
        </div>
      </a>
      <div class="card-track card-actions">${watchButton(a)}${favoriteButton(a)}${completeButton(a)}${trackButton(a)}</div>
    </article>
  `;
}

function renderDaily() {
  const q = state.search.trim().toLowerCase();
  const list = (state.bootstrap?.today || []).filter((a) => matchesSearch(a, q));
  const day = state.bootstrap?.today_name || getTodayDay();

  setSubheader(`<strong>${DAY_LABELS[day] || day}</strong> · Episodes airing today · ${list.length} shows`);
  $('#count-daily').textContent = state.bootstrap?.today?.length ?? '—';

  if (!list.length) {
    showEmpty(q ? 'No matches for your search today.' : 'Nothing scheduled for today in the database.');
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
  const q = state.search.trim().toLowerCase();
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
    const items = (schedule[day] || []).filter((a) => matchesSearch(a, q));
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
  $('#count-weekly').textContent = total || '—';
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

  const q = state.search.trim().toLowerCase();
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
  $('#count-monthly').textContent = monthTotal;

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

  const q = state.search.trim().toLowerCase();
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
  $('#count-yearly').textContent = yearTotal || y.total || '—';
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
  const q = state.search.trim().toLowerCase();
  const list = (state.bootstrap?.[which] || state.season[which] || []).filter((a) => matchesSearch(a, q));
  $(`#count-${which}`).textContent = list.length || state.bootstrap?.[which]?.length || '—';

  const label = which === 'now' ? 'Current season' : 'Next season';
  setSubheader(`<strong>${label}</strong> · ${list.length} shows`);

  if (!list.length) {
    showEmpty(q ? 'No matches.' : 'No anime in this list yet.');
    return;
  }
  showContent(`<div class="grid">${list.map(cardHtml).join('')}</div>`);
}

function renderWebhooks() {
  const cfg = state.webhook.config || {};
  const st = state.webhook.status || {};
  setSubheader('Get pinged on Discord or any webhook when a <strong>tracked</strong> show releases a new episode');

  const watchHtml = state.watchlist.length
    ? state.watchlist.map((w) => `
        <div class="webhook-watch-item">
          <img src="${w.image || ''}" alt="">
          <span class="title">${escapeHtml(w.title)}</span>
          <button type="button" class="track-btn tracked" data-untrack-id="${w.mal_id}">Remove</button>
        </div>
      `).join('')
    : '<p class="webhook-hint">No shows tracked yet. Click <strong>+ Track</strong> on any anime to get episode alerts.</p>';

  const logHtml = (st.log || []).slice().reverse().map((entry) => {
    const msg = entry.anime || entry.message || entry.type || 'Event';
    const time = entry.time ? new Date(entry.time).toLocaleString() : '';
    return `<div class="webhook-log-item">${time} · ${escapeHtml(msg)}</div>`;
  }).join('') || '<div class="webhook-log-item">No activity yet.</div>';

  showContent(`
    <div class="webhook-panel">
      <section class="webhook-card">
        <h3>Webhook Settings</h3>
        <p class="webhook-hint">Paste a Discord webhook URL or any HTTP endpoint. Works with Discord, Slack-compatible hooks, and custom servers.</p>
        <div class="webhook-field">
          <label for="webhook-url">Webhook URL</label>
          <input type="url" id="webhook-url" placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(cfg.url || '')}">
        </div>
        <div class="webhook-field">
          <label for="webhook-poll">Check every (minutes)</label>
          <select id="webhook-poll">
            ${[15, 30, 45, 60].map((m) => `<option value="${m}" ${Number(cfg.poll_minutes) === m ? 'selected' : ''}>${m} min</option>`).join('')}
          </select>
        </div>
        <label class="webhook-toggle">
          <input type="checkbox" id="webhook-enabled" ${cfg.enabled ? 'checked' : ''}>
          Enable episode notifications
        </label>
        <div class="webhook-actions">
          <button type="button" class="webhook-btn" id="save-webhook-btn">Save Settings</button>
          <button type="button" class="webhook-btn secondary" id="test-webhook-btn">Send Test Ping</button>
          <button type="button" class="webhook-btn secondary" id="check-webhook-btn">Check Now</button>
        </div>
        ${!st.enabled && st.url_set ? '<p class="webhook-hint" style="color:var(--warn)">Notifications are off — enable and Save to get automatic episode pings.</p>' : ''}
        <p class="webhook-hint" id="webhook-save-msg"></p>
      </section>

      <section class="webhook-card">
        <h3>Status</h3>
        <div class="webhook-status-grid">
          <div class="webhook-stat"><span>Enabled</span><strong>${st.enabled ? 'Yes' : 'No'}</strong></div>
          <div class="webhook-stat"><span>Tracked shows</span><strong>${st.watchlist_count ?? 0}</strong></div>
          <div class="webhook-stat"><span>Last check</span><strong>${st.last_check ? new Date(st.last_check).toLocaleString() : '—'}</strong></div>
          <div class="webhook-stat"><span>Last ping</span><strong>${st.last_ping ? new Date(st.last_ping).toLocaleString() : '—'}</strong></div>
        </div>
        ${st.last_error ? `<p class="webhook-hint" style="color:var(--err)">Error: ${escapeHtml(st.last_error)}</p>` : ''}
        <h3 style="margin-top:0.85rem">Recent Activity</h3>
        <div class="webhook-log">${logHtml}</div>
      </section>

      <section class="webhook-card">
        <h3>Add Shows to Track</h3>
        <p class="webhook-hint">Search any anime or pick from the list below. Tracking is instant — no need to find shows on other tabs.</p>
        <div class="picker-search-row">
          <input type="search" id="picker-search" placeholder="Search anime by name..." autocomplete="off">
          <button type="button" class="webhook-btn secondary" id="picker-search-btn">Search</button>
        </div>
        <div id="picker-results" class="picker-grid"></div>
        <h3 style="margin-top:1rem">Browse Airing & Upcoming</h3>
        <div id="picker-browse" class="picker-grid"></div>
      </section>

      <section class="webhook-card">
        <h3>Tracked Shows</h3>
        <div class="webhook-watchlist">${watchHtml}</div>
      </section>
    </div>
  `);

  bindWebhookEvents();
  loadPickerBrowse();
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
  $('#count-webhooks').textContent = state.watchlist.length;
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
  const q = state.search.trim().toLowerCase();
  const list = (state.favorites || []).filter((a) => matchesSearch(a, q));
  setSubheader(`Your <strong>favorites</strong> · ${list.length} saved · star any show to pin it here`);
  $('#count-favorites').textContent = state.favorites.length;
  updateStats();
  if (!list.length) {
    showEmpty(q ? 'No favorites match your filter.' : 'No favorites yet — hit ☆ Favorite on any show.');
    return;
  }
  showContent(`<div class="detail-list">${list.map(detailRow).join('')}</div>`);
}

function renderHistory() {
  const q = state.search.trim().toLowerCase();
  const list = (state.history || []).filter((a) => matchesSearch(a, q));
  setSubheader(`Watch <strong>history</strong> · ${list.length} completed · mark shows done as you finish them`);
  $('#count-history').textContent = state.history.length;
  updateStats();
  if (!list.length) {
    showEmpty(q ? 'No history matches your filter.' : 'No completed titles yet — use Mark Done on any show.');
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
  const media = state.filters.media || 'anime';
  if (state.searchLoading) {
    showLoading(`Searching ${media} via AniList for “${q}”...`);
    return;
  }
  const list = state.searchResults || [];
  const src = state.searchSource ? ` · ${escapeHtml(state.searchSource)}` : '';
  setSubheader(
    `<strong>Database search</strong> · ${escapeHtml(media)} · “${escapeHtml(q)}” · ${list.length} results${src}`,
  );
  $('#count-search').textContent = list.length || '—';
  if (!q || q.length < 2) {
    showEmpty('Type at least 2 characters, set filters, then press Search or Enter.');
    return;
  }
  if (!list.length) {
    if (state.searchError) {
      showEmpty(`Search failed: ${state.searchError}. Try again in a moment.`);
      return;
    }
    showEmpty(`No ${media} matches for “${q}”. Try different filters or spelling.`);
    return;
  }
  showContent(`<div class="grid">${list.map(cardHtml).join('')}</div>`);
}

function render() {
  if (state.loading.has(state.tab) && !state.loaded.has(state.tab)) {
    return;
  }

  switch (state.tab) {
    case 'daily': renderDaily(); break;
    case 'weekly':
      if (state.weekly) renderWeekly();
      else showLoading('Loading weekly schedule...');
      break;
    case 'monthly':
      if (state.monthly) renderMonthly();
      else showLoading('Loading monthly calendar...');
      break;
    case 'yearly':
      if (state.yearly) renderYearly();
      else showLoading(`Loading ${state.yearlyYear} releases...`);
      break;
    case 'now': renderSeason('now'); break;
    case 'upcoming': renderSeason('upcoming'); break;
    case 'favorites': renderFavorites(); break;
    case 'history': renderHistory(); break;
    case 'search': renderSearchResults(); break;
    case 'webhooks': renderWebhooks(); break;
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
  // "all" uses anime formats + manga formats combined lightly
  let options;
  if (media === 'anime') options = ANIME_TYPE_OPTIONS;
  else if (media === 'all') {
    options = [
      ['any', 'All formats'],
      ...ANIME_TYPE_OPTIONS.filter(([v]) => v !== 'any'),
      ...MANGA_TYPE_OPTIONS.filter(([v]) => v !== 'any'),
    ];
  } else {
    options = MANGA_TYPE_OPTIONS;
  }
  const prev = typeSel.value;
  typeSel.innerHTML = options.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  // Keep selection when still valid; default to All formats (not forced manga).
  if (options.some(([v]) => v === prev)) {
    typeSel.value = prev;
  } else if (['manhwa', 'webtoon', 'manhua', 'novel'].includes(media) && options.some(([v]) => v === media)) {
    typeSel.value = media;
  } else {
    typeSel.value = 'any';
  }
  const statusSel = $('#filter-status');
  if (statusSel) {
    const airingOpt = statusSel.querySelector('option[value="airing"]');
    if (airingOpt) {
      airingOpt.textContent = media === 'anime' ? 'Airing' : 'Publishing';
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

async function runDatabaseSearch(forceTab = true) {
  const q = ($('#search')?.value || state.search || '').trim();
  state.search = q;
  const filters = readSearchFilters();
  if (q.length < 2) {
    state.searchResults = [];
    state.searchError = null;
    if (forceTab) setTab('search');
    else if (state.tab === 'search') renderSearchResults();
    return;
  }

  const api = await waitForApi();
  if (!api) {
    showToast('App bridge not ready — restart the app.', 'err');
    return;
  }
  if (!api.search_media && !api.search_anime && !api.search) {
    showToast('Search API not available in this build.', 'err');
    return;
  }

  const requestId = (state.searchRequestId = (state.searchRequestId || 0) + 1);
  state.searchLoading = true;
  state.searchError = null;
  if (forceTab) {
    state.tab = 'search';
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === 'search');
    });
  }
  if (state.tab === 'search') renderSearchResults();
  setStatus('Searching...', 'loading');

  try {
    // Only force type for country-based media (manhwa/manhua/webtoon).
    // Never force format=manga when user chose "All formats" — that hid novels & mixed results.
    let typeParam = filters.type === 'any' ? null : filters.type;
    if (!typeParam && ['manhwa', 'webtoon', 'manhua', 'novel'].includes(filters.media)) {
      typeParam = filters.media;
    }
    const opts = {
      limit: 24,
      type: typeParam,
      status: filters.status === 'any' ? null : filters.status,
      order_by: filters.order_by,
      sort: sortForOrder(filters.order_by),
      min_score: filters.min_score || 0,
    };
    let result;
    // Prefer simple arity first — pywebview is picky with many null args.
    if (api.search_media) {
      try {
        result = await api.search_media(
          q,
          filters.media,
          opts.limit,
          opts.type || '',
          opts.status || '',
          opts.order_by,
          opts.sort,
          opts.min_score,
        );
      } catch (inner) {
        // Fallback: 2-arg simple search
        result = api.search
          ? await api.search(q, filters.media, opts.limit)
          : null;
        if (!result) throw inner;
      }
    } else if (api.search) {
      result = await api.search(q, filters.media, opts.limit);
    } else if (filters.media !== 'anime' && api.search_manga) {
      result = await api.search_manga(q, opts.limit, opts.type || filters.media);
    } else {
      result = await api.search_anime(q, opts.limit);
    }

    // Ignore stale responses if user typed again.
    if (requestId !== state.searchRequestId) return;

    state.searchResults = result?.data || [];
    state.searchError = result?.error || null;
    state.searchSource = result?.source || '';
    state.searchLoading = false;
    if (state.searchError && !state.searchResults.length) {
      setStatus('Search error', '');
      showToast(`Search failed: ${state.searchError}`, 'err');
    } else {
      setStatus('Ready', 'ready');
      if (!state.searchResults.length) {
        showToast(`No results for “${q}”.`, '');
      }
    }
    if (state.tab === 'search') renderSearchResults();
  } catch (err) {
    if (requestId !== state.searchRequestId) return;
    state.searchLoading = false;
    state.searchError = err.message || String(err);
    setStatus('Error', '');
    showToast(state.searchError || 'Search failed.', 'err');
    if (state.tab === 'search') {
      showError(state.searchError || 'Search failed. Check your connection and try again.');
    }
  }
}

function scheduleDatabaseSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    if ((state.search || '').trim().length >= 2 && state.tab === 'search') {
      runDatabaseSearch(false);
    }
  }, 450);
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

async function loadBootstrap() {
  const api = await waitForApi();
  if (!api?.get_bootstrap) throw new Error('App API not available');

  setStatus('Loading today...', 'loading');
  showLoading('Loading today\'s releases...');

  const data = await api.get_bootstrap();
  state.bootstrap = data;
  state.loaded.add('daily');
  state.loaded.add('now');
  state.loaded.add('upcoming');

  $('#count-now').textContent = data.now?.length ?? 0;
  $('#count-upcoming').textContent = data.upcoming?.length ?? 0;
  $('#count-daily').textContent = data.today?.length ?? 0;
  $('#last-updated').textContent = `Updated: ${new Date().toLocaleString()}`;
  updateStats();

  if (data.error && !data.now?.length && !data.today?.length) {
    throw new Error(String(data.error));
  }

  setStatus('Ready', 'ready');
  render();

  loadWeeklyBackground();
  loadMonthlyBackground();
  loadYearlyBackground();
  startDailyRefreshWatcher();
}

async function loadWeeklyBackground(force = false) {
  if (state.loading.has('weekly')) return;
  if (state.weekly && !force) return;
  state.loading.add('weekly');
  setStatus('Syncing week...', 'loading');

  try {
    const api = await waitForApi();
    state.weekly = await api.get_weekly();
    state.loaded.add('weekly');
    const total = Object.values(state.weekly.schedule || {}).reduce((n, arr) => n + arr.length, 0);
    $('#count-weekly').textContent = total;
    updateStats();
    if (state.tab === 'weekly') render();
    setStatus('Ready', 'ready');
  } catch (err) {
    if (state.tab === 'weekly') showError(`Weekly schedule failed: ${err.message}`);
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
    state.monthly = await api.get_monthly();
    state.loaded.add('monthly');
    $('#count-monthly').textContent = state.monthly.release_count
      || state.monthly.premieres?.length
      || 0;
    updateStats();
    if (state.tab === 'monthly') render();
  } catch (err) {
    if (state.tab === 'monthly') showError(`Monthly view failed: ${err.message}`);
  } finally {
    state.loading.delete('monthly');
  }
}

async function loadYearlyBackground(force = false) {
  if (!force && (state.loading.has('yearly') || state.yearly)) return;
  state.loading.add('yearly');

  try {
    const api = await waitForApi();
    state.yearly = await api.get_yearly(state.yearlyYear);
    state.loaded.add('yearly');
    const total = (state.yearly.premieres?.length || 0) + (state.yearly.announced_tba?.length || 0);
    $('#count-yearly').textContent = total || state.yearly.total || '—';
    updateStats();
    if (state.tab === 'yearly') render();
  } catch (err) {
    if (state.tab === 'yearly') showError(`Yearly view failed: ${err.message}`);
  } finally {
    state.loading.delete('yearly');
  }
}

async function forceRefreshAll() {
  const api = await waitForApi();
  if (!api?.refresh_all_data) return;

  const btn = $('#refresh-btn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
  setStatus('Refreshing...', 'loading');
  showToast('Pulling latest episode schedules...', '');
  try {
    const result = await api.refresh_all_data(true);
    state.bootstrap = result.bootstrap || state.bootstrap;
    state.weekly = result.weekly || null;
    state.monthly = result.monthly || null;
    state.yearly = null;
    state.loaded.clear();
    state.loaded.add('daily');
    state.loaded.add('now');
    state.loaded.add('upcoming');
    if (state.weekly) state.loaded.add('weekly');
    if (state.monthly) state.loaded.add('monthly');
    $('#last-updated').textContent = `Updated: ${new Date().toLocaleString()}`;
    state.refreshDate = result.today || null;
    updateStats();
    // Fill anything not returned by the refresh call.
    await Promise.all([
      state.weekly ? Promise.resolve() : loadWeeklyBackground(),
      state.monthly ? Promise.resolve() : loadMonthlyBackground(),
      loadYearlyBackground(true),
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
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  ensureTabData(tab).then(() => render());
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
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

async function toggleStreamFullscreen() {
  const wrap = $('#stream-player-wrap') || $('#stream-panel') || $('#stream-overlay');
  const overlay = $('#stream-overlay');
  if (!wrap) return;

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      overlay?.classList.remove('is-fullscreen');
      document.body.classList.remove('stream-fullscreen');
      return;
    }
    if (wrap.requestFullscreen) {
      await wrap.requestFullscreen();
    } else if (wrap.webkitRequestFullscreen) {
      await wrap.webkitRequestFullscreen();
    } else {
      overlay?.classList.toggle('is-fullscreen');
      document.body.classList.toggle('stream-fullscreen');
    }
  } catch {
    overlay?.classList.toggle('is-fullscreen');
    document.body.classList.toggle('stream-fullscreen');
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

async function playStreamEpisode(episode, gateHash) {
  const api = await waitForApi();
  const video = $('#stream-video');
  if (!api?.get_stream_sources || !video) return;

  await flushWatchProgress();
  stopProgressTracking();

  state.stream.currentEp = episode;
  state.stream.loading = true;
  renderStreamEpisodes();
  setStreamStatus(`Loading episode ${episode}...`);
  $('#stream-ep-label').textContent = `Episode ${episode}`;

  const result = await api.get_stream_sources(gateHash);
  state.stream.loading = false;

  if (!result?.ok) {
    setStreamStatus(result?.error || 'Could not load stream.', 'err');
    return;
  }

  video.onerror = () => {
    setStreamStatus('Playback failed — try another episode or open on AnimeHeaven.me', 'err');
  };

  let resumeAt = 0;
  try {
    const saved = await api.get_watch_progress?.(state.stream.anime?.mal_id, episode);
    if (saved?.seconds && saved.seconds > 5) {
      resumeAt = Number(saved.seconds);
    }
  } catch {
    resumeAt = 0;
  }

  const candidates = [];
  const pushSrc = (u) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };
  pushSrc(result.playback_url);
  pushSrc(result.primary);
  (result.sources || []).forEach(pushSrc);

  if (!candidates.length) {
    setStreamStatus('No playable sources returned.', 'err');
    return;
  }

  let srcIndex = 0;
  const tryPlay = async (idx) => {
    const src = candidates[idx];
    if (!src) {
      setStreamStatus('Playback failed — try another episode or Open on AnimeHeaven.me', 'err');
      return;
    }
    video.removeAttribute('crossorigin');
    video.src = src;
    video.load();
    try {
      await video.play();
      if (!resumeAt) setStreamStatus(`Now playing episode ${episode} · via AnimeHeaven.me`);
      startProgressTracking();
    } catch {
      setStreamStatus(resumeAt ? 'Press play to resume where you left off.' : 'Press play to start — stream is ready.', '');
      startProgressTracking();
    }
  };

  video.onerror = () => {
    srcIndex += 1;
    if (srcIndex < candidates.length) {
      setStreamStatus(`Retrying stream source ${srcIndex + 1}/${candidates.length}...`);
      tryPlay(srcIndex);
    } else {
      setStreamStatus('Playback failed — try another episode or open on AnimeHeaven.me', 'err');
    }
  };

  video.onloadedmetadata = () => {
    if (resumeAt > 0 && resumeAt < (video.duration || Infinity) - 15) {
      video.currentTime = resumeAt;
      setStreamStatus(`Resumed episode ${episode} at ${Math.floor(resumeAt / 60)}:${String(Math.floor(resumeAt % 60)).padStart(2, '0')}`);
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
  $('#stream-title').textContent = resolved.title || title;
  $('#stream-subtitle').textContent = resolved.title_japanese || 'AnimeHeaven.me';
  const ahLink = $('#stream-ah-link');
  if (ahLink) {
    ahLink.href = resolved.url || 'https://animeheaven.me';
    ahLink.textContent = 'Open on AnimeHeaven.me';
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
        $('#version-badge').textContent = `v${info.version}`;
        const line = $('#app-version-line');
        if (line) {
          line.innerHTML = `<strong>${escapeHtml(info.publisher || 'Grey GodZilla')}</strong> · ${escapeHtml(info.name || 'Anime Tracker')} v${escapeHtml(info.version)}`;
        }
        if (info.title) document.title = info.title;
      }
    }
  } catch {
    /* keep default badge */
  }
}

function init() {
  loadAppInfo();
  loadWebhookData().then(() => {
    $('#count-webhooks').textContent = state.watchlist.length;
  });
  loadLibrary();

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

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.tab === 'search') {
      scheduleDatabaseSearch();
    } else {
      render();
    }
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runDatabaseSearch(true);
    }
  });
  $('#search-go-btn')?.addEventListener('click', () => runDatabaseSearch(true));
  syncFormatFilterOptions();
  $('#filter-media')?.addEventListener('change', () => {
    syncFormatFilterOptions();
    readSearchFilters();
    if (state.tab === 'search' && state.search.trim().length >= 2) {
      runDatabaseSearch(false);
    }
  });
  ['filter-type', 'filter-status', 'filter-order', 'filter-score'].forEach((id) => {
    $(`#${id}`)?.addEventListener('change', () => {
      readSearchFilters();
      if (state.tab === 'search' && state.search.trim().length >= 2) {
        runDatabaseSearch(false);
      }
    });
  });

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

  loadBootstrap().catch((err) => showError(err.message));
}

document.addEventListener('DOMContentLoaded', init);