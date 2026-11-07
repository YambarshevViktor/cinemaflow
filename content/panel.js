(() => {
  if (window.__cinemaflow_panel_injected) return;
  window.__cinemaflow_panel_injected = true;

  const STATE_KEY = 'cinemaflow_state_v1';
  const HEALTH_KEY = 'cinemaflow_health_v1';
  const LAST_KEY = 'cinemaflow_last_v1';
  const OLD_STATE_KEY = 'allfilm_state_v1';
  const OLD_HEALTH_KEY = 'allfilm_health_v1';
  const HOST_ID = 'cinemaflow-panel-host';
  const CHECK_TIMEOUT_MS = 6000;
  const BG_TIMEOUT_MS = 20000;

  let closedForUrl = null;
  let lastUrl = location.href;
  let lastThemeKey = '';
  let state = null; // { groups: [...] }
  let health = {};

  const tr = (key, vars) => window.CF_T(state?.lang || 'ru', key, vars);
  const groupTitle = (g) => ((state?.lang === 'en' && g.title_en) ? g.title_en : g.title);
  const effUrl = (l) => window.CF_EFFECTIVE(l, health);
  const shortHost = (u) => {
    try { return new URL(String(u).replace('%s', 'test')).hostname.replace(/^www\./, ''); }
    catch (e) { return ''; }
  };

  // ---------- helpers ----------
  const cleanHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
  const currentRootHost = () => cleanHost(location.hostname);

  function baseDomain(host) {
    // грубо: последние 2 части (kinorium.com из ua.kinorium.com)
    const parts = cleanHost(host).split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    return parts.slice(-2).join('.');
  }

  function linkHost(urlTpl) {
    try {
      return cleanHost(new URL(String(urlTpl).replace('%s', 'test')).hostname);
    } catch (e) {
      return '';
    }
  }

  function faviconFor(urlTpl, size = 32) {
    // Прямой favicon сайта: гугл-сервис иконок возвращает «глобус» вместо
    // ошибки, и буква-аватар никогда не показывается. Тут либо иконка, либо буква.
    const h = linkHost(urlTpl);
    if (!h) return '';
    return `https://${h}/favicon.ico`;
  }

  function getMovieInfo() {
    // 1. JSON-LD
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          const arr = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
          for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            if (['Movie', 'TVSeries', 'TVEpisode', 'TVSeason'].includes(o['@type']) || o.name) {
              let title = (o.name || '').trim();
              let year = '';
              const dp = o.datePublished || o.dateCreated || '';
              const m = String(dp).match(/^(\d{4})/);
              if (m) year = m[1];
              if (title) {
                let extra = '';
                if (o['@type'] === 'TVEpisode') {
                  const urlm = location.href.match(/season[-_]?(\d+).*episode[-_]?(\d+)/i);
                  if (urlm) extra = ` S${String(urlm[1]).padStart(2, '0')}E${String(urlm[2]).padStart(2, '0')}`;
                }
                return { title: title + extra, year };
              }
            }
          }
        } catch (e) { /* next script */ }
      }
    } catch (e) { /* ignore */ }
    // 2. og:title
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content?.trim()) {
      return splitTitleYear(og.content.trim());
    }
    // 3. document.title: "Dune (2021) - IMDb" -> "Dune", "2021"
    if (document.title) return splitTitleYear(document.title);
    return { title: '', year: '' };
  }

  function splitTitleYear(raw) {
    let t = raw.replace(/\s*-\s*(IMDb|Kinorium).*$/i, '').trim();
    let year = '';
    const m = t.match(/\((\d{4})\)/);
    if (m) { year = m[1]; t = t.replace(m[0], '').trim(); }
    return { title: t, year };
  }

  function isMoviePage() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (/("Movie"|"TVSeries"|"TVEpisode")/.test(txt)) return true;
      }
    } catch (e) {}
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && /video\.movie|video\.tv_show|video\.episode/i.test(ogType.content)) return true;
    if (/imdb\.com\/title\/tt\d+/.test(location.href)) return true;
    if (/kinorium\.(com|net)/.test(location.href) && /\/(film|movie|series|show)/i.test(location.href)) return true;
    if (/themoviedb\.org\/movie\/\d+/.test(location.href)) return true;
    if (/letterboxd\.com\/film\/[^/]+\/?($|\?)/.test(location.href)) return true;
    return false;
  }

  function buildSearchUrl(link, title, year, tplOverride) {
    const tpl = tplOverride || effUrl(link);
    // Обычная ссылка без %s — открываем как есть (прямой переход, без подстановки).
    if (!String(tpl).includes('%s')) return tpl;
    // Некоторым сайтам год в запросе мешает (напр. TMDB) — для них только название.
    const q = (link.qmode === 'title' || !year) ? title : [title, year].join(' ');
    return tpl.replace('%s', encodeURIComponent(String(q).trim()));
  }

  // Выбор главной ссылки группы: первая enabled, не текущий сайт, предпочтительно живая.
  function pickMainLink(links, myRoot) {
    const enabled = (links || []).filter((l) => l.enabled);
    if (!enabled.length) return null;
    const notCurrent = enabled.filter((l) => baseDomain(linkHost(l.url)) !== myRoot);
    const pool = notCurrent.length ? notCurrent : enabled;
    const alive = pool.find((l) => health[effUrl(l)]?.alive !== false);
    const main = alive || pool[0];
    return { main, all: enabled };
  }

  // ---------- theme: система + сайт ----------
  function luminanceOfCss(color) {
    const m = String(color || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    const r = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function detectDark() {
    try {
      // 1. явные маркеры темы сайта
      const root = document.documentElement;
      const body = document.body;
      const dt = (root.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
      if (dt === 'dark') return true;
      if (dt === 'light') return false;
      const cls = `${root.className || ''} ${body?.className || ''}`.toLowerCase();
      if (/(^|[\s"'])dark(-mode|mode|theme)?([\s"']|$)/.test(cls)) return true;
      if (/(^|[\s"'])light(-mode|mode|theme)?([\s"']|$)/.test(cls)) return false;
      // 2. яркость фона страницы
      let node = body || root;
      for (let i = 0; i < 4 && node; i++) {
        let bg = '';
        try { bg = getComputedStyle(node).backgroundColor; } catch (e) { bg = ''; }
        if (bg && bg !== 'transparent' && !/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)$/.test(bg)) {
          const lum = luminanceOfCss(bg);
          if (lum !== null) return lum < 0.45;
          break;
        }
        node = node.parentElement;
      }
    } catch (e) { /* fallthrough */ }
    // 3. фолбэк — системная тема
    try { return matchMedia('(prefers-color-scheme: dark)').matches; }
    catch (e) { return false; }
  }

  function applyTheme() {
    const dark = detectDark();
    const key = dark ? 'dark' : 'light';
    if (key === lastThemeKey) return;
    lastThemeKey = key;
    try {
      const host = document.getElementById(HOST_ID);
      const card = host?.shadowRoot?.querySelector('.cf-card');
      if (card) card.classList.toggle('cf-dark', dark);
    } catch (e) {}
  }

  // ---------- state ----------
  async function loadCatalog() {
    const res = await fetch(chrome.runtime.getURL('defaults/catalog.json'));
    return res.json();
  }

  async function loadState() {
    const catalog = await loadCatalog();
    const got = await chrome.storage.local.get([STATE_KEY, OLD_STATE_KEY]);
    const raw = got[STATE_KEY] || got[OLD_STATE_KEY];
    // Слияние: свои ссылки и галочки сохраняются, новинки каталога (зеркала,
    // qmode, переводы, язык) подтягиваются автоматически.
    state = raw ? window.CF_MERGE(raw, catalog) : { ...catalog, lang: 'ru' };
    if (!state.lang) state.lang = 'ru';
    await chrome.storage.local.set({ [STATE_KEY]: state });
    return state;
  }

  async function loadHealth() {
    const got = await chrome.storage.local.get([HEALTH_KEY, OLD_HEALTH_KEY]);
    health = got[HEALTH_KEY] || got[OLD_HEALTH_KEY] || {};
  }

  // ---------- health check с таймаутом + локальный фолбэк ----------
  function sendCheck(urls) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, BG_TIMEOUT_MS);
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
        let host = null;
        try { host = new URL(String(tpl).replace('%s', 'test')).hostname; } catch (e) {}
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
    const merged = { ...health, ...results };
    try { await chrome.storage.local.set({ [HEALTH_KEY]: merged }); } catch (e) {}
    return merged;
  }

  async function checkMirrors() {
    const urls = [...new Set(state.groups.flatMap((g) => g.links.filter((l) => l.enabled).flatMap((l) => [l.url, ...((l.mirrors) || [])])))];
    const via = await sendCheck(urls);
    if (via) { health = via; return; }
    health = await probeLocal(urls); // background не ответил — проверяем сами, зависнуть нельзя
  }

  // ---------- shadow UI ----------
  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
    return host;
  }

  // Удаляем остатки прошлого названия, чтобы блокировщики не прятали панель.
  function removeLegacyHost() {
    try {
      const old = document.getElementById('allfilm-banner-host');
      if (old && old.id !== HOST_ID) old.remove();
    } catch (e) {}
  }

  const CSS = `
    :host { all: initial; }
    .cf-wrap {
      position: fixed; right: 20px; bottom: 20px; width: 340px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, Segoe UI, sans-serif;
      color-scheme: light dark;
    }
    .cf-card {
      border-radius: 20px;
      background: rgba(255,255,255,0.72);
      -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
      color: #1d1d1f;
    }
    .cf-card.cf-dark { background: rgba(28,28,32,0.72); border-color: rgba(255,255,255,0.14); color: #f5f5f7; box-shadow: 0 12px 40px rgba(0,0,0,0.55); }
    .cf-card.cf-dark .cf-sub { color: rgba(235,235,245,0.6); }
    .cf-card.cf-dark .cf-btn { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.12); color: #f5f5f7; }
    .cf-card.cf-dark .cf-btn:hover { background: rgba(255,255,255,0.16); }
    .cf-card.cf-dark .cf-arrow { border-left-color: rgba(255,255,255,0.12); }
    .cf-card.cf-dark .cf-drop { background: rgba(36,36,40,0.98); border-color: rgba(255,255,255,0.14); }
    .cf-card.cf-dark .cf-item:hover { background: rgba(255,255,255,0.08); }
    .cf-card.cf-dark .cf-item.dead, .cf-card.cf-dark .cf-item.here { color: rgba(235,235,245,0.45); }
    .cf-card.cf-dark .cf-foot button { color: rgba(235,235,245,0.75); }
    .cf-head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 12px 8px 14px; }
    .cf-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cf-sub { font-size: 11px; font-weight: 400; color: rgba(60,60,67,0.6); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cf-close { border: 0; background: transparent; cursor: pointer; font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 8px; color: inherit; opacity: .6; }
    .cf-close:hover { opacity: 1; background: rgba(127,127,127,.18); }
    .cf-body { display: flex; flex-direction: column; gap: 8px; padding: 2px 12px 8px 12px; }
    .cf-group { position: relative; }
    .cf-btn { display: flex; align-items: center; width: 100%; border-radius: 13px; border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.85); cursor: pointer; padding: 0; overflow: hidden; color: #1d1d1f; font-size: 13px; font-weight: 600; }
    .cf-btn:hover { background: #fff; }
    .cf-btn:disabled { opacity: .5; cursor: default; }
    .cf-main { display: flex; align-items: center; gap: 9px; flex: 1; padding: 9px 10px; min-width: 0; }
    .cf-ico { position: relative; width: 18px; height: 18px; flex: 0 0 auto; }
    .cf-ico-l { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; }
    .cf-ico-i { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; background: #fff; object-fit: cover; }
    .cf-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cf-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
    .cf-dot.ok { background: #30d158; } .cf-dot.bad { background: #ff453a; } .cf-dot.unknown { background: #8e8e93; }
    .cf-arrow { padding: 9px 11px; border-left: 1px solid rgba(0,0,0,0.08); font-size: 12px; opacity: .7; }
    .cf-drop {
      display: none; position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 10;
      border-radius: 13px; border: 1px solid rgba(0,0,0,0.08); background: rgba(255,255,255,0.98);
      box-shadow: 0 8px 28px rgba(0,0,0,0.2);
      max-height: 220px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
    }
    .cf-drop.open { display: block; }
    .cf-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 10px; background: none; border: 0; cursor: pointer; font-size: 12.5px; color: inherit; text-align: left; }
    .cf-item:hover { background: rgba(0,0,0,0.05); }
    .cf-item.dead, .cf-item.here { opacity: .65; cursor: default; }
    .cf-tag { margin-left: auto; font-size: 10px; font-weight: 500; opacity: .6; flex: 0 0 auto; }
    .cf-foot { display: flex; align-items: center; gap: 4px; padding: 0 8px 10px 8px; }
    .cf-foot button { border: 0; background: transparent; cursor: pointer; font-size: 11.5px; color: rgba(60,60,67,0.8); padding: 6px 8px; border-radius: 8px; }
    .cf-foot button:hover { background: rgba(127,127,127,.18); }
    .cf-foot button:disabled { opacity: .5; cursor: default; }
  .cf-foot .sp { flex: 1; }
    .cf-pill { display: flex; align-items: center; gap: 8px; border-radius: 999px; padding: 6px 6px 6px 14px; font-size: 12px; font-weight: 600;
      background: rgba(255,255,255,0.72); -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
      border: 1px solid rgba(0,0,0,0.08); box-shadow: 0 8px 28px rgba(0,0,0,0.2); color: #1d1d1f; width: max-content; max-width: 100%; }
    .cf-pill.cf-dark { background: rgba(28,28,32,0.72); border-color: rgba(255,255,255,0.14); color: #f5f5f7; }
    .cf-pill button { border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer; background: #0a84ff; color: #fff; font-size: 12px; font-weight: 600; }
    .cf-pill button:hover { filter: brightness(1.1); }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function closeAllDrops(shadow, except) {
    try {
      shadow.querySelectorAll('.cf-drop.open').forEach((d) => { if (d !== except) d.classList.remove('open'); });
    } catch (e) {}
  }

  function renderHiddenPill(host, myRoot) {
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = el('div', 'cf-wrap');
    const pill = el('div', 'cf-pill' + (detectDark() ? ' cf-dark' : ''));
    pill.appendChild(el('span', '', tr('hidden_here')));
    const show = el('button', '', tr('show'));
    show.onclick = async (e) => {
      e.stopPropagation();
      state.hidden = (state.hidden || []).filter((h) => h !== myRoot);
      try { await chrome.storage.local.set({ [STATE_KEY]: state }); } catch (err) {}
      render();
    };
    pill.appendChild(show);
    wrap.appendChild(pill);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
  }

  async function render() {
    removeLegacyHost();
    const host = ensureHost();
    const myRoot = baseDomain(currentRootHost());
    if ((state.hidden || []).includes(myRoot)) { renderHiddenPill(host, myRoot); return; }
    if (closedForUrl === location.href) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }
    if (!isMoviePage()) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }

    const { title, year } = getMovieInfo();
    if (!title) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }
    const queryText = [title, year].filter(Boolean).join(' ');

    // Запоминаем для кнопки «Копировать название» в настройках.
    try { chrome.storage.local.set({ [LAST_KEY]: { text: queryText, title, year, url: location.href, ts: Date.now() } }); } catch (e) {}

    // Переиспользуем shadow root: повторный attachShadow бросает исключение
    // и панель «замирает» (это и была вечная «Проверяю…»).
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = el('div', 'cf-wrap');
    const card = el('div', 'cf-card' + (detectDark() ? ' cf-dark' : ''));
    lastThemeKey = card.classList.contains('cf-dark') ? 'dark' : 'light';

    // head
    const head = el('div', 'cf-head');
    const titleBox = el('div', 'cf-title', title);
    const sub = el('span', 'cf-sub', year ? `${year} · ${myRoot}` : myRoot);
    titleBox.appendChild(sub);
    const close = el('button', 'cf-close', '✕');
    close.title = tr('close_next');
    close.onclick = (e) => {
      e.stopPropagation();
      closedForUrl = location.href;
      try { shadow.innerHTML = ''; } catch (err) {}
    };
    head.appendChild(titleBox);
    head.appendChild(close);
    card.appendChild(head);

    // body groups
    const body = el('div', 'cf-body');
    for (const g of state.groups) {
      const picked = pickMainLink(g.links, myRoot) || {};
      const { main, all } = picked;
      const box = el('div', 'cf-group');

      const btn = el('button', 'cf-btn');
      btn.disabled = !main;
      const mainPart = el('span', 'cf-main');
      if (main) {
        const label = el('span', 'cf-label', `${groupTitle(g)}: ${main.name}`);
        const eff = effUrl(main);
        const dot = el('span', 'cf-dot ' + (health[eff]?.alive === false ? 'bad' : health[eff]?.alive ? 'ok' : 'unknown'));
        mainPart.appendChild(window.CF_ICON(main.name, faviconFor(eff)));
        mainPart.appendChild(label);
        mainPart.appendChild(dot);
        try {
          const all = [main.url, ...((main.mirrors) || [])].filter(Boolean);
          if (all.length > 1) mainPart.title = all.join('\n');
        } catch (e) {}
        mainPart.onclick = (e) => {
          e.stopPropagation();
          window.open(buildSearchUrl(main, title, year), '_blank', 'noopener');
        };
      } else {
        mainPart.appendChild(el('span', 'cf-label', tr('none_enabled', { g: groupTitle(g) })));
      }
      const arrow = el('span', 'cf-arrow', '▾');
      btn.appendChild(mainPart);
      btn.appendChild(arrow);

      // dropdown — открывается вверх поверх карточки, внутри свой скролл
      const drop = el('div', 'cf-drop');
      const addItem = (link, tpl, label) => {
        const here = baseDomain(linkHost(tpl)) === myRoot;
        const dead = health[tpl]?.alive === false;
        const item = el('button', 'cf-item' + (dead ? ' dead' : '') + (here ? ' here' : ''));
        item.appendChild(window.CF_ICON(link.name, faviconFor(tpl)));
        item.appendChild(el('span', '', label));
        let tagText = '';
        if (here) tagText = tr('here');
        else if (dead) tagText = tr('down');
        else if (tpl !== effUrl(link)) tagText = tr('via', { h: shortHost(tpl) });
        const tag = el('span', 'cf-tag', tagText);
        item.appendChild(tag);
        if (!here) {
          item.onclick = (e) => {
            e.stopPropagation();
            window.open(buildSearchUrl(link, title, year, tpl), '_blank', 'noopener');
            drop.classList.remove('open');
          };
        }
        drop.appendChild(item);
      };
      (all || []).forEach((l) => {
        const eff = effUrl(l);
        addItem(l, eff, eff === l.url ? l.name : `${l.name} · ${shortHost(eff)}`);
        // Каждое зеркало — отдельным пунктом: видно куда ведет, выбирается руками.
        for (const m of (l.mirrors || [])) {
          if (!m || m === eff) continue;
          addItem(l, m, `${l.name} · ${shortHost(m)}`);
        }
      });

      arrow.onclick = (e) => {
        e.stopPropagation();
        closeAllDrops(shadow, drop);
        drop.classList.toggle('open');
        // Если список уперся в верх экрана — подрезаем высоту, скролл остается внутри.
        try {
          if (drop.classList.contains('open')) {
            const r = drop.getBoundingClientRect();
            if (r.top < 8) {
              drop.style.maxHeight = Math.max(120, 220 + r.top - 8) + 'px';
            } else {
              drop.style.maxHeight = '';
            }
          }
        } catch (err) {}
      };

      box.appendChild(btn);
      box.appendChild(drop);
      body.appendChild(box);
    }
    card.appendChild(body);

    // foot
    const foot = el('div', 'cf-foot');
    const copy = el('button', '', tr('copy'));
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(queryText); copy.textContent = tr('copied'); }
      catch (e) { copy.textContent = tr('copy_fail'); }
      setTimeout(() => { try { copy.textContent = tr('copy'); } catch (err) {} }, 1500);
    };
    const check = el('button', '', tr('check'));
    check.onclick = async () => {
      check.disabled = true;
      check.textContent = tr('checking');
      try {
        await checkMirrors();
      } catch (e) {}
      // render() всегда восстанавливает кнопку — зависнуть в «Проверяю…» нельзя
      try { await render(); }
      catch (e) {
        check.disabled = false;
        check.textContent = tr('check');
      }
    };
    const sp = el('span', 'sp');
    const gear = el('button', '', '⚙️');
    gear.title = tr('settings');
    gear.onclick = () => { try { chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }); } catch (e) {} };
    foot.appendChild(copy);
    foot.appendChild(check);
    foot.appendChild(sp);
    foot.appendChild(gear);
    card.appendChild(foot);

    wrap.appendChild(card);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    if (!host.__cf_outside_listener) {
      shadow.addEventListener('click', (e) => {
        if (!e.target.closest?.('.cf-group')) {
          closeAllDrops(shadow, null);
        }
      });
      host.__cf_outside_listener = true;
    }
  }

  // ---------- boot + SPA ----------
  async function boot() {
    try {
      await loadState();
      await loadHealth();
      await render();
    } catch (e) {}
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STATE_KEY]) { state = changes[STATE_KEY].newValue; render(); }
    if (changes[HEALTH_KEY]) { health = changes[HEALTH_KEY].newValue || {}; render(); }
  });

  // Смена фильма без перезагрузки (IMDb SPA): URL + появление JSON-LD
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      closedForUrl = null;
      render();
    }
  }, 1500);

  let themeTimer = null;
  const scheduleTheme = () => {
    if (themeTimer) return;
    themeTimer = setTimeout(() => { themeTimer = null; applyTheme(); }, 300);
  };

  try {
    if (matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', scheduleTheme);
    }
  } catch (e) {}

  const mo = new MutationObserver(() => {
    const host = document.getElementById(HOST_ID);
    if (!host?.shadowRoot && isMoviePage()) { render(); return; }
    scheduleTheme(); // сайт сменил тему/фон — подхватываем без перерисовки
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

  boot();
})();
