// Гость (браузер без входа) видит шаблонные доски, но аккаунт на сервере
// создаётся только при первом изменении. Перед этим первым изменением
// обязательно спрашиваем имя — окно «Как вас зовут?» (закрыть, не введя имя,
// нельзя). Введённое имя становится логином, и аккаунт создаётся с ним.
//
//   KanbanGuest.ensureNamed() → Promise<account>: у гостя показывает окно и
//     создаёт аккаунт; у вошедшего пользователя сразу возвращает аккаунт.
//   KanbanGuest.setAccount(account) — сообщить свежие данные аккаунта
//     (например, после смены логина через меню).
//
// Подключается после dialog.js на стартовой странице и на странице доски.
(function () {
  // латинские или русские буквы (смешивать нельзя — это проверяет сервер)
  const NAME_RE = /^[A-Za-zА-Яа-яЁё0-9_-]{3,30}$/;
  let accountPromise = null;
  let naming = null;

  function load() {
    if (!accountPromise) {
      accountPromise = fetch('/api/account')
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null);
    }
    return accountPromise;
  }

  function setAccount(account) {
    accountPromise = Promise.resolve(account);
  }

  async function ensureNamed() {
    const account = await load();
    if (!account || !account.guest) return account;
    if (!naming) {
      naming = window.KanbanDialog.form({
        title: 'Придумайте себе уникальное имя',
        fields: [{ name: 'nickname', label: '', maxLength: 30, autocomplete: 'off' }],
        confirmLabel: 'Сохранить',
        hideCancel: true,
        mandatory: true,
        noAutofill: true,
        onSubmit: async ({ nickname }) => {
          const name = (nickname || '').normalize('NFC').trim();
          if (!name) return 'Введите имя.';
          if (!NAME_RE.test(name)) return account.nameRules;
          const res = await fetch('/api/account/name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          let data = {};
          try { data = await res.json(); } catch (e) { /* пустой ответ */ }
          if (!res.ok) return data.error || 'Не удалось сохранить имя.';
          setAccount(data);
          return null;
        }
      }).then(() => {
        naming = null;
        return load();
      });
    }
    return naming;
  }

  window.KanbanGuest = { load, ensureNamed, setAccount };
})();
