// Общие окна в стиле доски — замена системным confirm() и prompt().
// Подключается и на стартовой странице, и на странице доски.
//
//   KanbanDialog.confirm({ title, message, confirmLabel, cancelLabel, danger })
//     → Promise<boolean>  (true — пользователь подтвердил)
//   KanbanDialog.prompt({ title, message, value, placeholder, confirmLabel, cancelLabel, maxLength })
//     → Promise<string|null>  (null — отмена)
//   KanbanDialog.form({ title, message, fields, confirmLabel, cancelLabel, onSubmit })
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

  function form({ title, message, fields = [], confirmLabel = 'Сохранить', cancelLabel = 'Отмена', onSubmit }) {
    return new Promise(resolve => {
      const uid = 'kanban-dialog-' + (++idCounter);
      const previousFocus = document.activeElement;

      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      const dialog = document.createElement('form');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.noValidate = true;

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
        inp.value = f.value || '';
        inp.placeholder = f.placeholder || '';
        if (f.maxLength) inp.maxLength = f.maxLength;
        if (f.autocomplete) inp.autocomplete = f.autocomplete;
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
      okBtn.type = 'submit';
      okBtn.className = 'confirm-btn confirm-btn-primary';
      okBtn.textContent = confirmLabel;
      buttons.appendChild(cancelBtn);
      buttons.appendChild(okBtn);
      dialog.appendChild(buttons);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const focusables = [...Object.values(inputs), cancelBtn, okBtn];
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
          close(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const i = focusables.indexOf(document.activeElement);
          const step = e.shiftKey ? -1 : 1;
          focusables[(i + step + focusables.length) % focusables.length].focus();
        }
      }

      dialog.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      cancelBtn.onclick = () => close(null);
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey, true);

      requestAnimationFrame(() => overlay.classList.add('open'));
      const first = Object.values(inputs)[0];
      if (first) { first.focus(); first.select(); } else { okBtn.focus(); }
    });
  }

  window.KanbanDialog = { confirm, prompt, form };
})();
