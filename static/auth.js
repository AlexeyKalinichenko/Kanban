// Если сессия закончилась (вышли из аккаунта на другом устройстве, сменили
// пароль, удалили cookie), сервер отвечает на запросы к /api/ кодом 401.
// Тогда переходим на страницу входа. Подключается первым скриптом на
// стартовой странице и на странице доски.
(function () {
  const originalFetch = window.fetch.bind(window);
  const PUBLIC = ['/api/login', '/api/account/new'];
  let redirecting = false;

  window.fetch = async function (input, init) {
    const res = await originalFetch(input, init);
    if (res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      if (url.pathname.startsWith('/api/') && !PUBLIC.includes(url.pathname)) {
        if (!redirecting) {
          redirecting = true;
          window.location.href = '/login';
        }
        // дальше страница всё равно уходит — не отдаём ответ, чтобы не
        // показывать ошибок и не перерисовывать пустую доску
        return new Promise(() => {});
      }
    }
    return res;
  };
})();
