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

  // Резка (включая свои зеркала из настроек): сезоны и серии живут на той же
  // странице тайтла (плеер с выбором), а TVEpisode в её разметке — норма.
  function isRezkaHost() {
    const host = String(location.hostname || '').toLowerCase();
    if (/(^|\.)((hd)?rezka)\./.test(host)) return true;
    try {
      const customs = (state && state.customSiteHosts) || [];
      if (customs.length && customs.includes(baseDomain(host))) return true;
    } catch (e) {}
    return false;
  }

  function faviconFor(urlTpl, size = 32) {
    // Прямой favicon сайта: гугл-сервис иконок возвращает «глобус» вместо
    // ошибки, и буква-аватар никогда не показывается. Тут либо иконка, либо буква.
    const h = linkHost(urlTpl);
    if (!h) return '';
    return `https://${h}/favicon.ico`;
  }

  // ---------- названия: русское + оригинальное ----------
  // На русских страницах (Kinorium «Оборотень», HDRezka) JSON-LD даёт русское
  // название, а западный поиск (TMDB, Letterboxd, торренты) по нему ничего не
  // находит. Поэтому достаём оба: title — как раньше, originalTitle — откуда
  // получится. Нет оригинала — работаем как раньше, только по title.
  const normTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const hasLatin = (s) => /[a-zA-Z]/.test(String(s || ''));
  const sameTitle = (a, b) => {
    const x = normTitle(a).toLowerCase(), y = normTitle(b).toLowerCase();
    return !!x && x === y;
  };

  // Чистим кандидата в оригинал: кавычки, прилипший год, мусор длиннее названия.
  function cleanOriginal(s) {
    let t = normTitle(s);
    t = t.replace(/\s*\(\d{4}\)\s*$/, '').trim(); // сначала год, потом кавычки
    t = t.replace(/^["'«“‘]+|["'»”’]+$/g, '').trim();
    if (/[«»]/.test(t)) return ''; // обломок «...» — не название, а мусор
    if (t.length < 2 || t.length > 120) return '';
    return t;
  }

  // Кавычки-ёлочки вокруг всего названия: «Оборотень» -> Оборотень.
  function stripWrapQuotes(s) {
    const t = normTitle(s);
    const m = t.match(/^«(.+)»$/s) || t.match(/^"(.+)"$/s);
    return m ? normTitle(m[1]) : t;
  }

  // Скобки в конце названия: «Оборотень» (2026, Werwulf), Dune (2021).
  // Год и оригинал — наружу, скобки — из названия. Латинская голова с
  // негодовой скобкой («Dune (Part Two)») — подзаголовок, не трогаем.
  function parenForm(s) {
    const t = normTitle(s);
    const m = t.match(/^(.*?)\s*\(([^()]{1,120})\)\s*$/);
    if (!m) return null;
    let head = stripWrapQuotes(m[1].trim().replace(/^(фильм|сериал|мультфильм)\s+(?=«)/i, ''));
    if (!head || head.length > 120) return null;
    const inner = m[2].trim();
    if (!inner) return null;
    const parts = inner.split(',').map((p) => normTitle(p)).filter(Boolean);
    let year = '', original = '';
    for (const p of parts) {
      if (!year && /^\d{4}$/.test(p)) { year = p; continue; }
      if (!original && hasLatin(p)) original = cleanOriginal(p);
    }
    if (hasLatin(head)) {
      if (!year) return null;
      return { title: head, original: '', year };
    }
    return { title: head, original, year };
  }

  // Хвост после года: «Оборотень (2026) Werwulf» — год в скобках посреди
  // строки, оригинал болтается в конце без скобок. Латинскую голову
  // («Dune (2021) Part Two») не трогаем. Короткие хвосты вроде «4K» — не название.
  function tailForm(s) {
    const t = normTitle(s);
    const m = t.match(/^(.*?)\s*\((\d{4})\)\s*(.+)$/);
    if (!m) return null;
    const head = stripWrapQuotes(m[1].trim());
    const tail = normTitle(m[3]);
    if (!head || !tail || tail.length > 80) return null;
    if (hasLatin(head) || !hasLatin(tail)) return null;
    if (!/[a-zA-Z\u00C0-\u024F]{2}/.test(tail)) return null;
    const orig = cleanOriginal(tail);
    if (!orig || sameTitle(orig, head)) return null;
    return { title: head, original: orig, year: m[2] };
  }

  // Имена из JSON-LD блоков про фильм/сериал. Оригинал лежит в alternateName,
  // а у Кинориума — в alternativeHeadline (стандарт Schema.org для такого).
  function jsonLdOriginals(mainTitle) {
    const out = [];
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        let data;
        try { data = JSON.parse(s.textContent); } catch (e) { continue; }
        const arr = Array.isArray(data) ? data : (data && data['@graph'] ? data['@graph'] : [data]);
        for (const o of arr) {
          if (!o || typeof o !== 'object') continue;
          const t = o['@type'];
          const types = Array.isArray(t) ? t : [t];
          const isMovie = types.some((x) => ['Movie', 'TVSeries', 'TVEpisode', 'TVSeason'].includes(x));
          if (isMovie && o.name) {
            const n = normTitle(o.name);
            if (n && !sameTitle(n, mainTitle)) out.push(n);
          }
          for (const key of ['alternateName', 'alternativeHeadline', 'alternativeTitle']) {
            const v = o[key];
            if (v === undefined) continue;
            const alts = Array.isArray(v) ? v : [v];
            for (const a of alts) {
              const n = normTitle(a && (typeof a === 'string' ? a : a.name));
              if (n && !sameTitle(n, mainTitle)) out.push(n);
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // Кнопка «Скопировать название» у Кинориума: data-copy-text="Оборотень (Werwulf)".
  function copyTextOriginal() {
    try {
      const btn = document.querySelector('[data-copy-text]');
      const v = btn ? normTitle(btn.getAttribute('data-copy-text')) : '';
      if (!v || v.length > 120) return '';
      const pc = parenForm(v) || tailForm(v);
      if (pc && pc.original) return pc.original;
      return v;
    } catch (e) { /* ignore */ }
    return '';
  }

  // IMDb кладёт оба названия в __NEXT_DATA__: titleText vs originalTitleText.
  function nextDataOriginal(mainTitle) {
    try {
      if (!/(^|\.)imdb\.com$/.test(cleanHost(location.hostname))) return '';
      const nd = document.getElementById('__NEXT_DATA__');
      if (!nd?.textContent) return '';
      const data = JSON.parse(nd.textContent);
      let origText = '';
      const stack = [data];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== 'object') continue;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (k === 'originalTitleText' && v && typeof v.text === 'string' && !origText) {
            origText = normTitle(v.text);
          } else if (v && typeof v === 'object') {
            stack.push(v);
          }
        }
      }
      if (origText && !sameTitle(origText, mainTitle)) return origText;
    } catch (e) { /* ignore */ }
    return '';
  }

  // Подписанный оригинал на странице: «Исходное название Werwulf» (TMDB),
  // «Оригинальное название: ...», «Original Title ...».
  function labeledOriginal(mainTitle) {
    try {
      const labelRe = /^(оригинальное название|исходное название|original title)\s*:?\s*(.+)$/i;
      const sels = 'p, li, dt, dd, td, [itemprop="alternativeHeadline"], .original-title, .film-original-title, .b-post__origtitle';
      const found = document.querySelectorAll(sels);
      if (found.length > 5000) return ''; // параноидально большая страница — пропускаем
      for (const node of found) {
        const txt = normTitle(node.textContent).slice(0, 200);
        const m = txt.match(labelRe);
        if (!m) continue;
        const cand = cleanOriginal(m[2]);
        if (cand && !sameTitle(cand, mainTitle)) return cand;
      }
    } catch (e) { /* ignore */ }
    // Подпись и значение часто лежат в разных узлах (span подписи + span
    // значения) — идём TreeWalker'ом по текстовым узлам.
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const t = n.nodeValue || '';
          if (!t || t.length > 300) return NodeFilter.FILTER_SKIP;
          return /оригинальное название|исходное название|original title/i.test(t)
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      let node;
      let guard = 0;
      while ((node = walker.nextNode()) && guard++ < 50) {
        const txt = normTitle(node.nodeValue);
        const m = txt.match(/^(оригинальное название|исходное название|original title)\s*:?\s*(.*)$/i);
        if (!m) continue;
        let cand = normTitle(m[2]);
        if (!cand) {
          // Значение в соседних узлах: сначала братья, потом весь родитель.
          let sib = node.nextSibling;
          let hops = 0;
          while (sib && hops++ < 3 && !cand) {
            const t = normTitle(sib.textContent);
            if (t && t.length <= 120) cand = t;
            sib = sib.nextSibling;
          }
          if (!cand && node.parentElement) {
            const pt = normTitle(node.parentElement.textContent);
            if (pt.length <= 150) cand = pt.replace(/^(оригинальное название|исходное название|original title)\s*:?\s*/i, '');
          }
        }
        cand = cleanOriginal(cand);
        if (cand && !sameTitle(cand, mainTitle)) return cand;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  // Русскоязычные сайты (Kinorium, HDRezka) часто показывают оригинал мелкой
  // строкой рядом с h1 без всякой подписи. Ищем короткую латиницу в том же
  // блоке, что и заголовок. Только для этих хостов — на IMDb/TMDB и так есть
  // надёжные источники, а тут блок заголовка простой и риск мусора минимален.
  function isRuTitleHost() {
    try {
      const h = cleanHost(location.hostname);
      if (/(^|\.)kinorium\.(com|net)$/.test(h)) return true;
      return isRezkaHost();
    } catch (e) { return false; }
  }

  function titleBlockOriginal(title) {
    try {
      if (!isRuTitleHost()) return '';
      const h1s = document.querySelectorAll('h1');
      for (const h1 of h1s) {
        const h1t = normTitle(h1.textContent);
        if (!h1t || (!h1t.includes(title) && !sameTitle(h1t, title))) continue;
        const scope = h1.parentElement;
        if (!scope) continue;
        const kids = [...scope.children].filter((k) => k !== h1);
        kids.unshift(h1); // оригинал может быть span'ом внутри самого h1
        for (const k of kids) {
          const texts = [];
          for (const n of k.childNodes) {
            if (n.nodeType === 3) {
              const t = normTitle(n.nodeValue);
              if (t) texts.push(t);
            } else if (n.tagName && /^(SPAN|DIV|SMALL)$/.test(n.tagName)) {
              const t = normTitle(n.textContent);
              if (t && t.length <= 80) texts.push(t);
            }
          }
          for (const t of texts) {
            for (const raw of t.split(/[,·|]/)) {
              const part = cleanOriginal(normTitle(raw).replace(/\s*\(\d{4}\)\s*$/, ''));
              if (!part || part.length < 2 || part.length > 80) continue;
              if (!hasLatin(part) || sameTitle(part, title)) continue;
              // Метаданные («IMDb: 6.5», «2h 34m»), а не название.
              if (/imdb|кинопоиск|^\d|\d+\s*(h|ч|м|min|мин)\b/i.test(part)) continue;
              if (!/[a-zA-Z\u00C0-\u024F]{2}/.test(part)) continue; // «4K», «3D» — не название
              return part;
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  // «Оборотень / Werwulf»: нелатиница — название, латиница — оригинал.
  // Только смешанный вариант: «AC/DC» и подобное не трогаем.
  function slashOriginal(title) {
    const parts = String(title || '').split('/').map(normTitle).filter(Boolean);
    if (parts.length !== 2) return null;
    const [a, b] = parts;
    if (a.length > 120 || b.length > 120) return null;
    if (!hasLatin(a) && hasLatin(b) && !sameTitle(a, b)) {
      return { title: a, original: cleanOriginal(b) };
    }
    if (hasLatin(a) && !hasLatin(b) && !sameTitle(a, b)) {
      return { title: b, original: cleanOriginal(a) };
    }
    return null;
  }

  function getMovieInfo() {
    // 1. JSON-LD (название и год — как раньше)
    let base = null;
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
                base = { title: title + extra, year };
                break;
              }
            }
          }
        } catch (e) { /* next script */ }
        if (base) break;
      }
    } catch (e) { /* ignore */ }
    // 2. og:title
    if (!base) {
      const og = document.querySelector('meta[property="og:title"]');
      if (og?.content?.trim()) base = splitTitleYear(og.content.trim());
    }
    // 3. document.title: "Dune (2021) - IMDb" -> "Dune", "2021"
    if (!base) {
      if (document.title) base = splitTitleYear(document.title);
      else return { title: '', originalTitle: '', year: '' };
    }
    if (!base.title) return { title: '', originalTitle: '', year: '' };

    let { title, year } = base;
    title = stripWrapQuotes(title);
    // Скобки вида «(2026, Werwulf)» — год и оригинал оттуда, скобки из названия.
    const pf = parenForm(title);
    if (pf) {
      title = pf.title;
      if (!year && pf.year) year = pf.year;
    }
    // «A / B» в самом названии — сразу разбираем на русское + оригинал.
    const slash = slashOriginal(title);
    if (slash && slash.original) {
      title = stripWrapQuotes(slash.title);
      if (!year) {
        const ym = String(base.title).match(/\((\d{4})\)/);
        if (ym) year = ym[1];
      }
    }
    // Хвост вида «(2026) Werwulf» после названия.
    const tf = tailForm(title);
    if (tf) {
      title = tf.title;
      if (!year && tf.year) year = tf.year;
    }
    // Кандидаты в оригинал: скобки, хвост, слэш, JSON-LD, IMDb-данные, подпись,
    // строка у заголовка (Kinorium/HDRezka), og:title.
    const cands = [];
    if (pf && pf.original) cands.push(pf.original);
    if (tf && tf.original) cands.push(tf.original);
    if (slash && slash.original) cands.push(slash.original);
    cands.push(...jsonLdOriginals(title));
    const nd = nextDataOriginal(title);
    if (nd) cands.push(nd);
    const lab = labeledOriginal(title);
    if (lab) cands.push(lab);
    const tb = titleBlockOriginal(title);
    if (tb) cands.push(tb);
    const ct = copyTextOriginal();
    if (ct) cands.push(ct);
    try {
      const ogt = document.querySelector('meta[property="og:title"]')?.content?.trim();
      if (ogt && !sameTitle(ogt, title)) {
        const parsed = splitTitleYear(ogt);
        // Сырьём: скобки разберёт цикл ниже (чистить тут — убить «(2026, Werwulf)»).
        if (!hasLatin(title) && hasLatin(parsed.title) && parsed.title.length <= 200) cands.push(parsed.title);
      }
    } catch (e) { /* ignore */ }

    let originalTitle = '';
    for (const c of cands) {
      // Кандидат-мусор вида «X» (2026, Y) или «X (2026) Y» разбираем как название.
      const pc = parenForm(c) || tailForm(c);
      const t = (pc && pc.original) ? pc.original : cleanOriginal(c);
      if (t && !sameTitle(t, title)) { originalTitle = t; break; }
    }
    return { title, originalTitle, year };
  }

  function splitTitleYear(raw) {
    let t = raw.replace(/\s*-\s*(IMDb|Kinorium).*$/i, '').trim();
    let year = '';
    // Год в скобках, в т.ч. «(фильм, 2026)». Но не «(2026, Werwulf)» — это parenForm.
    const m = t.match(/\(\s*(?:[^()]*?,\s*)?(\d{4})\s*\)/);
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
    // HDRezka и её зеркала (в т.ч. свои из настроек): /films/, /series/, /cartoons/…
    // Отдельные серии там обычно на той же странице, JSON-LD/og:type выше уже покрыты.
    if (isRezkaHost()) {
      if (/\/(films?|series|movies?|cartoons?|animation|anime|shows?)\//i.test(location.href)) return true;
    }
    return false;
  }

  // Страницы серий/сезонов: поиск «Название S04E06» на других сайтах ничего
  // не находит, поэтому панель там не показываем вообще.
  function pageJsonTypes() {
    const types = [];
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          const arr = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
          for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            const t = o['@type'];
            if (typeof t === 'string') types.push(t);
            else if (Array.isArray(t)) types.push(...t);
          }
        } catch (e) { /* next script */ }
      }
    } catch (e) { /* ignore */ }
    return types;
  }

  function isEpisodeUrl() {
    const href = location.href;
    // Kinorium: /363924/episodes/s4e6/, IMDb: /title/tt.../episodes...
    if (/\/episodes?\//i.test(href)) return true;
    // TMDB и прочие: /tv/.../season/1, /season/1/episode/2, /episode/5
    if (/\/(season|episode)s?\/\d+/i.test(href)) return true;
    // Короткий вид s4e6 в пути
    if (/\/s\d{1,3}e\d{1,3}(\/|$|\?|#)/i.test(href)) return true;
    // ?season=4 / ?episode=2
    if (/[?&#](season|episode)=\d+/i.test(href)) return true;
    return false;
  }

  function isEpisodePage() {
    // На резке сезоны/серии — на той же странице тайтла, а TVEpisode в разметке
    // там норма: правило «прятать панель на страницах серий» к ней не применяем.
    if (isRezkaHost()) return false;
    if (isEpisodeUrl()) return true;
    // Отдельная страница серии со своим id (напр. свой /title/tt.../ у IMDb):
    // по URL от фильма не отличить, смотрим JSON-LD.
    try {
      if (pageJsonTypes().includes('TVEpisode')) return true;
    } catch (e) {}
    return false;
  }

  // Западным сайтам и трекерам — английское название, если оно есть:
  // «Оборотень» в TMDB не ищется, а «Werwulf» находится сразу. Своим и русским —
  // русское. Язык можно перебить у каждой ссылки в настройках (qLang).
  const EN_HOSTS = ['imdb.com', 'letterboxd.com', 'themoviedb.org', 'rottentomatoes.com', 'metacritic.com', 'justwatch.com', 'therarbg.com', 'ext.to', 'bt4g.org'];

  function wantsEnglish(link, tpl) {
    if (link.qLang === 'en') return true;
    if (link.qLang === 'ru') return false;
    try {
      const h = cleanHost(new URL(String(tpl).replace('%s', 'test')).hostname);
      return EN_HOSTS.some((e) => h === e || h.endsWith('.' + e));
    } catch (e) { return false; }
  }

  function pickQueryTitle(link, info, tpl) {
    if (wantsEnglish(link, tpl)) return info.originalTitle || info.title;
    return info.title || info.originalTitle;
  }

  function buildSearchUrl(link, info, tplOverride) {
    const tpl = tplOverride || effUrl(link);
    // Обычная ссылка без %s — открываем как есть (прямой переход, без подстановки).
    if (!String(tpl).includes('%s')) return tpl;
    // Некоторым сайтам год в запросе мешает (напр. TMDB) — для них только название.
    const base = pickQueryTitle(link, info, tpl);
    const q = (link.qmode === 'title' || !info.year) ? base : [base, info.year].join(' ');
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
    if (isEpisodePage()) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }
    if (closedForUrl === location.href) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }
    if (!isMoviePage()) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }

    const info = getMovieInfo();
    const { title, year } = info;
    if (!title) {
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
      return;
    }
    const headTitle = (info.originalTitle && !sameTitle(info.originalTitle, title))
      ? `${title} / ${info.originalTitle}` : title;
    const queryText = [headTitle, year].filter(Boolean).join(' ');

    // Запоминаем для кнопки «Копировать название» в настройках.
    try { chrome.storage.local.set({ [LAST_KEY]: { text: queryText, title, originalTitle: info.originalTitle || '', year, url: location.href, ts: Date.now() } }); } catch (e) {}

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
    const titleBox = el('div', 'cf-title', headTitle);
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

    // body groups: пустые (все выключены) не рисуем вообще
    const body = el('div', 'cf-body');
    for (const g of state.groups) {
      const picked = pickMainLink(g.links, myRoot) || {};
      const { main, all } = picked;
      if (!main) continue;
      const box = el('div', 'cf-group');

      const btn = el('button', 'cf-btn');
      const mainPart = el('span', 'cf-main');
      {
        const label = el('span', 'cf-label', main.name);
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
          window.open(buildSearchUrl(main, info), '_blank', 'noopener');
        };
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
            window.open(buildSearchUrl(link, info, tpl), '_blank', 'noopener');
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
