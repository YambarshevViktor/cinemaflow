// Background: health-check зеркал + открытие настроек из панели.
const HEALTH_KEY = 'cinemaflow_health_v1';
const CHECK_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    // no-cors: нас интересует только "отвечает / не отвечает", тело не читаем
    await fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function domainOf(urlTemplate) {
  try {
    const u = new URL(String(urlTemplate).replace('%s', 'test'));
    return u.hostname;
  } catch (e) {
    return null;
  }
}

// Свои зеркала HDRezka из настроек: домены заранее неизвестны, поэтому панель
// на них подключаем динамически. Регистрация переживает перезапуск
// (persistAcrossSessions), а тут — самолечение при установке/старте.
async function syncCustomScripts() {
  try {
    if (!chrome.scripting?.registerContentScripts) return;
    const got = await chrome.storage.local.get(['cinemaflow_state_v1', 'allfilm_state_v1']);
    const st = got['cinemaflow_state_v1'] || got['allfilm_state_v1'];
    const hosts = (st && st.customSiteHosts) || [];
    const id = 'cinemaflow-custom';
    try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) {}
    if (!hosts.length) return;
    const matches = [];
    for (const h of hosts) matches.push(`https://${h}/*`, `https://*.${h}/*`);
    await chrome.scripting.registerContentScripts([{
      id,
      matches,
      js: ['common/shared.js', 'content/panel.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  } catch (e) {}
}

try {
  chrome.runtime.onInstalled.addListener(() => syncCustomScripts());
  chrome.runtime.onStartup.addListener(() => syncCustomScripts());
} catch (e) {}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OPEN_SETTINGS') {
    // Панель живет в Shadow DOM, popup программно не открыть — открываем полную страницу настроек.
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg?.type === 'CHECK_HEALTH') {
    (async () => {
      try {
        const urls = Array.isArray(msg.urls) ? msg.urls : [];
        const results = {};
        await Promise.all(urls.map(async (tpl) => {
          try {
            const host = domainOf(tpl);
            if (!host) { results[tpl] = { alive: false, ts: Date.now() }; return; }
            const probe = `https://${host}/favicon.ico?t=${Date.now()}`;
            const alive = await fetchWithTimeout(probe, CHECK_TIMEOUT_MS);
            results[tpl] = { alive, ts: Date.now() };
          } catch (e) {
            results[tpl] = { alive: false, ts: Date.now() };
          }
        }));
        const prev = (await chrome.storage.local.get(HEALTH_KEY))[HEALTH_KEY] || {};
        const merged = { ...prev, ...results };
        await chrome.storage.local.set({ [HEALTH_KEY]: merged });
        sendResponse?.({ ok: true, results: merged });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async response
  }
});
