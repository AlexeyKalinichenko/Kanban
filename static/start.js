// Стартовая страница: показывает все доски (сколько файлов в папке Data —
// столько плиток здесь отображается), позволяет создать новую доску
// и удалить существующую.

const boardsGrid = document.getElementById('boards-grid');

// --- Переключатель темы ---
const themeToggleBtn = document.getElementById('theme-toggle');

function themeButtonLabel(theme) {
  return theme === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема';
}

function updateThemeButton() {
  themeToggleBtn.textContent = themeButtonLabel(window.KanbanTheme.getTheme());
}

themeToggleBtn.addEventListener('click', () => {
  window.KanbanTheme.toggleTheme();
  updateThemeButton();
});

updateThemeButton();


function wordForColumns(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'столбец';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'столбца';
  return 'столбцов';
}

function createAddTile() {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'add-board-tile';
  tile.innerHTML = '+ Создать доску';
  tile.addEventListener('click', async () => {
    const name = prompt('Название новой доски:', 'Новая доска');
    if (name === null) return;
    const title = name.trim() || 'Новая доска';
    try {
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const data = await res.json();
      if (data.id) {
        window.location.href = `/board/${data.id}`;
      }
    } catch (err) {
      console.error('Не удалось создать доску:', err);
    }
  });
  return tile;
}

function createBoardTile(board) {
  const tile = document.createElement('a');
  tile.className = 'board-tile';
  tile.href = `/board/${board.id}`;

  const title = document.createElement('div');
  title.className = 'board-tile-title';
  title.textContent = board.title;

  const meta = document.createElement('div');
  meta.className = 'board-tile-meta';
  meta.textContent = `${board.columns_count} ${wordForColumns(board.columns_count)}`;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'board-tile-delete';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.title = 'Удалить доску';
  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = confirm(`Удалить доску «${board.title}»? Это действие нельзя отменить.`);
    if (!ok) return;
    try {
      await fetch(`/api/boards/${board.id}`, { method: 'DELETE' });
      tile.remove();
      refreshEmptyHint();
    } catch (err) {
      console.error('Не удалось удалить доску:', err);
    }
  });

  tile.appendChild(deleteBtn);
  tile.appendChild(title);
  tile.appendChild(meta);
  return tile;
}

let emptyHintEl = null;

function refreshEmptyHint() {
  const hasBoards = boardsGrid.querySelectorAll('.board-tile').length > 0;
  if (!hasBoards && !emptyHintEl) {
    emptyHintEl = document.createElement('div');
    emptyHintEl.className = 'empty-hint';
    emptyHintEl.textContent = 'Пока нет ни одной доски — создайте первую.';
    boardsGrid.parentElement.insertBefore(emptyHintEl, boardsGrid);
  } else if (hasBoards && emptyHintEl) {
    emptyHintEl.remove();
    emptyHintEl = null;
  }
}

async function loadBoards() {
  try {
    const res = await fetch('/api/boards');
    const data = await res.json();
    const boards = data.boards || [];

    boards.forEach(board => {
      boardsGrid.appendChild(createBoardTile(board));
    });
    boardsGrid.appendChild(createAddTile());
    refreshEmptyHint();
  } catch (err) {
    console.error('Не удалось загрузить список досок:', err);
    boardsGrid.appendChild(createAddTile());
  }
}

loadBoards();
