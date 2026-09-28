// Общие окна в стиле доски — замена системным confirm() и prompt().
// Подключается и на стартовой странице, и на странице доски.
//
//   KanbanDialog.confirm({ title, message, confirmLabel, cancelLabel, danger })
//     → Promise<boolean>  (true — пользователь подтвердил)
//   KanbanDialog.prompt({ title, message, value, placeholder, confirmLabel, cancelLabel, maxLength })
//     → Promise<string|null>  (null — отмена)
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

  window.KanbanDialog = { confirm, prompt };
})();
