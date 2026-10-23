// Аккаунт на стартовой странице: кнопка с логином, меню
// аккаунта (сменить логин — один раз, задать/сменить пароль, отключить
// Telegram, выйти), кнопка «Telegram» (доски в Telegram-боте),
// кнопка «Войти» (только у гостя) и напоминание
// задать пароль, пока он не задан.
(function () {
  const ICONS = {
    user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
  };

  const accountBtn = document.getElementById('account-btn');
  const menu = document.getElementById('account-menu');
  const banner = document.getElementById('password-banner');
  const loginBtn = document.getElementById('login-btn');
  const telegramBtn = document.getElementById('telegram-btn');
  // Telegram пока скрыт: и кнопка на стартовой странице, и пункт «Отключить
  // Telegram» в меню аккаунта (код бота и привязки остаётся рабочим).
  // Чтобы вернуть — поставить true.
  const SHOW_TELEGRAM_BUTTON = false;

  let account = null;

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    return { ok: res.ok, data };
  }

  // Подсказка «Если у вас уже есть аккаунт» под кнопкой «Войти» — гостю при
  // каждом открытии стартовой страницы. Пропадает при первом действии:
  // клике/касании где угодно или нажатии клавиши; прокрутка — не действие
  // (человек ещё разглядывает доски).
  let loginHint = null;

  function showLoginHint() {
    if (loginHint) return;
    loginHint = document.createElement('div');
    loginHint.className = 'login-hint';
    loginHint.setAttribute('role', 'note');
    loginHint.textContent = 'Если у вас уже есть аккаунт';
    loginBtn.parentElement.appendChild(loginHint);
    // выноска — под кнопкой «Войти», стрелочка указывает на её середину
    loginHint.style.left = loginBtn.offsetLeft + 'px';
    loginHint.style.setProperty('--arrow-left', Math.round(loginBtn.offsetWidth / 2) + 'px');
    requestAnimationFrame(() => loginHint.classList.add('visible'));
    // click (а не pointerdown): на телефоне прокрутка пальцем кликом не считается
    document.addEventListener('click', hideLoginHint, true);
    document.addEventListener('keydown', hideLoginHint, true);
  }

  function hideLoginHint() {
    document.removeEventListener('click', hideLoginHint, true);
    document.removeEventListener('keydown', hideLoginHint, true);
    if (!loginHint) return;
    const hint = loginHint;
    hint.classList.remove('visible');
    setTimeout(() => hint.remove(), 200);
  }

  function render() {
    if (!account) return;
    if (window.KanbanGuest) window.KanbanGuest.setAccount(account);
    accountBtn.innerHTML = ICONS.user + '<span class="account-btn-name"></span>' + ICONS.chevron;
    accountBtn.querySelector('.account-btn-name').textContent = account.name;
    accountBtn.hidden = false;

    menu.innerHTML = '';
    if (account.canRename) addItem(account.guest ? 'Ваше имя' : 'Сменить логин', renameDialog);
    addItem(account.hasPassword ? 'Сменить пароль' : 'Задать пароль', passwordDialog);
    if (SHOW_TELEGRAM_BUTTON && account.telegram) {
      const tgName = account.telegram.username ? ` (@${account.telegram.username})` : '';
      addItem('Отключить Telegram' + tgName, unlinkTelegram);
    }
    if (account.isAdmin) addItem('Статистика', () => { window.location.href = '/admin'; });
    // гостю выходить не из чего — аккаунта ещё нет
    if (!account.guest) addItem('Выйти', logout, true);

    // гостю терять нечего — напоминание о пароле показываем, когда аккаунт уже есть
    // и не сразу: только начиная с третьего захода в аккаунт
    banner.hidden = account.hasPassword || !!account.guest ||
      (account.visits || 0) < (account.passwordBannerFrom || 3);
    // «Войти» — только у гостя; когда аккаунт создан, кнопка пропадает
    // (войти в другое пространство можно после «Выйти»)
    loginBtn.hidden = !account.guest;
    if (account.guest) showLoginHint();
    // «Telegram» — если кнопка включена и на сервере настроен бот
    telegramBtn.hidden = !SHOW_TELEGRAM_BUTTON || !account.telegramBot;
    telegramBtn.title = account.telegram
      ? 'Telegram подключён' + (account.telegram.username ? ` (@${account.telegram.username})` : '') + ' — открыть бота'
      : 'Смотреть доски в Telegram';
  }

  function addItem(label, action, danger) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'account-menu-item' + (danger ? ' account-menu-item-danger' : '');
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.addEventListener('click', () => {
      closeMenu();
      action();
    });
    menu.appendChild(item);
  }

  // --- меню аккаунта ---
  function openMenu() {
    menu.hidden = false;
    accountBtn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.account-menu-item');
    if (first) first.focus();
  }

  function closeMenu() {
    menu.hidden = true;
    accountBtn.setAttribute('aria-expanded', 'false');
  }

  accountBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });

  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !accountBtn.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      closeMenu();
      accountBtn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('.account-menu-item')];
      const i = items.indexOf(document.activeElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    }
  });

  // --- окна ---
  // Возвращает Promise, который выполняется, когда окно закрыто
  // (сохранили или закрыли Escape / кликом по фону)
  function renameDialog() {
    const guest = !!account.guest;
    if (guest && window.KanbanGuest) window.KanbanGuest.notePrompt('rename');
    return window.KanbanDialog.form({
      title: guest ? 'Придумайте себе уникальное имя' : 'Сменить логин',
      // у гостя — без пояснения (правила покажутся, если имя не подойдёт)
      message: guest ? '' :
        'Логин можно поменять только один раз — после этого изменить его будет нельзя. ' + account.nameRules,
      confirmLabel: guest ? 'Сохранить' : 'Сменить',
      hideCancel: guest,
      noAutofill: guest,
      // у гостя поле — просто имя, не логин: без значка менеджера паролей (ключа)
      fields: [{ name: guest ? 'nickname' : 'name', label: guest ? '' : 'Новый логин', value: guest ? '' : account.name, maxLength: 30, autocomplete: guest ? 'off' : 'username' }],
      onSubmit: async (values) => {
        const name = (values.nickname ?? values.name ?? '').trim();
        if (!name) return guest ? 'Введите имя.' : 'Введите новый логин.';
        if (!guest && name === account.name) return 'Введите новый логин.';
        if (!/^[A-Za-zА-Яа-яЁё0-9_-]{3,30}$/.test(name.normalize('NFC'))) return account.nameRules;
        const { ok, data } = await postJson('/api/account/name', { name });
        if (!ok) return data.error || 'Не удалось сменить логин.';
        account = data;
        render();
        return null;
      }
    });
  }

  // Перед первым действием, которое создаёт аккаунт, спрашиваем у гостя имя
  // (окно «Как вас зовут?»). Окно обязательное: закрыть его, не введя имя,
  // нельзя — аккаунт создаётся с этим логином, потом выполняется действие.
  // action — что гость пытается сделать (для журнала событий, см. guest.js)
  async function askNameIfGuest(action) {
    if (account && account.guest && window.KanbanGuest) {
      const fresh = await window.KanbanGuest.ensureNamed(action);
      if (fresh) {
        account = fresh;
        render();
      }
    }
  }

  async function passwordDialog() {
    await askNameIfGuest('password');
    const min = account.passwordMin || 6;
    const fields = [];
    if (account.hasPassword) {
      fields.push({ name: 'current', label: 'Текущий пароль', type: 'password', maxLength: 128, autocomplete: 'current-password' });
    }
    fields.push({ name: 'password', label: 'Новый пароль', type: 'password', maxLength: 128, autocomplete: 'new-password', placeholder: `Не короче ${min} символов` });
    fields.push({ name: 'repeat', label: 'Повторите пароль', type: 'password', maxLength: 128, autocomplete: 'new-password' });

    window.KanbanDialog.form({
      title: account.hasPassword ? 'Сменить пароль' : 'Задать пароль',
      message: account.hasPassword
        ? 'После смены пароля на всех остальных устройствах придётся войти заново.'
        : account.guest
          ? 'С паролем вы сможете входить в это пространство с любого устройства. Логин создастся автоматически — один раз его можно будет поменять.'
          : `С паролем вы сможете войти под логином «${account.name}» с любого устройства.`,
      confirmLabel: 'Сохранить',
      fields,
      onSubmit: async ({ current, password, repeat }) => {
        if (account.hasPassword && !current) return 'Введите текущий пароль.';
        if (password.length < min) return `Пароль должен быть не короче ${min} символов.`;
        if (password !== repeat) return 'Пароли не совпадают.';
        const { ok, data } = await postJson('/api/account/password', { current: current || '', password });
        if (!ok) return data.error || 'Не удалось сохранить пароль.';
        account = data;
        render();
        return null;
      }
    });
  }

  // --- Telegram ---
  // Ссылка t.me/<бот>?start=<одноразовый токен>: в Telegram пользователь жмёт
  // «Запустить», и бот подключается к этому аккаунту. Ссылку открываем в новой
  // вкладке; окно открывается сразу по нажатию (иначе браузер его заблокирует),
  // адрес подставляется, когда сервер его выдал.
  async function requestTelegramLink() {
    const { ok, data } = await postJson('/api/telegram/link');
    if (!ok || !data.url) throw new Error(data.error || 'Не удалось получить ссылку.');
    return data.url;
  }

  async function openTelegram() {
    if (!account) return;
    if (account.guest) {
      // гостю сначала нужно имя (создаётся аккаунт); после окна имени
      // браузер уже не считает открытие вкладки ответом на нажатие —
      // поэтому ссылку открываем из второго окна
      await askNameIfGuest('telegram');
      if (account.guest) return;
      let url;
      try {
        url = await requestTelegramLink();
      } catch (err) {
        window.KanbanDialog.alert({ title: 'Telegram', message: err.message });
        return;
      }
      const go = await window.KanbanDialog.confirm({
        title: 'Доски в Telegram',
        message: 'Откроется Telegram — нажмите там «Запустить», и бот покажет ваши доски. Ссылка действует 10 минут.',
        confirmLabel: 'Открыть Telegram',
        danger: false
      });
      if (go) window.open(url, '_blank', 'noopener');
      return;
    }
    const win = window.open('', '_blank');
    try {
      const url = await requestTelegramLink();
      if (win) win.location.href = url; else window.location.href = url;
    } catch (err) {
      if (win) win.close();
      window.KanbanDialog.alert({ title: 'Telegram', message: err.message });
    }
  }

  telegramBtn.addEventListener('click', openTelegram);

  async function unlinkTelegram() {
    const ok = await window.KanbanDialog.confirm({
      title: 'Отключить Telegram?',
      message: 'Бот перестанет показывать ваши доски. Подключить его снова можно кнопкой «Telegram».',
      confirmLabel: 'Отключить'
    });
    if (!ok) return;
    const { ok: done, data } = await postJson('/api/telegram/unlink');
    if (done) {
      account = data;
      render();
    }
  }

  // вернулись на вкладку (например, после подключения в Telegram) — обновляем
  // меню аккаунта: там появится «Отключить Telegram»
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && account && !account.guest) loadAccount();
  });

  // Пространство без пароля, но с досками: уйдя из него, вернуться будет нельзя
  function wouldLoseBoards() {
    return account && !account.hasPassword &&
      document.querySelectorAll('.board-tile').length > 0;
  }

  async function logout() {
    if (wouldLoseBoards()) {
      const ok = await window.KanbanDialog.confirm({
        title: 'Выйти без пароля?',
        message: `У пространства «${account.name}» не задан пароль. После выхода вернуться в него и к его доскам будет нельзя.`,
        confirmLabel: 'Выйти'
      });
      if (!ok) return;
    }
    try {
      await postJson('/api/logout');
    } catch (err) {
      console.error('Не удалось выйти:', err);
    }
    // без входа сразу создаётся новое пространство
    window.location.href = '/';
  }

  // --- напоминание задать пароль ---
  banner.innerHTML =
    '<span class="password-banner-icon">' + ICONS.lock + '</span>' +
    '<div class="password-banner-text">' +
      '<div class="password-banner-title">Задайте пароль, чтобы не потерять доступ</div>' +
      '<div class="password-banner-message">Без пароля в пространство не войти с другого устройства, ' +
      'а если браузер забудет cookie — доски будут потеряны.</div>' +
    '</div>';
  const bannerBtn = document.createElement('button');
  bannerBtn.type = 'button';
  bannerBtn.className = 'password-banner-btn';
  bannerBtn.textContent = 'Задать пароль';
  bannerBtn.addEventListener('click', () => passwordDialog());
  banner.appendChild(bannerBtn);

  async function loadAccount() {
    try {
      const res = await fetch('/api/account');
      if (!res.ok) return;
      account = await res.json();
      render();
    } catch (err) {
      console.error('Не удалось загрузить аккаунт:', err);
    }
  }

  loadAccount();

  // для других скриптов страницы (start.js: создание доски)
  window.KanbanAccount = { askNameIfGuest };
})();
