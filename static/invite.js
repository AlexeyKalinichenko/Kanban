// Страница приглашения на доску (/invite/<секрет>) — её видит гость:
// вошедший пользователь получает доступ сразу, без этой страницы.
// «Открыть доску» → обязательное окно «Придумайте себе уникальное имя»
// (создаётся аккаунт) → доступ к доске → переход на доску.
// Если у человека уже есть аккаунт — «Войти», после входа он вернётся по ссылке.
(function () {
  const token = window.location.pathname.split('/').filter(Boolean)[1] || '';
  const titleEl = document.getElementById('invite-title');
  const subtitleEl = document.getElementById('invite-subtitle');
  const card = document.getElementById('invite-card');
  const boardEl = document.getElementById('invite-board');
  const textEl = document.getElementById('invite-text');
  const errorEl = document.getElementById('invite-error');
  const openBtn = document.getElementById('invite-open');
  const loginLink = document.getElementById('invite-login');
  const homeLink = document.getElementById('invite-home');

  function showInvalid() {
    titleEl.textContent = 'Ссылка не действует';
    subtitleEl.textContent = 'Её выключили или заменили новой. Попросите владельца доски прислать новую ссылку.';
    card.hidden = true;
    loginLink.hidden = true;
    homeLink.hidden = false;
  }

  async function load() {
    let res;
    try {
      res = await fetch(`/api/invite/${encodeURIComponent(token)}`);
    } catch (err) {
      subtitleEl.textContent = 'Не удалось связаться с сервером. Обновите страницу.';
      return;
    }
    if (!res.ok) {
      showInvalid();
      return;
    }
    const data = await res.json();
    titleEl.textContent = 'Приглашение';
    subtitleEl.textContent = `Пользователь ${data.ownerName} приглашает вас на доску.`;
    boardEl.textContent = data.title;
    textEl.textContent = 'Вы сможете смотреть доску и редактировать её вместе с другими участниками.';
    card.hidden = false;
    loginLink.href = '/login?next=' + encodeURIComponent(window.location.pathname);
    loginLink.hidden = false;
    document.title = `Приглашение на доску «${data.title}»`;
  }

  openBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    openBtn.disabled = true;
    try {
      // гость: сначала имя — создаётся аккаунт
      if (window.KanbanGuest) await window.KanbanGuest.ensureNamed('invite');
      const res = await fetch(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST' });
      let data = {};
      try { data = await res.json(); } catch (e) { /* пустой ответ */ }
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      if (res.status === 404) {
        showInvalid();
      } else {
        errorEl.textContent = data.error || 'Не удалось открыть доску.';
      }
    } catch (err) {
      errorEl.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
    }
    openBtn.disabled = false;
  });

  load();
})();
