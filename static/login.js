// Страница входа: вход по имени пространства и паролю,
// либо создание нового пространства.
(function () {
  const ICONS = {
    sun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };

  const themeBtn = document.getElementById('theme-toggle');
  function updateThemeButton() {
    const isDark = window.KanbanTheme.getTheme() === 'dark';
    themeBtn.innerHTML = (isDark ? ICONS.sun : ICONS.moon) +
      '<span>' + (isDark ? 'Светлая тема' : 'Тёмная тема') + '</span>';
  }
  themeBtn.addEventListener('click', () => {
    window.KanbanTheme.toggleTheme();
    updateThemeButton();
  });
  updateThemeButton();

  const notice = document.getElementById('login-notice');
  if (new URLSearchParams(window.location.search).get('limit')) {
    notice.textContent = 'С этого адреса недавно создано слишком много пространств. ' +
      'Войдите в существующее или попробуйте позже.';
    notice.hidden = false;
  }

  const form = document.getElementById('login-form');
  const nameInput = document.getElementById('login-name');
  const passwordInput = document.getElementById('login-password');
  const submitBtn = document.getElementById('login-submit');
  const errorEl = document.getElementById('login-error');
  const newBtn = document.getElementById('login-new');
  const newErrorEl = document.getElementById('new-error');

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    if (!name || !password) {
      errorEl.textContent = 'Введите имя пространства и пароль.';
      (name ? passwordInput : nameInput).focus();
      return;
    }
    submitBtn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/login', { name, password });
      if (ok) {
        window.location.href = '/';
        return;
      }
      errorEl.textContent = data.error || 'Не удалось войти.';
      passwordInput.select();
    } catch (err) {
      errorEl.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
    }
    submitBtn.disabled = false;
  });

  newBtn.addEventListener('click', async () => {
    newErrorEl.textContent = '';
    newBtn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/account/new');
      if (ok) {
        window.location.href = '/';
        return;
      }
      newErrorEl.textContent = data.error || 'Не удалось создать пространство.';
    } catch (err) {
      newErrorEl.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
    }
    newBtn.disabled = false;
  });

  nameInput.focus();
})();
