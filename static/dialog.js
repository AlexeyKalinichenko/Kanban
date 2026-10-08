// Общие окна в стиле доски — замена системным confirm() и prompt().
// Подключается и на стартовой странице, и на странице доски.
//
//   KanbanDialog.confirm({ title, message, confirmLabel, cancelLabel, danger })
//     → Promise<boolean>  (true — пользователь подтвердил)
//   KanbanDialog.prompt({ title, message, value, placeholder, confirmLabel, cancelLabel, maxLength })
//     → Promise<string|null>  (null — отмена)
//   KanbanDialog.form({ title, message, fields, confirmLabel, cancelLabel, hideCancel, mandatory, noAutofill, onSubmit })
//     mandatory: окно закрывается только успешной отправкой (без «Отмены», Escape и клика по фону)
//     fields: [{ name, label, type: 'text'|'password', value, placeholder, maxLength, autocomplete }]
//     onSubmit(values) → Promise<string|null>: строка — текст ошибки (окно остаётся
//     открытым), null — успех (окно закрывается).
//     → Promise<object|null>  (значения полей или null — отмена)
//
// Escape или клик по затемнённому фону — отмена, Enter — подтверждение.
(function () {
  let idCounter = 0;

  function openDialog({ title, message, confirmLabel, cancelLabel, danger, input }) {
    return new Promise(resolve => {
      const uid = 'kanban-dialog-' + (++idCounter);
      const previousFocus = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', input ? 'dialog' : 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');

      const titleEl = document.createElement('div');
      titleEl.className = 'confirm-title';
      titleEl.id = uid + '-title';
      titleEl.textContent = title;
      dialog.setAttribute('aria-labelledby', titleEl.id);
      dialog.appendChild(titleEl);

      if (message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'confirm-message';
        messageEl.id = uid + '-message';
        messageEl.textContent = message;
        dialog.setAttribute('aria-describedby', messageEl.id);
        dialog.appendChild(messageEl);
      }

      let inputEl = null;
      if (input) {
        inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.className = 'confirm-input';
        inputEl.value = input.value || '';
        inputEl.placeholder = input.placeholder || '';
        if (input.maxLength) inputEl.maxLength = input.maxLength;
        inputEl.setAttribute('aria-labelledby', titleEl.id);
        dialog.appendChild(inputEl);
      }

      const buttons = document.createElement('div');
      buttons.className = 'confirm-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-btn confirm-btn-cancel';
      cancelBtn.textContent = cancelLabel;

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'confirm-btn ' + (danger ? 'confirm-btn-danger' : 'confirm-btn-primary');
      okBtn.textContent = confirmLabel;

      buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);
      dialog.appendChild(buttons);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const focusables = inputEl ? [inputEl, cancelBtn, okBtn] : [cancelBtn, okBtn];

      function close(confirmed) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
        if (inputEl) {
          resolve(confirmed ? inputEl.value : null);
        } else {
          resolve(confirmed);
        }
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          close(document.activeElement !== cancelBtn);
        } else if (e.key === 'Tab') {
          // фокус не уходит за пределы окна
          e.preventDefault();
          const i = focusables.indexOf(document.activeElement);
          const step = e.shiftKey ? -1 : 1;
          focusables[(i + step + focusables.length) % focusables.length].focus();
        }
      }

      cancelBtn.onclick = () => close(false);
      okBtn.onclick = () => close(true);
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKey, true);

      requestAnimationFrame(() => overlay.classList.add('open'));
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
      } else {
        okBtn.focus();
      }
    });
  }

  function confirm({ title, message, confirmLabel = 'Удалить', cancelLabel = 'Отмена', danger = true }) {
    return openDialog({ title, message, confirmLabel, cancelLabel, danger });
  }

  function prompt({ title, message, value = '', placeholder = '', confirmLabel = 'ОК', cancelLabel = 'Отмена', maxLength }) {
    return openDialog({
      title, message, confirmLabel, cancelLabel, danger: false,
      input: { value, placeholder, maxLength }
    });
  }

  function form({ title, message, fields = [], confirmLabel = 'Сохранить', cancelLabel = 'Отмена', hideCancel = false, mandatory = false, noAutofill = false, onSubmit }) {
    return new Promise(resolve => {
      const uid = 'kanban-dialog-' + (++idCounter);
      const previousFocus = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      // noAutofill: окно не похоже на форму входа — без <form>, поля типа
      // «поиск» с нейтральными именами. Иначе Safari (и менеджеры паролей)
      // рисуют в поле значок-ключ, даже если это просто имя.
      const dialog = document.createElement(noAutofill ? 'div' : 'form');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      if (!noAutofill) dialog.noValidate = true;

      const titleEl = document.createElement('div');
      titleEl.className = 'confirm-title';
      titleEl.id = uid + '-title';
      titleEl.textContent = title;
      dialog.setAttribute('aria-labelledby', titleEl.id);
      dialog.appendChild(titleEl);

      if (message) {
        const messageEl = document.createElement('div');
        messageEl.className = 'confirm-message';
        messageEl.textContent = message;
        dialog.appendChild(messageEl);
      }

      const inputs = {};
      fields.forEach((f, i) => {
        const label = document.createElement('label');
        label.className = 'confirm-field';
        if (f.label) {
          const cap = document.createElement('span');
          cap.className = 'confirm-field-label';
          cap.textContent = f.label;
          label.appendChild(cap);
        }
        const inp = document.createElement('input');
        inp.type = f.type || 'text';
        inp.className = 'confirm-input';
        inp.name = f.name;
        if (noAutofill && inp.type === 'text') {
          inp.type = 'search';
          inp.name = uid + '-f' + i;
          inp.autocomplete = 'off';
          if (!f.label) inp.setAttribute('aria-labelledby', titleEl.id);
        }
        inp.value = f.value || '';
        inp.placeholder = f.placeholder || '';
        if (f.maxLength) inp.maxLength = f.maxLength;
        if (f.autocomplete) inp.autocomplete = f.autocomplete;
        if (f.autocomplete === 'off') {
          // не поле входа: просим менеджеры паролей (Safari/iCloud, 1Password,
          // LastPass, Bitwarden) не показывать в нём свой значок-ключ
          inp.setAttribute('data-1p-ignore', '');
          inp.setAttribute('data-lpignore', 'true');
          inp.setAttribute('data-bwignore', '');
          inp.setAttribute('data-form-type', 'other');
        }
        inp.spellcheck = false;
        inp.autocapitalize = 'off';
        label.appendChild(inp);
        dialog.appendChild(label);
        inputs[f.name] = inp;
      });

      const errorEl = document.createElement('div');
      errorEl.className = 'confirm-error';
      errorEl.setAttribute('role', 'alert');
      dialog.appendChild(errorEl);

      const buttons = document.createElement('div');
      buttons.className = 'confirm-buttons';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-btn confirm-btn-cancel';
      cancelBtn.textContent = cancelLabel;
      const okBtn = document.createElement('button');
      okBtn.type = noAutofill ? 'button' : 'submit';
      okBtn.className = 'confirm-btn confirm-btn-primary';
      okBtn.textContent = confirmLabel;
      // кнопку «Отмена» можно скрыть — окно всё равно закрывается Escape
      // или кликом по затемнённому фону
      if (!hideCancel) buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);
      dialog.appendChild(buttons);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const focusables = [...Object.values(inputs), ...(hideCancel ? [] : [cancelBtn]), okBtn];
      let busy = false;

      function values() {
        const v = {};
        Object.keys(inputs).forEach(k => { v[k] = inputs[k].value; });
        return v;
      }

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
        resolve(result);
      }

      async function submit() {
        if (busy) return;
        const v = values();
        if (!onSubmit) { close(v); return; }
        busy = true;
        okBtn.disabled = true;
        errorEl.textContent = '';
        let error = null;
        try {
          error = await onSubmit(v);
        } catch (err) {
          error = 'Не удалось связаться с сервером. Попробуйте ещё раз.';
        }
        busy = false;
        okBtn.disabled = false;
        if (error) {
          errorEl.textContent = error;
          const first = Object.values(inputs)[0];
          if (first) first.focus();
        } else {
          close(v);
        }
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // обязательное окно Escape не закрывает
          if (!mandatory) close(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const i = focusables.indexOf(document.activeElement);
          const step = e.shiftKey ? -1 : 1;
          focusables[(i + step + focusables.length) % focusables.length].focus();
        }
      }

      dialog.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      if (noAutofill) {
        // без <form> Enter и кнопку обрабатываем сами
        okBtn.addEventListener('click', submit);
        dialog.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
            e.preventDefault();
            submit();
          }
        });
      }
      cancelBtn.onclick = () => close(null);
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay && !mandatory) close(null);
      });
      document.addEventListener('keydown', onKey, true);

      requestAnimationFrame(() => overlay.classList.add('open'));
      const first = Object.values(inputs)[0];
      if (first) { first.focus(); first.select(); } else { okBtn.focus(); }
    });
  }

  window.KanbanDialog = { confirm, prompt, form };
})();
