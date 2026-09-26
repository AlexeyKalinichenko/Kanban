// Общий модуль темы (тёмная/светлая), используется и стартовой страницей, и доской.
// Применяется как можно раньше (из <head>), чтобы избежать мигания при загрузке.
(function () {
  const STORAGE_KEY = 'kanban-theme';

  function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }

  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    return next;
  }

  // применяем сразу при подключении скрипта
  document.documentElement.setAttribute('data-theme', getTheme());

  window.KanbanTheme = { getTheme, setTheme, toggleTheme };
})();
