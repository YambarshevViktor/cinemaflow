// CinemaFlow shared: словарь RU/EN + helpers каталога. Грузится и попапом, и панелью.
window.CF_STRINGS = {
  ru: {
    close_next: 'Закрыть до следующего фильма',
    copy: '⧉ Копировать название',
    copied: '✓ Скопировано',
    copy_fail: 'Не вышло',
    check: 'Проверить зеркала',
    checking: 'Проверяю…',
    settings: 'Настройки',
    none_enabled: '{g}: нет включенных',
    here: 'вы здесь',
    down: 'не отвечает',
    up: 'отвечает',
    unchecked: 'не проверено',
    via: 'через {h}',
    hint: 'Галочка — показать в панели. Порядок в списке = порядок в кнопке. Первая живая и не текущая — на главной кнопке.',
    reset: 'Сброс',
    reset_title: 'Вернуть списки по умолчанию',
    saved: 'Сохранено',
    added: 'Добавлено',
    removed: 'Удалено',
    defaults_done: 'Сброшено к дефолту',
    done: 'Готово',
    failed: 'Не вышло',
    paste: 'Вставьте ссылку',
    bad_url: 'Некорректная ссылка',
    show_in_panel: 'Показывать в панели',
    toggle_all: 'Включить/выключить все ссылки кнопки',
    move_to: 'Кнопка (перенести ссылку)',
    rename_group: 'Переименовать кнопку',
    title_ru_ph: 'Название кнопки (RU)',
    title_en_ph: 'Название кнопки (EN)',
    order: 'Порядок в кнопке',
    move_up: 'Выше',
    move_down: 'Ниже',
    remove: 'Удалить',
    custom: 'своя',
    name_ph: 'Название (необязательно)',
    url_ph: 'Ссылка: https://site/search/%s или просто https://site',
    add: '+ Добавить',
    add_mirror: '+ зеркало',
    mirror_ph: 'Зеркало: https:// … /search/%s',
    no_title: 'Нет названия — откройте страницу фильма',
    edit: 'Изменить',
    save_btn: 'Сохранить',
    cancel: 'Отмена',
    q_auto: 'Название + год',
    q_title: 'Только название',
    hidden_here: 'CinemaFlow скрыт здесь',
    show: 'Показать',
    sites: 'Сайты, где появляется панель',
    updated: 'изм.'
  },
  en: {
    close_next: 'Close until next title',
    copy: '⧉ Copy title',
    copied: '✓ Copied',
    copy_fail: 'Failed',
    check: 'Check mirrors',
    checking: 'Checking…',
    settings: 'Settings',
    none_enabled: '{g}: nothing enabled',
    here: 'you are here',
    down: 'down',
    up: 'up',
    unchecked: 'not checked',
    via: 'via {h}',
    hint: 'Tick to show in the panel. List order = button order. First live, non-current link goes on the main button.',
    reset: 'Reset',
    reset_title: 'Restore default lists',
    saved: 'Saved',
    added: 'Added',
    removed: 'Removed',
    defaults_done: 'Reset to defaults',
    done: 'Done',
    failed: 'Failed',
    paste: 'Paste a link',
    bad_url: 'Invalid link',
    show_in_panel: 'Show in the panel',
    toggle_all: 'Enable/disable all links on the button',
    move_to: 'Button (move the link)',
    rename_group: 'Rename button',
    title_ru_ph: 'Button label (RU)',
    title_en_ph: 'Button label (EN)',
    order: 'Order on the button',
    move_up: 'Move up',
    move_down: 'Move down',
    remove: 'Remove',
    custom: 'custom',
    name_ph: 'Name (optional)',
    url_ph: 'Link: https://site/search/%s or a plain https://site',
    add: '+ Add',
    add_mirror: '+ mirror',
    mirror_ph: 'Mirror: https:// … /search/%s',
    no_title: 'No title yet — open a movie page',
    edit: 'Edit',
    save_btn: 'Save',
    cancel: 'Cancel',
    q_auto: 'Title + year',
    q_title: 'Title only',
    hidden_here: 'CinemaFlow hidden here',
    show: 'Show',
    sites: 'Sites where the panel appears',
    updated: 'upd.'
  }
};

window.CF_T = function (lang, key, vars) {
  const dict = window.CF_STRINGS || {};
  let s = (dict[lang] && dict[lang][key]) || (dict.ru && dict.ru[key]) || key;
  if (vars) {
    for (const k of Object.keys(vars)) s = String(s).split('{' + k + '}').join(String(vars[k]));
  }
  return s;
};

// Слияние сохраненного состояния с новым каталогом: свои ссылки и галочки
// сохраняются, новые встроенные добавляются, удаленные из каталога и
// удаленные пользователем чистятся, шаблоны встроенных (url/mirrors)
// обновляются. Возвращает новое состояние.
window.CF_MERGE = function (saved, catalog) {
  const removed = new Set((saved && saved.removed) || []);
  const out = { v: catalog.v || 1, lang: (saved && saved.lang) || 'ru', removed: [...removed], hidden: (saved && saved.hidden) || [], groups: [] };
  const savedGroups = {};
  if (saved && Array.isArray(saved.groups)) {
    for (const g of saved.groups) if (g && g.id) savedGroups[g.id] = g;
  }
  // Карта переехавших ссылок: id встроенной ссылки -> id группы, куда её положил
  // пользователь. Чтобы каталог не возвращал её обратно в родную группу дублем.
  const movedTo = {};
  if (saved && Array.isArray(saved.groups)) {
    for (const sg of saved.groups) {
      if (!sg || !sg.id || !Array.isArray(sg.links)) continue;
      for (const sl of sg.links) {
        if (!sl || !sl.id || !sl.builtin) continue;
        const home = (catalog.groups || []).find((cg) => (cg.links || []).some((l) => l.id === sl.id));
        if (home && home.id !== sg.id) movedTo[sl.id] = sg.id;
      }
    }
  }
  for (const cg of catalog.groups || []) {
    const sg = savedGroups[cg.id];
    const links = [];
    const seen = new Set();
    if (sg && Array.isArray(sg.links)) {
      for (const sl of sg.links) {
        if (!sl || !sl.id) continue;
        const cl = (cg.links || []).find((l) => l.id === sl.id);
        if (sl.builtin && removed.has(sl.id)) continue; // удалена пользователем
        if (sl.builtin && !cl) {
          // Встроенной нет в этой группе каталога: либо убрана из каталога,
          // либо переехала в другую кнопку.
          if (movedTo[sl.id] !== cg.id) continue;
          links.push({ ...sl, enabled: sl.enabled !== false }); // наша переехавшая — храним как есть
          seen.add(sl.id);
          continue;
        }
        if (movedTo[sl.id] && movedTo[sl.id] !== cg.id) continue; // переехала в другую кнопку
        if (cl) {
          if (sl.edited) {
            // пользователь правит шаблон сам — каталог его не трогает
            links.push({ ...sl, enabled: sl.enabled !== false });
          } else {
            const hiddenM = new Set(sl.hiddenMirrors || []);
            const mirrors = [...((cl.mirrors) || []), ...((sl.mirrors) || [])]
              .filter((u, i, a) => u && a.indexOf(u) === i && !hiddenM.has(u));
            links.push({ ...cl, enabled: sl.enabled !== false, name: sl.name || cl.name, mirrors, hiddenMirrors: sl.hiddenMirrors, updatedAt: sl.updatedAt });
          }
        }
        else links.push(sl); // своя
        seen.add(sl.id);
      }
    }
    for (const cl of cg.links || []) {
      if (seen.has(cl.id) || removed.has(cl.id)) continue;
      if (movedTo[cl.id] && movedTo[cl.id] !== cg.id) continue; // переехала в другую кнопку
      links.push({ ...cl });
    }
    // Миграция со старого showInPanel: спрятанная кнопка = все ссылки выключены.
    if (sg && sg.showInPanel === false) links.forEach((l) => { l.enabled = false; });
    // Своё название переживает обновления каталога.
    // titleEdited = пользователь переименовал сам — каталог название не трогает.
    const titleEdited = !!(sg && sg.titleEdited);
    out.groups.push({
      id: cg.id,
      title: (titleEdited && sg.title) ? sg.title : cg.title,
      title_en: (titleEdited && sg.title_en) ? sg.title_en : cg.title_en,
      titleEdited,
      links,
    });
  }
  return out;
};

// Первый живой URL среди основного и зеркал, иначе основной.
window.CF_EFFECTIVE = function (link, health) {
  const cands = [link.url, ...((link && link.mirrors) || [])].filter(Boolean);
  return cands.find((u) => (health || {})[u]?.alive !== false) || link.url;
};

// Иконка сервиса: буква в цветном кружке, поверх — favicon (если прогрузился).
// Вместо битого «глобуса» всегда остается аккуратная буква.
window.CF_ICON = function (name, favUrl) {
  const wrap = document.createElement('span');
  wrap.className = 'cf-ico';
  const letter = document.createElement('span');
  letter.className = 'cf-ico-l';
  const ch = (String(name || '').trim().charAt(0) || '?').toUpperCase();
  letter.textContent = ch;
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  letter.style.background = `hsl(${h} 55% 45%)`;
  wrap.appendChild(letter);
  if (favUrl) {
    const img = document.createElement('img');
    img.className = 'cf-ico-i';
    img.src = favUrl;
    img.alt = '';
    img.onerror = () => img.remove();
    wrap.appendChild(img);
  }
  return wrap;
};
