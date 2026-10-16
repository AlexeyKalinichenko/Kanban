// Доступ к доске (общие доски) — кнопка в верхней панели доски и окно.
//
// Владелец доски видит, кому она открыта, открывает доступ по логину или по
// ссылке-приглашению (её можно заменить новой или выключить) и закрывает доступ. Тот, кому доску открыли, видит владельца и остальных
// участников и может убрать доску у себя. Права у всех одни: смотреть и
// редактировать; удалить доску и управлять доступом может только владелец.
//
//   KanbanShare.init({ boardId, owner, getTitle })
//     owner — id владельца чужой доски ('' для своей), getTitle() — название доски
//   KanbanShare.setAccess(access) — данные доступа из GET /api/board/<id>
//     (обновляют значок с числом участников на кнопке)
//
// Подключается на странице доски после dialog.js и guest.js.
(function () {
  const svg = (paths, size) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const ICONS = {
    users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>', 18),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14)
  };

  let boardId = '';
  let ownerId = '';
  let getTitle = () => '';
  let access = null;
  let button = null;

  function apiUrl(suffix) {
    return `/api/board/${boardId}/access${suffix || ''}` +
      (ownerId ? `?owner=${encodeURIComponent(ownerId)}` : '');
  }

  function updateButton() {
    if (!button || !access) return;
    const count = access.users.length;
    const badge = button.querySelector('.share-btn-count');
    badge.textContent = count ? String(count) : '';
    badge.hidden = !count;
    if (access.isOwner) {
      button.title = count ? `Доступ к доске: открыт ${count} ${count % 10 === 1 && count % 100 !== 11 ? 'пользователю' : 'пользователям'}` : 'Открыть доступ к доске';
    } else {
      button.title = `Доска пользователя ${access.owner.name}`;
    }
    button.setAttribute('aria-label', button.title);
  }

  function setAccess(data) {
    if (!data) return;
    access = data;
    updateButton();
  }

  async function readJson(res) {
    try { return await res.json(); } catch (e) { return {}; }
  }

  // --- Окно ---
  function openDialog() {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog share-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    }

    // поверх этого окна может открыться другое (подтверждение, «Придумайте
    // себе уникальное имя») — тогда клавиши обрабатывает оно
    const isTop = () => {
      const all = document.querySelectorAll('.confirm-overlay');
      return all[all.length - 1] === overlay;
    };

    function onKey(e) {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    let busy = false;

    function render(focusInput) {
      dialog.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'confirm-title';
      title.id = 'share-dialog-title';
      title.textContent = 'Доступ к доске';
      dialog.setAttribute('aria-labelledby', title.id);
      dialog.appendChild(title);

      const message = document.createElement('div');
      message.className = 'confirm-message';
      message.textContent = access.isOwner
        ? 'Пользователи из списка видят доску и могут её редактировать. Удалить доску можете только вы.'
        : `Владелец доски — ${access.owner.name}. Все из списка видят доску и могут её редактировать.`;
      dialog.appendChild(message);

      let input = null;
      let addBtn = null;
      let errorEl = null;
      if (access.isOwner) {
        const row = document.createElement('div');
        row.className = 'share-add-row';
        input = document.createElement('input');
        // не поле входа: без значка-ключа менеджеров паролей (см. dialog.js)
        input.type = 'search';
        input.className = 'confirm-input share-input';
        input.name = 'share-user-' + Date.now();
        input.placeholder = 'Логин пользователя';
        input.maxLength = 30;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.autocapitalize = 'off';
        input.setAttribute('aria-label', 'Логин пользователя');
        ['data-1p-ignore', 'data-bwignore'].forEach(a => input.setAttribute(a, ''));
        input.setAttribute('data-lpignore', 'true');
        input.setAttribute('data-form-type', 'other');
        addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'confirm-btn confirm-btn-primary share-add-btn';
        addBtn.textContent = 'Открыть доступ';
        row.appendChild(input);
        row.appendChild(addBtn);
        dialog.appendChild(row);

        errorEl = document.createElement('div');
        errorEl.className = 'confirm-error';
        errorEl.setAttribute('role', 'alert');
        dialog.appendChild(errorEl);

        const submit = async () => {
          if (busy) return;
          const name = input.value.normalize('NFC').trim();
          if (!name) {
            errorEl.textContent = 'Введите логин пользователя.';
            input.focus();
            return;
          }
          busy = true;
          addBtn.disabled = true;
          errorEl.textContent = '';
          try {
            // гость: открыть доступ — изменение, сначала окно имени (создаётся аккаунт)
            if (window.KanbanGuest) await window.KanbanGuest.ensureNamed('board_share');
            const res = await fetch(apiUrl(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name })
            });
            const data = await readJson(res);
            if (!res.ok) {
              errorEl.textContent = data.error || 'Не удалось открыть доступ.';
            } else {
              setAccess(data);
              busy = false;
              render(true);
              return;
            }
          } catch (err) {
            errorEl.textContent = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
          }
          busy = false;
          addBtn.disabled = false;
          input.focus();
        };
        addBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });

        dialog.appendChild(renderLink());
      }

      // список: владелец, затем те, кому открыт доступ
      const list = document.createElement('ul');
      list.className = 'share-list';
      list.setAttribute('aria-label', 'У кого есть доступ');
      const addPerson = (person, role, removable) => {
        const li = document.createElement('li');
        li.className = 'share-person';
        const name = document.createElement('span');
        name.className = 'share-person-name';
        name.textContent = person.name;
        li.appendChild(name);
        if (person.me) {
          const me = document.createElement('span');
          me.className = 'share-person-me';
          me.textContent = '(вы)';
          li.appendChild(me);
        }
        const roleEl = document.createElement('span');
        roleEl.className = 'share-person-role';
        roleEl.textContent = role;
        li.appendChild(roleEl);
        if (removable) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'share-person-remove';
          remove.innerHTML = ICONS.close;
          remove.title = `Закрыть доступ пользователю ${person.name}`;
          remove.setAttribute('aria-label', remove.title);
          remove.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            try {
              const res = await fetch(apiUrl('/' + person.id), { method: 'DELETE' });
              const data = await readJson(res);
              if (res.ok) setAccess(data);
            } catch (err) {
              console.error('Не удалось закрыть доступ:', err);
            }
            busy = false;
            render(false);
          });
          li.appendChild(remove);
        }
        list.appendChild(li);
      };
      addPerson(access.owner, 'владелец', false);
      access.users.forEach(u => addPerson(u, 'редактирует', access.isOwner));
      if (access.isOwner && !access.users.length) {
        const empty = document.createElement('li');
        empty.className = 'share-empty';
        empty.textContent = 'Доступ пока никому не открыт.';
        list.appendChild(empty);
      }
      dialog.appendChild(list);

      const buttons = document.createElement('div');
      buttons.className = 'confirm-buttons';
      if (!access.isOwner) {
        const leave = document.createElement('button');
        leave.type = 'button';
        leave.className = 'confirm-btn confirm-btn-cancel share-leave-btn';
        leave.textContent = 'Убрать у себя';
        leave.addEventListener('click', async () => {
          const ok = await window.KanbanDialog.confirm({
            title: `Убрать доску «${getTitle()}»?`,
            message: `Доска пропадёт из вашего списка. Снова открыть вам доступ сможет только её владелец — ${access.owner.name}.`,
            confirmLabel: 'Убрать'
          });
          if (!ok) return;
          try {
            await fetch(apiUrl('/me'), { method: 'DELETE' });
          } catch (err) {
            console.error('Не удалось убрать доску:', err);
            return;
          }
          window.location.href = '/';
        });
        buttons.appendChild(leave);
      }
      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'confirm-btn confirm-btn-primary';
      done.textContent = 'Готово';
      done.addEventListener('click', close);
      buttons.appendChild(done);
      dialog.appendChild(buttons);

      if (focusInput && input) input.focus();
      else if (!input) done.focus();
    }

    // --- Доступ по ссылке (только у владельца) ---
    async function linkRequest(method, body) {
      if (busy) return;
      busy = true;
      try {
        // гость: ссылка — изменение, сначала окно имени (создаётся аккаунт)
        if (method === 'POST' && window.KanbanGuest) await window.KanbanGuest.ensureNamed('board_share');
        const res = await fetch(`/api/board/${boardId}/link`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        const data = await readJson(res);
        if (res.ok) setAccess(data);
      } catch (err) {
        console.error('Не удалось изменить ссылку:', err);
      }
      busy = false;
      render(false);
    }

    function copyText(text, inputEl) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true, () => false);
      }
      // без HTTPS (например, сервер в домашней сети) буфер обмена недоступен —
      // старый способ через выделение текста в поле
      inputEl.focus();
      inputEl.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      return Promise.resolve(ok);
    }

    function renderLink() {
      const box = document.createElement('div');
      box.className = 'share-link';
      const head = document.createElement('div');
      head.className = 'share-link-head';
      head.textContent = 'Доступ по ссылке';
      box.appendChild(head);

      if (!access.link) {
        const row = document.createElement('div');
        row.className = 'share-link-row';
        const hint = document.createElement('div');
        hint.className = 'share-link-hint';
        hint.textContent = 'Кто откроет ссылку, получит доступ к доске.';
        const create = document.createElement('button');
        create.type = 'button';
        create.className = 'confirm-btn confirm-btn-cancel share-link-create';
        create.textContent = 'Создать ссылку';
        create.addEventListener('click', () => linkRequest('POST'));
        row.appendChild(hint);
        row.appendChild(create);
        box.appendChild(row);
        return box;
      }

      const url = window.location.origin + access.link;
      const row = document.createElement('div');
      row.className = 'share-add-row share-link-url-row';
      const field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.className = 'confirm-input share-link-url';
      field.value = url;
      field.setAttribute('aria-label', 'Ссылка-приглашение');
      field.addEventListener('focus', () => field.select());
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'confirm-btn confirm-btn-primary share-add-btn share-link-copy';
      copy.textContent = 'Скопировать';
      copy.addEventListener('click', async () => {
        const ok = await copyText(url, field);
        // не вышло — ссылка выделена в поле, её можно скопировать вручную
        copy.textContent = ok ? 'Скопировано' : 'Выделено';
        setTimeout(() => { copy.textContent = 'Скопировать'; }, 1800);
      });
      row.appendChild(field);
      row.appendChild(copy);
      box.appendChild(row);

      const hint = document.createElement('div');
      hint.className = 'share-link-hint';
      hint.textContent = 'Кто откроет ссылку, получит доступ к доске и появится в списке ниже.';
      box.appendChild(hint);

      const actions = document.createElement('div');
      actions.className = 'share-link-actions';
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'share-link-action';
      reset.textContent = 'Заменить ссылку';
      reset.addEventListener('click', async () => {
        const ok = await window.KanbanDialog.confirm({
          title: 'Заменить ссылку?',
          message: 'Старая ссылка перестанет работать. Те, кто уже открыл доску по ней, сохранят доступ.',
          confirmLabel: 'Заменить',
          danger: false
        });
        if (ok) linkRequest('POST', { reset: true });
      });
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'share-link-action';
      off.textContent = 'Выключить ссылку';
      off.addEventListener('click', () => linkRequest('DELETE'));
      actions.appendChild(reset);
      actions.appendChild(off);
      box.appendChild(actions);
      return box;
    }

    render(true);
    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  async function onButtonClick() {
    // свежий список (его мог поменять владелец на другом устройстве)
    try {
      const res = await fetch(apiUrl());
      if (res.status === 404) {
        window.location.href = '/';
        return;
      }
      if (res.ok) setAccess(await res.json());
    } catch (err) {
      console.error('Не удалось загрузить доступ к доске:', err);
    }
    if (access) openDialog();
  }

  function init(options) {
    boardId = options.boardId;
    ownerId = options.owner || '';
    getTitle = options.getTitle || getTitle;
    button = document.getElementById('share-btn');
    if (!button) return;
    button.innerHTML = ICONS.users + '<span class="share-btn-count" hidden></span>';
    button.addEventListener('click', onButtonClick);
    button.hidden = false;
  }

  window.KanbanShare = { init, setAccess };
})();
