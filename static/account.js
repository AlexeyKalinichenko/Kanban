// Аккаунт на стартовой странице: кнопка с логином, меню
// аккаунта (сменить логин — один раз, задать/сменить пароль, выйти),
// кнопка «Войти» (в другое пространство) и напоминание
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

  function render() {
    if (!account) return;
    accountBtn.innerHTML = ICONS.user + '<span class="account-btn-name"></span>' + ICONS.chevron;
    accountBtn.querySelector('.account-btn-name').textContent = account.name;
    accountBtn.hidden = false;

    menu.innerHTML = '';
    if (account.canRename) addItem(account.guest ? 'Задать логин' : 'Сменить логин', renameDialog);
    addItem(account.hasPassword ? 'Сменить пароль' : 'Задать пароль', passwordDialog);
    // гостю выходить не из чего — аккаунта ещё нет
    if (!account.guest) addItem('Выйти', logout, true);

    // гостю терять нечего — напоминание о пароле показываем, когда аккаунт уже есть
    banner.hidden = account.hasPassword || !!account.guest;
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
  function renameDialog() {
    const guest = !!account.guest;
    window.KanbanDialog.form({
      title: guest ? 'Задать логин' : 'Сменить логин',
      message: (guest
        ? 'Логин задаётся один раз — после этого изменить его будет нельзя. '
        : 'Логин можно поменять только один раз — после этого изменить его будет нельзя. ') +
        account.nameRules,
      confirmLabel: guest ? 'Сохранить' : 'Сменить',
      fields: [{ name: 'name', label: guest ? 'Логин' : 'Новый логин', value: guest ? '' : account.name, maxLength: 30, autocomplete: 'username' }],
      onSubmit: async ({ name }) => {
        name = name.trim();
        if (!name || (!guest && name === account.name)) return 'Введите новый логин.';
        if (!/^[A-Za-z0-9_-]{3,30}$/.test(name)) return account.nameRules;
        const { ok, data } = await postJson('/api/account/name', { name });
        if (!ok) return data.error || 'Не удалось сменить логин.';
        account = data;
        render();
        return null;
      }
    });
  }

  function passwordDialog() {
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

  // --- кнопка «Войти» (в другое, существующее пространство) ---
  loginBtn.addEventListener('click', async (e) => {
    if (!wouldLoseBoards()) return; // обычный переход по ссылке на /login
    e.preventDefault();
    const ok = await window.KanbanDialog.confirm({
      title: 'Войти в другое пространство?',
      message: `У пространства «${account.name}» не задан пароль. Если войдёте в другое пространство, вернуться в это и к его доскам будет нельзя.`,
      confirmLabel: 'Продолжить',
      danger: false
    });
    if (ok) window.location.href = '/login';
  });

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
})();
