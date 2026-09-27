// Выбор цвета фона доски.
// Цвет хранится в файле доски на сервере (строка BACKGROUND: в Data/<guid>.txt).
// Этот скрипт отвечает только за палитру и применение цвета; загрузку и
// сохранение делает board.js через window.KanbanBoardBg.
(function () {
  const COLORS = ['blue', 'green', 'purple', 'red', 'yellow'];
  const root = document.documentElement;
  const picker = document.getElementById('bg-picker');
  const btn = document.getElementById('bg-picker-btn');
  const menu = document.getElementById('bg-picker-menu');
  const listeners = [];

  function normalize(color) {
    return COLORS.includes(color) ? color : '';
  }

  function get() {
    return normalize(root.getAttribute('data-board-bg') || '');
  }

  function apply(color) {
    color = normalize(color);
    if (color) {
      root.setAttribute('data-board-bg', color);
    } else {
      root.removeAttribute('data-board-bg');
    }
    if (menu) {
      menu.querySelectorAll('.bg-swatch').forEach(s => {
        s.classList.toggle('active', s.dataset.bg === color);
      });
    }
  }

  function onChange(cb) {
    listeners.push(cb);
  }

  window.KanbanBoardBg = { get, apply, onChange };

  if (!picker || !btn || !menu) return;

  function setOpen(open) {
    menu.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains('open'));
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-bg]');
    if (!item) return;
    const color = normalize(item.dataset.bg);
    setOpen(false);
    if (color === get()) return;
    apply(color);
    listeners.forEach(cb => cb(color));
  });

  // закрываем палитру по клику вне её и по Escape
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
})();
