// Аккаунт на стартовой странице: кнопка с логином, меню
// аккаунта (задать/сменить пароль, выйти) и напоминание
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
    addItem(account.hasPassword ? 'Сменить пароль' : 'Задать пароль', passwordDialog);
    addItem('Выйти', logout, true);

    banner.hidden = account.hasPassword;
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

  async function logout() {
    if (!account.hasPassword) {
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
    window.location.href = '/login';
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
})();
