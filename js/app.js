const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

const state = {
  tab: 'daily',
  search: '',
  bootstrap: null,
  weekly: null,
  monthly: null,
  season: { now: null, upcoming: null },
  webhook: { config: null, status: null },
  watchlist: [],
  stream: {
    open: false,
    anime: null,
    ahId: null,
    episodes: [],
    currentEp: null,
    loading: false,
    error: null,
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
  const now = state.season.now?.length ?? state.bootstrap?.now?.length ?? '—';
  const upcoming = state.season.upcoming?.length ?? state.bootstrap?.upcoming?.length ?? '—';
  const weeklyTotal = state.weekly
    ? Object.values(state.weekly.schedule || {}).reduce((n, arr) => n + arr.length, 0)
    : '—';
  const monthlyTotal = state.monthly
    ? (state.monthly.premieres?.length || 0) + (state.monthly.ongoing?.length || 0)
    : '—';

  $('#stat-daily').textContent = daily;
  $('#stat-weekly').textContent = weeklyTotal;
  $('#stat-monthly').textContent = monthlyTotal;
  $('#stat-now').textContent = now;
  $('#stat-upcoming').textContent = upcoming;
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
    state.watchlist,
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

function trackButton(a) {
  if (!a.mal_id) return '';
  const tracked = isTracked(a.mal_id);
  return `<button type="button" class="track-btn ${tracked ? 'tracked' : ''}" data-track-id="${a.mal_id}" title="Notify via webhook when a new episode releases">${tracked ? '✓ Tracked' : '+ Track'}</button>`;
}

function watchButton(a) {
  if (!a.mal_id) return '';
  const title = escapeHtml(titleOf(a));
  return `<button type="button" class="watch-btn" data-watch-mal-id="${a.mal_id}" data-watch-title="${title}" title="Stream on AnimeHeaven.me">▶ Watch</button>`;
}

function actionButtons(a) {
  return `<div class="detail-actions">${watchButton(a)}${trackButton(a)}</div>`;
}

function metaChips(a) {
  const chips = [];
  if (a.type) chips.push(`<span class="meta-chip">${escapeHtml(a.type)}</span>`);
  if (a.episodes) chips.push(`<span class="meta-chip">${a.episodes} eps</span>`);
  if (a.airing) chips.push('<span class="meta-chip airing">Airing</span>');
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
  const badge = a.airing ? 'badge-airing' : 'badge-upcoming';
  const label = a.airing ? 'Airing' : 'Upcoming';
  const score = a.score ? `<span class="badge badge-score">★ ${a.score}</span>` : '';
  const air = a.aired_from ? formatDate(a.aired_from) : 'TBA';

  return `
    <article class="card">
      <a class="card-link" href="${a.url}" target="_blank" rel="noopener">
        <div class="card-image-wrap">
          <img class="card-image" src="${a.image || ''}" alt="${title}" loading="lazy">
          <div class="card-badges">
            <span class="badge ${badge}">${label}</span>
            ${score}
          </div>
        </div>
        <div class="card-body">
          <h3 class="card-title">${title}</h3>
          ${sub ? `<p class="card-sub">${sub}</p>` : ''}
          <div class="card-meta">
            ${a.type ? `<span class="meta-chip">${escapeHtml(a.type)}</span>` : ''}
            <span class="meta-chip accent">${air}</span>
          </div>
        </div>
      </a>
      <div class="card-track card-actions">${watchButton(a)}${trackButton(a)}</div>
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

function renderWeekly() {
  const schedule = state.weekly?.schedule || {};
  const q = state.search.trim().toLowerCase();
  const today = state.bootstrap?.today_name || getTodayDay();
  let total = 0;

  const cols = DAYS.map((day) => {
    const items = (schedule[day] || []).filter((a) => matchesSearch(a, q));
    total += items.length;
    const body = items.length
      ? items.map((a) => `
          <a class="week-item" href="${a.url}" target="_blank" rel="noopener">
            <img src="${a.image || ''}" alt="" loading="lazy">
            <div>
              <div class="week-item-title">${escapeHtml(titleOf(a))}</div>
              ${a.broadcast_time ? `<div class="week-item-time">${escapeHtml(a.broadcast_time)}</div>` : ''}
            </div>
          </a>
        `).join('')
      : '<div class="week-empty">No shows</div>';

    return `
      <section class="week-col ${day === today ? 'today' : ''}">
        <div class="week-col-head">
          ${DAY_LABELS[day]}
          <span class="count">${items.length} anime</span>
        </div>
        <div class="week-col-body">${body}</div>
      </section>
    `;
  }).join('');

  setSubheader(`Full week overview · <strong>${total}</strong> total slots`);
  $('#count-weekly').textContent = total || '—';
  showContent(`<div class="week-board">${cols}</div>`);
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
  const monthTotal = premieres.length + ongoing.length;

  setSubheader(`<strong>${m.month_name} ${m.year}</strong> · ${premieres.length} premieres · ${ongoing.length} airing · ${startingSoon.length} starting soon`);
  $('#count-monthly').textContent = monthTotal;

  const dayCells = [];
  for (let d = 1; d <= m.days_in_month; d++) {
    const drops = (m.premiere_by_day?.[String(d)] || []).filter((a) => matchesSearch(a, q));
    const items = drops.map((a) => `
      <a class="month-day-item" href="${a.url}" target="_blank" rel="noopener">${escapeHtml(titleOf(a))}</a>
    `).join('');
    dayCells.push(`
      <div class="month-day ${drops.length ? 'has-drop' : ''}">
        <div class="month-day-num">${d}</div>
        ${items || (drops.length === 0 ? '<span class="week-empty">—</span>' : '')}
      </div>
    `);
  }

  const premiereList = premieres.length
    ? `<div class="detail-list">${premieres.map(detailRow).join('')}</div>`
    : '<p class="week-empty">No premieres found this month.</p>';

  const ongoingList = ongoing.length
    ? `<div class="detail-list">${ongoing.map(detailRow).join('')}</div>`
    : '<p class="week-empty">No ongoing shows found.</p>';

  const soonList = startingSoon.length
    ? `<div class="detail-list">${startingSoon.map(detailRow).join('')}</div>`
    : '';

  const broadcastBoard = DAYS.map((day) => {
    const items = (m.broadcast_map?.[day] || []).filter((a) => matchesSearch(a, q));
    if (!items.length) return '';
    return `
      <section class="month-section">
        <h3>Airing Every ${DAY_LABELS[day]}</h3>
        <div class="detail-list">${items.slice(0, 8).map(detailRow).join('')}</div>
      </section>
    `;
  }).join('');

  showContent(`
    <div class="month-header">
      <h2>${m.month_name} ${m.year}</h2>
      <div class="month-stats">${premieres.length} premieres · ${ongoing.length} airing now · ${startingSoon.length} coming soon</div>
    </div>
    <section class="month-section">
      <h3>Premiere Calendar</h3>
      <div class="month-grid">${dayCells.join('')}</div>
    </section>
    <section class="month-section">
      <h3>New This Month</h3>
      ${premiereList}
    </section>
    <section class="month-section">
      <h3>Airing This Month</h3>
      ${ongoingList}
    </section>
    ${soonList ? `<section class="month-section"><h3>Starting Soon</h3>${soonList}</section>` : ''}
    ${broadcastBoard}
  `);
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
    case 'now': renderSeason('now'); break;
    case 'upcoming': renderSeason('upcoming'); break;
    case 'webhooks': renderWebhooks(); break;
    default: renderDaily();
  }
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
}

async function loadWeeklyBackground() {
  if (state.loading.has('weekly') || state.weekly) return;
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

async function loadMonthlyBackground() {
  if (state.loading.has('monthly') || state.monthly) return;
  state.loading.add('monthly');

  try {
    const api = await waitForApi();
    state.monthly = await api.get_monthly();
    state.loaded.add('monthly');
    $('#count-monthly').textContent = state.monthly.premieres?.length ?? 0;
    updateStats();
    if (state.tab === 'monthly') render();
  } catch (err) {
    if (state.tab === 'monthly') showError(`Monthly view failed: ${err.message}`);
  } finally {
    state.loading.delete('monthly');
  }
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

function closeStreamOverlay() {
  const overlay = $('#stream-overlay');
  const video = $('#stream-video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  state.stream = {
    open: false, anime: null, ahId: null, episodes: [],
    currentEp: null, loading: false, error: null,
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

  video.src = result.primary || result.sources?.[0];
  video.load();
  video.play().catch(() => {});
  setStreamStatus(`Now playing episode ${episode} · via AnimeHeaven.me`);
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
  const latest = state.stream.episodes[0];
  await playStreamEpisode(latest.episode, latest.gate_hash);
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

  document.body.addEventListener('click', (e) => {
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

    const trackBtn = e.target.closest('[data-track-id]');
    if (trackBtn) {
      e.preventDefault();
      e.stopPropagation();
      trackAnime(Number(trackBtn.dataset.trackId));
    }
  });

  $('#stream-close-btn')?.addEventListener('click', closeStreamOverlay);
  $('#stream-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'stream-overlay') closeStreamOverlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.stream.open) closeStreamOverlay();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  $('#retry-btn').addEventListener('click', () => {
    state.weekly = null;
    state.monthly = null;
    state.bootstrap = null;
    state.loaded.clear();
    state.loading.clear();
    loadBootstrap().catch((err) => showError(err.message));
  });

  loadBootstrap().catch((err) => showError(err.message));
}

document.addEventListener('DOMContentLoaded', init);