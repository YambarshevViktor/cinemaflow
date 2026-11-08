// Настройки: каталог + галочки + порядок + свои ссылки + язык + зеркала.
const STATE_KEY = 'cinemaflow_state_v1';
const HEALTH_KEY = 'cinemaflow_health_v1';
const LAST_KEY = 'cinemaflow_last_v1';
const OLD_STATE_KEY = 'allfilm_state_v1';
const OLD_HEALTH_KEY = 'allfilm_health_v1';
const CHECK_TIMEOUT_MS = 6000;
const BG_TIMEOUT_MS = 20000;
const SITE_GROUPS = [
  { label: 'Kinorium', hosts: ['kinorium.com', 'kinorium.net'] },
  { label: 'IMDb', hosts: ['imdb.com'] },
  { label: 'TMDB', hosts: ['themoviedb.org'] },
  { label: 'Letterboxd', hosts: ['letterboxd.com'] }
];

let state = null;
let health = {};
let lastQuery = null;
let checking = false;

const groupsEl = document.getElementById('groups');
const sitesEl = document.getElementById('sites');
const statusEl = document.getElementById('status');
const healthBtn = document.getElementById('healthBtn');
const copyBtn = document.getElementById('copyBtn');
const hintEl = document.getElementById('hint');
const resetBtn = document.getElementById('resetBtn');
const gearBtn = document.getElementById('gearBtn');
const langRu = document.getElementById('langRu');
const langEn = document.getElementById('langEn');

const tr = (key, vars) => window.CF_T(state?.lang || 'ru', key, vars);

function say(t, ms = 1600) {
  statusEl.textContent = t;
  clearTimeout(say._t);
  say._t = setTimeout(() => (statusEl.textContent = ''), ms);
}

// Красная подсветка невалидного поля: видно сразу, что адрес не приняли.
function flagBad(input) {
  try {
    input.classList.add('bad');
    input.focus();
    input.addEventListener('input', () => input.classList.remove('bad'), { once: true });
  } catch (e) {}
}

// Прямой favicon сайта: без гугл-сервиса, у которого вместо ошибки — «глобус».
function faviconFor(urlTpl) {
  try {
    const h = new URL(String(urlTpl).replace('%s', 'test')).hostname;
    return `https://${h}/favicon.ico`;
  } catch (e) { return ''; }
}

function shortUrl(u) {
  return String(u).replace('https://', '').replace('http://', '').replace('%s', '…');
}

function hostOf(u) {
  try { return new URL(String(u).replace('%s', 'test')).hostname.replace(/^www\./, ''); }
  catch (e) { return ''; }
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(state?.lang === 'en' ? 'en-GB' : 'ru-RU'); }
  catch (e) { return ''; }
}

// Название по умолчанию из хоста: www.mycinema.com -> Mycinema
function prettyNameFromUrl(urlStr) {
  try {
    const h = new URL(urlStr.replace('%s', 'test')).hostname.toLowerCase().replace(/^www\./, '');
    const first = h.split('.')[0] || h;
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch (e) { return (state?.lang === 'en') ? 'My link' : 'Моя ссылка'; }
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (host.includes(':')) return /^\[[0-9a-f:.]+\]$/i.test(host); // IPv6 в скобках
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return host.split('.').every((p) => p !== '' && Number(p) >= 0 && Number(p) <= 255);
  }
  const labels = host.split('.');
  if (labels.length < 2) return false; // одна часть — не адрес («абракадабра» отклоняем)
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/i.test(label) || label.startsWith('-') || label.endsWith('-')) return false;
  }
  const tld = labels[labels.length - 1];
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,})$/.test(tld)) return false;
  return true;
}

// Строго: только настоящие адреса. Мусор вроде «абракадабра» или «!!!» отклоняется.
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > 2048 || /[\s<>"'`]/.test(s)) return null;
  if ((s.match(/%s/g) || []).length > 1) return null;
  const candidate = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  if (s.includes('%s')) {
    // %s обязан быть в пути/запросе, а не в хосте
    const afterHost = candidate.replace(/^https?:\/\/[^/]+/i, '');
    if (!afterHost.includes('%s')) return null;
  }
  let u;
  try { u = new URL(candidate.replace('%s', 'test')); }
  catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  if (!isValidHost(u.hostname.toLowerCase())) return null;
  return candidate;
}

async function loadCatalog() {
  const res = await fetch(chrome.runtime.getURL('defaults/catalog.json'));
  return res.json();
}

function normalizeState(s) {
  if (!s || !Array.isArray(s.groups)) return null;
  if (!s.lang) s.lang = 'ru';
  if (!Array.isArray(s.removed)) s.removed = [];
  if (!Array.isArray(s.hidden)) s.hidden = [];
  for (const g of s.groups) {
    if (typeof g.title !== 'string' || !g.title) g.title = g.id;
    if (typeof g.title_en !== 'string' || !g.title_en) g.title_en = g.title;
    if (typeof g.titleEdited !== 'boolean') g.titleEdited = false;
    if (g.showInPanel !== false) g.showInPanel = true;
    if (!Array.isArray(g.links)) g.links = [];
    for (const l of g.links) {
      if (typeof l.enabled !== 'boolean') l.enabled = true;
      if (typeof l.name !== 'string' || !l.name) l.name = prettyNameFromUrl(l.url || 'https://example.com');
      if (typeof l.url !== 'string') l.url = '';
      if (l.mirrors && !Array.isArray(l.mirrors)) delete l.mirrors;
      if (l.hiddenMirrors && !Array.isArray(l.hiddenMirrors)) delete l.hiddenMirrors;
    }
  }
  return s;
}

async function boot() {
  const catalog = await loadCatalog();
  const got = await chrome.storage.local.get([STATE_KEY, OLD_STATE_KEY]);
  const raw = got[STATE_KEY] || got[OLD_STATE_KEY];
  state = normalizeState(raw ? window.CF_MERGE(raw, catalog) : { ...catalog, lang: 'ru' });
  await chrome.storage.local.set({ [STATE_KEY]: state });
  const hgot = await chrome.storage.local.get([HEALTH_KEY, OLD_HEALTH_KEY]);
  health = hgot[HEALTH_KEY] || hgot[OLD_HEALTH_KEY] || {};
  lastQuery = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY] || null;
  applyStatic();
  render();
}

async function save() {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

function applyStatic() {
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'ru';
  hintEl.textContent = tr('hint');
  resetBtn.textContent = tr('reset');
  resetBtn.title = tr('reset_title');
  gearBtn.title = tr('settings');
  copyBtn.textContent = tr('copy');
  copyBtn.title = lastQuery?.text ? lastQuery.text : tr('no_title');
  healthBtn.textContent = checking ? tr('checking') : tr('check');
  langRu.classList.toggle('on', state.lang !== 'en');
  langEn.classList.toggle('on', state.lang === 'en');
  document.getElementById('sitesTitle').textContent = tr('sites');
}

async function setLang(lang) {
  if (state.lang === lang) return;
  state.lang = lang;
  await save();
  applyStatic();
  render();
  say(tr('saved'));
}

langRu.onclick = () => setLang('ru');
langEn.onclick = () => setLang('en');
gearBtn.onclick = () => {
  try { chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }); }
  catch (e) { say(tr('failed'), 2000); }
};

copyBtn.onclick = async () => {
  if (!lastQuery?.text) { say(tr('no_title'), 2500); return; }
  try { await navigator.clipboard.writeText(lastQuery.text); say(tr('copied')); }
  catch (e) { say(tr('copy_fail'), 2500); }
};

// --- health check: сначала background (надёжнее к CSP), с таймаутом; фолбэк — локально ---
function sendCheck(urls, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(null); }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_HEALTH', urls }, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError || !res?.results) resolve(null);
        else resolve(res.results);
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}

async function probeLocal(urls) {
  const results = {};
  await Promise.all(urls.map(async (tpl) => {
    try {
      const host = hostOf(tpl);
      if (!host) { results[tpl] = { alive: false, ts: Date.now() }; return; }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
      try {
        await fetch(`https://${host}/favicon.ico?t=${Date.now()}`, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
        results[tpl] = { alive: true, ts: Date.now() };
      } catch (e) {
        results[tpl] = { alive: false, ts: Date.now() };
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      results[tpl] = { alive: false, ts: Date.now() };
    }
  }));
  return { ...health, ...results };
}

function collectUrls() {
  const urls = [];
  for (const g of state.groups) {
    for (const l of g.links) {
      if (!l.enabled) continue;
      urls.push(l.url, ...((l.mirrors) || []));
    }
  }
  return [...new Set(urls.filter(Boolean))];
}

async function runHealthCheck() {
  if (checking) return;
  checking = true;
  healthBtn.disabled = true;
  applyStatic();
  say(tr('checking'), 15000);
  try {
    const urls = collectUrls();
    let results = await sendCheck(urls, BG_TIMEOUT_MS);
    if (!results) results = await probeLocal(urls); // background не ответил — проверяем сами
    health = results;
    await chrome.storage.local.set({ [HEALTH_KEY]: health });
    render();
    say(tr('done'));
  } catch (e) {
    say(tr('failed'), 2500);
  } finally {
    checking = false;
    healthBtn.disabled = false;
    applyStatic();
  }
}

function groupTitle(g) {
  return (state.lang === 'en' && g.title_en) ? g.title_en : g.title;
}

function dotState(u) {
  const hv = health[u];
  return hv?.alive === false ? 'bad' : hv?.alive ? 'ok' : 'unknown';
}

function dotTitle(u) {
  const hv = health[u];
  return `${hostOf(u)} — ${hv?.alive === false ? tr('down') : hv?.alive ? tr('up') : tr('unchecked')}`;
}

// Зеркала — сразу чипами: ссылка с удалением + пилюля «+ зеркало». Без заголовков.
function mirrorBlock(l) {
  const wrap = document.createElement('div');
  const eff = window.CF_EFFECTIVE(l, health);

  const row = document.createElement('div');
  row.className = 'mrow';
  for (const m of (l.mirrors || [])) {
    const chip = document.createElement('span');
    chip.className = 'mchip';
    const d = document.createElement('span');
    d.className = 'mdot ' + dotState(m);
    d.title = dotTitle(m);
    const t = document.createElement('span');
    t.className = 'host';
    t.textContent = hostOf(m) || shortUrl(m);
    t.title = m;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = tr('remove');
    x.onclick = async () => {
      l.mirrors = (l.mirrors || []).filter((u) => u !== m);
      l.hiddenMirrors = [...((l.hiddenMirrors) || []), m]; // чтобы слияние каталога не вернуло
      l.updatedAt = Date.now();
      await save(); render(); say(tr('removed'));
    };
    chip.appendChild(d);
    chip.appendChild(t);
    chip.appendChild(x);
    row.appendChild(chip);
  }
  const addB = document.createElement('button');
  addB.className = 'madd';
  addB.textContent = tr('add_mirror');
  addB.onclick = () => {
    addB.style.display = 'none';
    const form = document.createElement('div');
    form.className = 'mform';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = tr('mirror_ph');
    const ok = document.createElement('button');
    ok.className = 'ghost';
    ok.textContent = tr('add');
    ok.onclick = async () => {
      const url = normalizeUrl(inp.value);
      if (!url) { say(tr('bad_url'), 2500); flagBad(inp); return; }
      if (url === l.url || (l.mirrors || []).includes(url)) { render(); say(tr('saved')); return; }
      l.mirrors = [...((l.mirrors) || []), url];
      l.hiddenMirrors = ((l.hiddenMirrors) || []).filter((u) => u !== url);
      l.updatedAt = Date.now();
      await save(); render(); say(tr('added'));
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    form.appendChild(inp);
    form.appendChild(ok);
    row.appendChild(form);
    inp.focus();
  };
  row.appendChild(addB);
  if (eff && eff !== l.url) {
    const via = document.createElement('span');
    via.className = 'mvia';
    via.textContent = `→ ${hostOf(eff)}`;
    via.title = tr('via', { h: hostOf(eff) });
    row.appendChild(via);
  }
  if (l.updatedAt) {
    const upd = document.createElement('span');
    upd.className = 'mdate';
    upd.textContent = `· ${tr('updated')} ${fmtDate(l.updatedAt)}`;
    row.appendChild(upd);
  }
  wrap.appendChild(row);
  return wrap;
}

// Форма правки записи: имя + URL + режим запроса. У встроенных шаблон
// помечается l.edited — слияние каталога его больше не перезаписывает.
function editForm(l) {
  const form = document.createElement('div');
  form.className = 'eform';
  const nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.value = l.name || '';
  nameIn.placeholder = tr('name_ph');
  const urlIn = document.createElement('input');
  urlIn.type = 'text';
  urlIn.value = l.url || '';
  urlIn.placeholder = tr('url_ph');
  const qSel = document.createElement('select');
  const optAuto = document.createElement('option');
  optAuto.value = '';
  optAuto.textContent = tr('q_auto');
  const optTitle = document.createElement('option');
  optTitle.value = 'title';
  optTitle.textContent = tr('q_title');
  qSel.appendChild(optAuto);
  qSel.appendChild(optTitle);
  qSel.value = l.qmode === 'title' ? 'title' : '';
  const btns = document.createElement('div');
  btns.className = 'erow';
  const ok = document.createElement('button');
  ok.className = 'ghost';
  ok.textContent = tr('save_btn');
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = tr('cancel');
  btns.appendChild(ok);
  btns.appendChild(cancel);
  form.appendChild(nameIn);
  form.appendChild(urlIn);
  form.appendChild(qSel);
  form.appendChild(btns);
  ok.onclick = async () => {
    const url = normalizeUrl(urlIn.value);
    if (!url) { say(tr('bad_url'), 2500); flagBad(urlIn); return; }
    l.name = nameIn.value.trim() || prettyNameFromUrl(url);
    l.url = url;
    if (qSel.value === 'title') l.qmode = 'title';
    else delete l.qmode;
    if (l.builtin) l.edited = true;
    l.updatedAt = Date.now();
    await save(); render(); say(tr('saved'));
  };
  cancel.onclick = () => render();
  return form;
}

function render() {
  groupsEl.innerHTML = '';
  state.groups.forEach((g) => {
    const box = document.createElement('div');
    box.className = 'group';
    // Шапка группы: название + галочка «показывать кнопкой» + ✎ переименовать.
    // Так любую из трёх кнопок можно скрыть или отдать под своё
    // (например, выключить все торренты и назвать кнопку по-своему).
    const hrow = document.createElement('div');
    hrow.className = 'ghrow';
    const h = document.createElement('h2');
    h.textContent = groupTitle(g);
    hrow.appendChild(h);
    const showLbl = document.createElement('label');
    showLbl.className = 'gshow';
    showLbl.title = tr('show_group');
    const showCb = document.createElement('input');
    showCb.type = 'checkbox';
    showCb.checked = g.showInPanel !== false;
    showCb.onchange = async () => { g.showInPanel = showCb.checked; await save(); render(); say(tr('saved')); };
    const showT = document.createElement('span');
    showT.textContent = '✓';
    showLbl.appendChild(showCb);
    showLbl.appendChild(showT);
    hrow.appendChild(showLbl);
    const renB = document.createElement('button');
    renB.className = 'mini';
    renB.textContent = '✎';
    renB.title = tr('rename_group');
    hrow.appendChild(renB);
    box.appendChild(hrow);
    let gformHost = null;
    renB.onclick = () => {
      if (gformHost) { gformHost.remove(); gformHost = null; return; }
      gformHost = document.createElement('div');
      gformHost.className = 'ehost';
      const form = document.createElement('div');
      form.className = 'eform';
      const ruIn = document.createElement('input');
      ruIn.type = 'text';
      ruIn.value = g.title || '';
      ruIn.placeholder = tr('title_ru_ph');
      const enIn = document.createElement('input');
      enIn.type = 'text';
      enIn.value = g.title_en || '';
      enIn.placeholder = tr('title_en_ph');
      const btns = document.createElement('div');
      btns.className = 'erow';
      const ok = document.createElement('button');
      ok.className = 'ghost';
      ok.textContent = tr('save_btn');
      const cancel = document.createElement('button');
      cancel.className = 'ghost';
      cancel.textContent = tr('cancel');
      btns.appendChild(ok);
      btns.appendChild(cancel);
      form.appendChild(ruIn);
      form.appendChild(enIn);
      form.appendChild(btns);
      ok.onclick = async () => {
        g.title = ruIn.value.trim() || g.title;
        g.title_en = enIn.value.trim() || g.title_en;
        g.titleEdited = true; // слияние каталога свои названия не затрет
        await save(); render(); say(tr('saved'));
      };
      cancel.onclick = () => render();
      gformHost.appendChild(form);
      hrow.after(gformHost);
    };

    // Включенные — сверху по порядку, выключенные — ниже серым
    const on = g.links.filter((l) => l.enabled);
    const off = g.links.filter((l) => !l.enabled);

    [...on, ...off].forEach((l) => {
      const idx = g.links.indexOf(l);
      const row = document.createElement('div');
      row.className = 'row' + (l.enabled ? '' : ' off');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!l.enabled;
      cb.title = tr('show_in_panel');
      cb.onchange = async () => { l.enabled = cb.checked; await save(); render(); say(tr('saved')); };

      const eff = window.CF_EFFECTIVE(l, health);
      row.appendChild(window.CF_ICON(l.name, faviconFor(eff)));

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nm = document.createElement('div');
      nm.className = 'name';
      nm.textContent = l.name + (l.builtin ? '' : ' · ' + tr('custom'));
      const dot = document.createElement('span');
      dot.className = 'dot ' + dotState(eff);
      dot.title = dotTitle(eff);
      nm.appendChild(dot);
      const url = document.createElement('div');
      url.className = 'url';
      url.textContent = shortUrl(eff);
      url.title = [l.url, ...((l.mirrors) || [])].filter(Boolean).join('\n');
      meta.appendChild(nm);
      meta.appendChild(url);
      meta.appendChild(mirrorBlock(l));

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = l.enabled ? String(on.indexOf(l) + 1) : '—';
      num.title = tr('order');

      const up = document.createElement('button');
      up.className = 'mini'; up.textContent = '↑'; up.title = tr('move_up');
      up.onclick = async () => { if (idx > 0) { const [x] = g.links.splice(idx, 1); g.links.splice(idx - 1, 0, x); await save(); render(); } };

      const down = document.createElement('button');
      down.className = 'mini'; down.textContent = '↓'; down.title = tr('move_down');
      down.onclick = async () => { if (idx < g.links.length - 1) { const [x] = g.links.splice(idx, 1); g.links.splice(idx + 1, 0, x); await save(); render(); } };

      const editB = document.createElement('button');
      editB.className = 'mini'; editB.textContent = '✎'; editB.title = tr('edit');
      const del = document.createElement('button');
      del.className = 'mini danger'; del.textContent = '✕'; del.title = tr('remove');
      del.onclick = async () => {
        if (l.builtin) state.removed.push(l.id); // встроенные тоже можно удалять — слияние их не вернет
        g.links.splice(idx, 1);
        await save(); render(); say(tr('removed'));
      };

      row.appendChild(cb);
      row.appendChild(meta);
      row.appendChild(num);
      row.appendChild(up);
      row.appendChild(down);
      row.appendChild(editB);
      row.appendChild(del);
      box.appendChild(row);

      let formHost = null;
      editB.onclick = () => {
        if (formHost) { formHost.remove(); formHost = null; return; }
        formHost = document.createElement('div');
        formHost.className = 'ehost';
        formHost.appendChild(editForm(l));
        row.after(formHost);
      };
    });

    // Добавление своей ссылки: название необязательно, %s необязателен
    const add = document.createElement('div');
    add.className = 'add';
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.placeholder = tr('name_ph');
    const urlIn = document.createElement('input');
    urlIn.type = 'text'; urlIn.placeholder = tr('url_ph');
    urlIn.style.flex = '2';
    const addBtn = document.createElement('button');
    addBtn.className = 'ghost'; addBtn.textContent = tr('add');
    addBtn.onclick = async () => {
      const rawName = nameIn.value.trim();
      const url = normalizeUrl(urlIn.value);
      if (!url) { say(urlIn.value.trim() ? tr('bad_url') : tr('paste'), 2500); flagBad(urlIn); return; }
      const name = rawName || prettyNameFromUrl(url);
      g.links.push({ id: 'custom_' + Date.now(), name, url, enabled: true, builtin: false });
      await save(); render(); say(tr('added'));
    };
    // Enter в любом поле = добавить
    urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
    add.appendChild(nameIn);
    add.appendChild(urlIn);
    add.appendChild(addBtn);
    box.appendChild(add);

    groupsEl.appendChild(box);
  });

  // Секция «Сайты»: Kinorium (.com/.net) — одной группой-пилюлями, без дублей.
  // Плюс поле для своих хостов (панель работает только на IMDb/Kinorium из манифеста).
  sitesEl.innerHTML = '';
  const hiddenSet = new Set(state.hidden || []);
  const covered = new Set(SITE_GROUPS.flatMap((sg) => sg.hosts));
  const toggleHost = async (h, show) => {
    if (show) state.hidden = (state.hidden || []).filter((x) => x !== h);
    else state.hidden = [...new Set([...(state.hidden || []), h])];
    await save(); render();
  };
  for (const sg of SITE_GROUPS) {
    const row = document.createElement('div');
    row.className = 'row';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = sg.label;
    meta.appendChild(nm);
    const pills = document.createElement('div');
    pills.className = 'mrow';
    for (const h of sg.hosts) {
      const pill = document.createElement('label');
      pill.className = 'mchip';
      pill.title = h;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hiddenSet.has(h);
      cb.onchange = () => toggleHost(h, cb.checked);
      const t = document.createElement('span');
      t.className = 'host';
      t.textContent = h;
      pill.appendChild(cb);
      pill.appendChild(t);
      pills.appendChild(pill);
    }
    meta.appendChild(pills);
    row.appendChild(meta);
    sitesEl.appendChild(row);
  }
  for (const h of [...hiddenSet].filter((x) => !covered.has(x))) {
    const row = document.createElement('div');
    row.className = 'row off';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.onchange = () => toggleHost(h, true);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = h;
    meta.appendChild(nm);
    row.appendChild(cb);
    row.appendChild(meta);
    sitesEl.appendChild(row);
  }
}

resetBtn.onclick = async () => {
  const catalog = await loadCatalog();
  const lang = state.lang || 'ru';
  state = normalizeState({ ...catalog, lang });
  await save();
  applyStatic();
  render();
  say(tr('defaults_done'));
};

healthBtn.onclick = runHealthCheck;

boot();
