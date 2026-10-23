// Стартовая страница: показывает все доски пользователя, позволяет создать
// новую доску и удалить существующую. Ниже — раздел «Доступные мне»: чужие
// доски, к которым пользователю открыли доступ (вкладки «Мои доски |
// Доступные мне» и уведомление о новых досках).

const boardsGrid = document.getElementById('boards-grid');

// --- Переключатель темы ---
const themeToggleBtn = document.getElementById('theme-toggle');

const ICONS = {
  sun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  move: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h14l-4-4M20 16H6l4 4"/></svg>',
  arrowUp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  arrowDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  arrowLeft: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  pencil: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z"/><path d="M14.5 5.5l3 3"/></svg>',
  users: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/></svg>',
  plusLarge: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrowRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
};

// Цвета отрезков полоски на плитке — те же, что у точек в заголовках столбцов доски
const COLUMN_DOT_COLORS = ['#ff9999', '#0fbcb0', '#4262ff', '#00b473', '#5b76fe', '#fcb900'];

function updateThemeButton() {
  const isDark = window.KanbanTheme.getTheme() === 'dark';
  themeToggleBtn.innerHTML = (isDark ? ICONS.sun : ICONS.moon) +
    '<span>' + (isDark ? 'Светлая тема' : 'Тёмная тема') + '</span>';
}

themeToggleBtn.addEventListener('click', () => {
  window.KanbanTheme.toggleTheme();
  updateThemeButton();
});

updateThemeButton();


function wordForTasks(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задача';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'задачи';
  return 'задач';
}

// Создать доску: плитка «Создать доску» и круглая кнопка «+» внизу справа
async function createBoardFlow() {
  // гость: создание доски создаёт аккаунт — сначала окно «Как вас зовут?»
  if (window.KanbanAccount) await window.KanbanAccount.askNameIfGuest('board_create');
  const name = await window.KanbanDialog.prompt({
    title: 'Новая доска',
    value: 'Новая доска',
    placeholder: 'Название доски',
    confirmLabel: 'Создать',
    maxLength: 60
  });
  if (name === null) return;
  const title = name.trim() || 'Новая доска';
  try {
    const res = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const data = await res.json();
    if (data.id) {
      window.location.href = `/board/${data.id}`;
    }
  } catch (err) {
    console.error('Не удалось создать доску:', err);
  }
}

let addTileEl = null;

function createAddTile() {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'add-board-tile';
  tile.innerHTML = '<span class="add-board-pill">' + ICONS.plus + 'Создать доску</span>';
  tile.addEventListener('click', createBoardFlow);
  addTileEl = tile;
  watchAddTile(tile);
  return tile;
}

// --- Круглая кнопка «+» в правом нижнем углу экрана ---
// Видна, когда плитка «Создать доску» за пределами экрана (досок много);
// как только плитка хоть краем показалась — кнопка пропадает. На вкладке
// «Доступные мне» кнопки нет: там доски не создают.
const addFab = document.createElement('button');
addFab.type = 'button';
addFab.className = 'add-board-fab';
addFab.innerHTML = ICONS.plusLarge;
addFab.title = 'Создать доску';
addFab.setAttribute('aria-label', 'Создать доску');
addFab.addEventListener('click', createBoardFlow);
document.body.appendChild(addFab);

let addTileOnScreen = true;
let addTileObserver = null;

function updateAddFab() {
  const show = !!addTileEl && !addTileOnScreen && activeTab === 'own';
  addFab.classList.toggle('visible', show);
  // скрытую кнопку нельзя нажать и до неё не дойти клавишей Tab
  addFab.tabIndex = show ? 0 : -1;
  addFab.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function watchAddTile(tile) {
  if (!('IntersectionObserver' in window)) return; // очень старый браузер — без кнопки
  if (addTileObserver) addTileObserver.disconnect();
  addTileObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => { addTileOnScreen = entry.isIntersecting; });
    updateAddFab();
  });
  addTileObserver.observe(tile);
}

function wordForPeople(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'пользователю';
  return 'пользователям';
}

// shared — чужая доска из раздела «Доступные мне»: открывается по адресу
// /board/<владелец>/<доска>, не перетаскивается, крестик убирает её из списка
function createBoardTile(board, shared = false) {
  const tile = document.createElement('a');
  tile.className = 'board-tile';
  tile.href = shared ? `/board/${board.owner}/${board.id}` : `/board/${board.id}`;
  tile.dataset.id = board.id;
  if (shared) tile.dataset.owner = board.owner;
  tile.draggable = !shared;
  // плитка окрашивается в цвет фона доски (если он задан)
  if (board.background) {
    tile.dataset.bg = board.background;
  }

  const title = document.createElement('div');
  title.className = 'board-tile-title';
  title.textContent = board.title;
  // название длиннее двух строк обрезается — полное во всплывающей подсказке
  title.title = board.title;

  // Низ плитки: общее число задач и полоска — по отрезку на столбец,
  // ширина отрезка пропорциональна числу задач в нём (пустые столбцы не видны).
  // Цвет отрезка — цвет точки столбца на доске (по порядку столбцов).
  const meta = document.createElement('div');
  meta.className = 'board-tile-meta';

  const tasksCount = board.tasks_count || 0;
  const count = document.createElement('div');
  count.className = 'board-tile-count';
  count.textContent = `${tasksCount} ${wordForTasks(tasksCount)}`;

  const bar = document.createElement('div');
  bar.className = 'board-tile-bar';
  const columns = board.columns || [];
  if (tasksCount > 0) {
    bar.setAttribute('aria-label', 'По столбцам: ' + columns.map(c => `${c.title} — ${c.count}`).join(', '));
    columns.forEach((col, i) => {
      if (!col.count) return;
      const seg = document.createElement('span');
      seg.className = 'board-tile-bar-seg';
      seg.style.flexGrow = col.count;
      seg.style.background = COLUMN_DOT_COLORS[i % COLUMN_DOT_COLORS.length];
      seg.title = `${col.title}: ${col.count}`;
      bar.appendChild(seg);
    });
  } else {
    const empty = document.createElement('span');
    empty.className = 'board-tile-bar-empty';
    bar.title = 'Нет задач';
    bar.appendChild(empty);
  }

  const countRow = document.createElement('div');
  countRow.className = 'board-tile-count-row';
  countRow.appendChild(count);
  // своя доска, открытая другим, — значок с числом пользователей
  if (!shared && board.sharedWith > 0) {
    const badge = document.createElement('span');
    badge.className = 'board-tile-shared';
    badge.innerHTML = ICONS.users + '<span></span>';
    badge.lastChild.textContent = board.sharedWith;
    badge.title = `Доступ открыт ${board.sharedWith} ${wordForPeople(board.sharedWith)}`;
    countRow.appendChild(badge);
  }
  // чужая доска (раздел «Доступные мне») — справа логин владельца
  if (shared) {
    const owner = document.createElement('span');
    owner.className = 'board-tile-owner';
    owner.innerHTML = ICONS.users + '<span></span>';
    owner.lastChild.textContent = board.ownerName;
    owner.title = `Доска пользователя ${board.ownerName}`;
    countRow.appendChild(owner);
  }
  meta.appendChild(countRow);
  meta.appendChild(bar);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'board-tile-delete';
  deleteBtn.innerHTML = ICONS.close;
  deleteBtn.title = shared ? 'Убрать у себя' : 'Удалить доску';
  deleteBtn.setAttribute('aria-label', deleteBtn.title);
  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (shared) {
      await leaveSharedBoard(board, tile);
      return;
    }
    // гость: удаление доски создаёт аккаунт — сначала «Как вас зовут?»
    if (window.KanbanAccount) await window.KanbanAccount.askNameIfGuest('board_delete');
    const ok = await window.KanbanDialog.confirm({
      title: `Удалить доску «${board.title}»?`,
      message: 'Все столбцы и карточки этой доски будут удалены. Это действие нельзя отменить.',
      confirmLabel: 'Удалить'
    });
    if (!ok) return;
    try {
      await fetch(`/api/boards/${board.id}`, { method: 'DELETE' });
      tile.remove();
      renderChangesBanner();
      refreshEmptyHint();
    } catch (err) {
      console.error('Не удалось удалить доску:', err);
    }
  });

  // «Переместить» — только на сенсорных экранах (там не работает перетаскивание
  // мышью): меню «Выше / Ниже» (или «Левее / Правее», если плитки стоят в ряд)
  const moveWrap = document.createElement('div');
  moveWrap.className = 'board-tile-move-wrap';
  const moveBtn = document.createElement('button');
  moveBtn.type = 'button';
  moveBtn.className = 'board-tile-move';
  moveBtn.innerHTML = ICONS.move;
  moveBtn.title = 'Переместить';
  moveBtn.setAttribute('aria-label', 'Переместить доску');
  const moveMenu = document.createElement('div');
  moveMenu.className = 'tile-menu';
  moveMenu.hidden = true;
  moveWrap.appendChild(moveBtn);
  moveWrap.appendChild(moveMenu);

  function tileItem(icon, label, disabled, onPick) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tile-menu-item';
    item.innerHTML = icon + '<span></span>';
    item.lastChild.textContent = label;
    item.disabled = disabled;
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTileMenus();
      if (!disabled) onPick();
    });
    return item;
  }

  moveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = !moveMenu.hidden;
    closeTileMenus();
    if (wasOpen) return;
    const prev = tile.previousElementSibling;
    const next = tile.nextElementSibling && tile.nextElementSibling.classList.contains('board-tile')
      ? tile.nextElementSibling : null;
    const top = tile.getBoundingClientRect().top;
    const sameRow = (other) => other && Math.abs(other.getBoundingClientRect().top - top) < 5;
    moveMenu.innerHTML = '';
    moveMenu.appendChild(tileItem(sameRow(prev) ? ICONS.arrowLeft : ICONS.arrowUp,
      sameRow(prev) ? 'Левее' : 'Выше', !prev, () => {
        boardsGrid.insertBefore(tile, prev);
        afterTileShift(tile);
      }));
    moveMenu.appendChild(tileItem(sameRow(next) ? ICONS.arrowRight : ICONS.arrowDown,
      sameRow(next) ? 'Правее' : 'Ниже', !next, () => {
        boardsGrid.insertBefore(tile, next.nextElementSibling);
        afterTileShift(tile);
      }));
    moveMenu.hidden = false;
  });

  const head = document.createElement('div');
  head.className = 'board-tile-head';
  head.appendChild(title);
  if (!shared) head.appendChild(moveWrap);
  head.appendChild(deleteBtn);

  tile.appendChild(head);
  tile.appendChild(meta);
  // чужая доска, которую ещё не открывали, — отметка «Новая»
  // Шаблонная доска у гостя (до создания аккаунта) — плашка «Образец»
  // (так же, как «Новая»)
  const badgeText = shared && board.isNew ? 'Новая' : (!shared && board.template ? 'Образец' : '');
  if (badgeText) {
    tile.classList.add('board-tile-new');
    if (!shared) tile.classList.add('board-tile-template');
    const badge = document.createElement('span');
    badge.className = 'board-tile-new-badge';
    badge.textContent = badgeText;
    tile.appendChild(badge);
  }
  return tile;
}

// Убрать чужую доску у себя из раздела «Доступные мне» (доступ закрывается;
// снова открыть его может только владелец)
async function leaveSharedBoard(board, tile) {
  const ok = await window.KanbanDialog.confirm({
    title: `Убрать доску «${board.title}»?`,
    message: `Доска пропадёт из вашего списка. Снова открыть вам доступ сможет только её владелец — ${board.ownerName}.`,
    confirmLabel: 'Убрать'
  });
  if (!ok) return;
  try {
    await fetch(`/api/board/${board.id}/access/me?owner=${encodeURIComponent(board.owner)}`, { method: 'DELETE' });
    tile.remove();
    renderChangesBanner();
    refreshSharedSection();
  } catch (err) {
    console.error('Не удалось убрать доску:', err);
  }
}

const sharedSection = document.getElementById('shared-section');
const sharedGrid = document.getElementById('shared-grid');

// --- Вкладки «Мои доски | Доступные мне» ---
// Показываются, только если есть чужие доски, к которым вам открыли доступ.
// Выбранная вкладка запоминается в браузере.
const boardTabs = document.getElementById('board-tabs');
const tabButtons = boardTabs.querySelectorAll('.board-tab');
const sharedCount = document.getElementById('shared-count');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const TAB_KEY = 'kanban-start-tab';
const TAB_TEXT = {
  own: { title: 'Мои доски', subtitle: 'Выберите одну или создайте новую.' },
  shared: { title: 'Доступные мне', subtitle: 'Доски, которые вам открыли другие пользователи.' }
};

function readSavedTab() {
  try { return localStorage.getItem(TAB_KEY) === 'shared' ? 'shared' : 'own'; } catch (e) { return 'own'; }
}

let activeTab = readSavedTab();

function hasSharedBoards() {
  return !!sharedGrid.querySelector('.board-tile');
}

function setTab(tab, remember = true) {
  if (tab === 'shared' && !hasSharedBoards()) tab = 'own';
  activeTab = tab;
  if (remember) {
    try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* без запоминания */ }
  }
  tabButtons.forEach(btn => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  boardsGrid.hidden = tab !== 'own';
  sharedSection.hidden = tab !== 'shared';
  if (emptyHintEl) emptyHintEl.hidden = tab !== 'own';
  pageTitle.textContent = TAB_TEXT[tab].title;
  pageSubtitle.textContent = TAB_TEXT[tab].subtitle;
  document.title = TAB_TEXT[tab].title;
  renderSharedBanner();
  updateAddFab();
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
  // стрелки влево/вправо — переход между вкладками
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = btn.dataset.tab === 'own' ? 'shared' : 'own';
    setTab(next);
    boardTabs.querySelector(`[data-tab="${next}"]`).focus();
  });
});

// Вкладки видны, только если есть чужие доски; на вкладке — их число,
// точка — среди них есть новые (ещё не открытые)
function refreshSharedSection() {
  const tiles = sharedGrid.querySelectorAll('.board-tile');
  boardTabs.hidden = tiles.length === 0;
  sharedCount.textContent = tiles.length ? String(tiles.length) : '';
  const tabShared = document.getElementById('tab-shared');
  tabShared.classList.toggle('has-new', !!sharedGrid.querySelector('.board-tile-new'));
  setTab(tiles.length ? activeTab : 'own', false);
}

// --- Уведомление о новых досках ---
// Вам открыли доступ к доске, а вы её ещё не открывали и уведомление не
// закрывали. Одна доска — «Открыть», несколько — «Посмотреть» (вкладка).
const sharedBanner = document.getElementById('shared-banner');
let bannerBoards = [];

function phraseNewBoards(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? `${n} новой доске` : `${n} новым доскам`;
}

function renderSharedBanner() {
  // доски, которые убрали у себя, в уведомлении не нужны
  bannerBoards = bannerBoards.filter(b =>
    sharedGrid.querySelector(`.board-tile[data-owner="${b.owner}"][data-id="${b.id}"]`));
  sharedBanner.hidden = bannerBoards.length === 0;
  if (sharedBanner.hidden) return;
  sharedBanner.innerHTML = '';

  const icon = document.createElement('span');
  icon.className = 'shared-banner-icon';
  icon.innerHTML = ICONS.users;
  const text = document.createElement('div');
  text.className = 'shared-banner-text';
  const title = document.createElement('div');
  title.className = 'shared-banner-title';
  const message = document.createElement('div');
  message.className = 'shared-banner-message';
  text.appendChild(title);
  text.appendChild(message);

  const action = document.createElement('a');
  action.className = 'shared-banner-btn';
  if (bannerBoards.length === 1) {
    const b = bannerBoards[0];
    title.textContent = `Вам открыли доступ к доске «${b.title}»`;
    message.textContent = `Владелец — ${b.ownerName}. Доска — во вкладке «Доступные мне».`;
    action.textContent = 'Открыть';
    action.href = `/board/${b.owner}/${b.id}`;
  } else {
    title.textContent = `Вам открыли доступ к ${phraseNewBoards(bannerBoards.length)}`;
    message.textContent = 'Они — во вкладке «Доступные мне», новые отмечены.';
    action.textContent = 'Посмотреть';
    action.href = '#';
    action.addEventListener('click', (e) => {
      e.preventDefault();
      setTab('shared');
    });
    // уже на этой вкладке — кнопка не нужна
    action.hidden = activeTab === 'shared';
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'shared-banner-close';
  close.innerHTML = ICONS.close;
  close.title = 'Закрыть уведомление';
  close.setAttribute('aria-label', close.title);
  close.addEventListener('click', () => {
    bannerBoards = [];
    sharedBanner.hidden = true;
    // отметка «Новая» на плитках остаётся, пока доску не откроют
    fetch('/api/shared/notified', { method: 'POST' }).catch(() => {});
  });

  sharedBanner.appendChild(icon);
  sharedBanner.appendChild(text);
  sharedBanner.appendChild(action);
  sharedBanner.appendChild(close);
}

// --- Уведомление «Доску изменил …» ---
// Общую доску (свою, открытую другим, или чужую) правил другой участник,
// пока она не была открыта у вас. Одна доска — «Открыть», несколько —
// список досок со ссылками. Крестик — больше не напоминать об этих правках
// (о следующих правках уведомление придёт снова).
const changesBanner = document.getElementById('changes-banner');
let changeBoards = [];
const MAX_CHANGE_LINES = 4;

function changeUrl(c) {
  return c.owner ? `/board/${c.owner}/${c.id}` : `/board/${c.id}`;
}

function editorsText(names) {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} и ${names[1]}`;
  return `${names[0]}, ${names[1]} и ещё ${names.length - 2}`;
}

function agoText(seconds) {
  const min = Math.floor(seconds / 60);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return few;
  return many;
}

function boardStillListed(c) {
  // доску могли удалить или убрать у себя прямо на этой странице
  const grid = c.owner ? sharedGrid : boardsGrid;
  const sel = c.owner ? `.board-tile[data-owner="${c.owner}"][data-id="${c.id}"]` : `.board-tile[data-id="${c.id}"]`;
  return !!grid.querySelector(sel);
}

function renderChangesBanner() {
  changeBoards = changeBoards.filter(boardStillListed);
  changesBanner.hidden = changeBoards.length === 0;
  if (changesBanner.hidden) return;
  changesBanner.innerHTML = '';

  const icon = document.createElement('span');
  icon.className = 'shared-banner-icon';
  icon.innerHTML = ICONS.pencil;
  const text = document.createElement('div');
  text.className = 'shared-banner-text';
  const title = document.createElement('div');
  title.className = 'shared-banner-title';
  const message = document.createElement('div');
  message.className = 'shared-banner-message';
  text.appendChild(title);
  text.appendChild(message);
  changesBanner.appendChild(icon);
  changesBanner.appendChild(text);

  if (changeBoards.length === 1) {
    const c = changeBoards[0];
    const many = c.editors.length > 1;
    title.textContent = `Доску «${c.title}» ${many ? 'изменили' : 'изменил пользователь'} ${editorsText(c.editors)}`;
    message.textContent = `Последняя правка — ${agoText(c.ago)}.`;
    const open = document.createElement('a');
    open.className = 'shared-banner-btn';
    open.textContent = 'Открыть';
    open.href = changeUrl(c);
    changesBanner.appendChild(open);
  } else {
    title.textContent = `Изменения на ${changeBoards.length} ${plural(changeBoards.length, 'общей доске', 'общих досках', 'общих досках')}`;
    const list = document.createElement('ul');
    list.className = 'changes-list';
    changeBoards.slice(0, MAX_CHANGE_LINES).forEach(c => {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = changeUrl(c);
      link.textContent = `«${c.title}»`;
      li.appendChild(link);
      li.appendChild(document.createTextNode(` — ${editorsText(c.editors)}, ${agoText(c.ago)}`));
      list.appendChild(li);
    });
    if (changeBoards.length > MAX_CHANGE_LINES) {
      const li = document.createElement('li');
      li.textContent = `и ещё ${changeBoards.length - MAX_CHANGE_LINES}`;
      list.appendChild(li);
    }
    message.appendChild(list);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'shared-banner-close';
  close.innerHTML = ICONS.close;
  close.title = 'Закрыть уведомление';
  close.setAttribute('aria-label', close.title);
  close.addEventListener('click', () => {
    const shown = changeBoards.map(c => ({ owner: c.owner, id: c.id }));
    changeBoards = [];
    changesBanner.hidden = true;
    fetch('/api/activity/notified', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boards: shown })
    }).catch(() => {});
  });
  changesBanner.appendChild(close);
}

function closeTileMenus() {
  document.querySelectorAll('.tile-menu').forEach(m => { m.hidden = true; });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.board-tile-move-wrap')) closeTileMenus();
});

// Плитку сдвинули кнопкой «Переместить»: сохраняем порядок и подсвечиваем её
async function afterTileShift(tile) {
  tile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  tile.classList.remove('tile-moved');
  void tile.offsetWidth;
  tile.classList.add('tile-moved');
  setTimeout(() => tile.classList.remove('tile-moved'), 1200);
  await saveBoardsOrder(currentOrder());
}

// Сохранить порядок досок (гостю перестановка создаёт аккаунт — сначала окно имени)
async function saveBoardsOrder(ids) {
  if (window.KanbanAccount) await window.KanbanAccount.askNameIfGuest('board_order');
  try {
    await fetch('/api/boards/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
  } catch (err) {
    console.error('Не удалось сохранить порядок досок:', err);
  }
}

let emptyHintEl = null;

function refreshEmptyHint() {
  const hasBoards = boardsGrid.querySelectorAll('.board-tile').length > 0;
  if (!hasBoards && !emptyHintEl) {
    emptyHintEl = document.createElement('div');
    emptyHintEl.className = 'empty-hint';
    emptyHintEl.textContent = 'Пока нет ни одной доски — создайте первую.';
    emptyHintEl.hidden = activeTab !== 'own';
    boardsGrid.parentElement.insertBefore(emptyHintEl, boardsGrid);
  } else if (hasBoards && emptyHintEl) {
    emptyHintEl.remove();
    emptyHintEl = null;
  }
}

async function loadBoards() {
  try {
    const res = await fetch('/api/boards');
    const data = await res.json();
    const boards = data.boards || [];

    boards.forEach(board => {
      boardsGrid.appendChild(createBoardTile(board));
    });
    boardsGrid.appendChild(createAddTile());
    refreshEmptyHint();

    // чужие доски, к которым открыт доступ
    (data.shared || []).forEach(board => {
      sharedGrid.appendChild(createBoardTile(board, true));
    });
    bannerBoards = (data.shared || []).filter(b => b.notify);
    refreshSharedSection();
    changeBoards = data.changes || [];
    renderChangesBanner();
  } catch (err) {
    console.error('Не удалось загрузить список досок:', err);
    boardsGrid.appendChild(createAddTile());
  }
}

loadBoards();

// Гость создал аккаунт (окно имени, пароль, первое изменение): шаблонные
// доски скопированы в его пространство и стали его досками — плашки
// «Образец» больше не нужны
window.addEventListener('kanban:account-created', () => {
  document.querySelectorAll('.board-tile-template').forEach(tile => {
    tile.classList.remove('board-tile-template', 'board-tile-new');
    const badge = tile.querySelector('.board-tile-new-badge');
    if (badge) badge.remove();
  });
});

// Открыли недействующую ссылку-приглашение на доску (её выключили или
// заменили новой) — сервер вернул сюда с ?invite=invalid
if (new URLSearchParams(window.location.search).get('invite') === 'invalid') {
  history.replaceState(null, '', '/');
  window.KanbanDialog.alert({
    title: 'Ссылка не действует',
    message: 'Ссылку на доску выключили или заменили новой. Попросите владельца доски прислать новую ссылку.'
  });
}

// --- Перетаскивание плиток досок (меняет порядок, сохраняется на сервере) ---
let draggedTile = null;
let orderBeforeDrag = '';

function currentOrder() {
  return [...boardsGrid.querySelectorAll('.board-tile')].map(t => t.dataset.id);
}

boardsGrid.addEventListener('dragstart', (e) => {
  const tile = e.target.closest && e.target.closest('.board-tile');
  if (!tile) return;
  draggedTile = tile;
  orderBeforeDrag = currentOrder().join(',');
  e.dataTransfer.effectAllowed = 'move';
  // без данных Safari/Firefox могут не начать перетаскивание
  e.dataTransfer.setData('text/plain', tile.dataset.id);
  // класс на следующем тике: браузер уже снял «картинку» плитки для курсора
  setTimeout(() => { if (draggedTile === tile) tile.classList.add('dragging'); }, 0);
});

boardsGrid.addEventListener('dragover', (e) => {
  if (!draggedTile) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest && e.target.closest('.board-tile, .add-board-tile');
  if (!target || target === draggedTile) return;
  if (target.classList.contains('add-board-tile')) {
    // плитка «Создать доску» всегда последняя — ставим перед ней
    boardsGrid.insertBefore(draggedTile, target);
    return;
  }
  const rect = target.getBoundingClientRect();
  const before = e.clientX < rect.left + rect.width / 2;
  const ref = before ? target : target.nextSibling;
  if (ref !== draggedTile) {
    boardsGrid.insertBefore(draggedTile, ref);
  }
});

boardsGrid.addEventListener('drop', (e) => {
  if (draggedTile) e.preventDefault();
});

boardsGrid.addEventListener('dragend', async () => {
  if (!draggedTile) return;
  draggedTile.classList.remove('dragging');
  draggedTile = null;
  const ids = currentOrder();
  if (ids.join(',') === orderBeforeDrag) return; // порядок не изменился
  saveBoardsOrder(ids);
});

// При возврате на стартовую страницу кнопкой браузера «Назад» страница может
// быть показана из кэша (bfcache) со старыми плитками — например, без нового
// цвета фона доски. В этом случае перезагружаем её, чтобы данные были свежими.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    window.location.reload();
  }
});
