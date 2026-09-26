  // Каждая доска хранится в своём файле на сервере (Data/<guid>.txt).
  // ID доски берётся из URL вида /board/<guid>.
  // При загрузке страницы доска запрашивается через GET /api/board/<id>.
  // Если файла нет или он пуст — доска отображается пустой (без столбцов).
  // При любом изменении в UI доска целиком пересохраняется через POST /api/board/<id>.
  const BOARD_ID = window.location.pathname.split('/').filter(Boolean)[1] || '';
  const BOARD_API_URL = `/api/board/${BOARD_ID}`;

  if (!BOARD_ID) {
    // на страницу доски попали без id — возвращаемся на стартовую страницу
    window.location.href = '/';
  }

  let cardIdCounter = 1;
  let columnIdCounter = 1;
  let draggedCardEl = null;
  let draggedColumnEl = null;

  const dotColors = ['#ff9f7c', '#ffd76c', '#6cff9f', '#7c8cff', '#ff7ce0', '#7cf0ff'];

  const board = document.getElementById('board');

  function nextDotColor() {
    return dotColors[(columnIdCounter - 1) % dotColors.length];
  }

  function updateColumnCount(columnEl) {
    const cardsContainer = columnEl.querySelector('.cards');
    const countEl = columnEl.querySelector('.count');
    countEl.textContent = cardsContainer.children.length;
  }

  const PRIORITIES = {
    critical: { label: 'Критический', className: 'priority-critical' },
    medium:   { label: 'Средний',     className: 'priority-medium' },
    minor:    { label: 'Минорный',    className: 'priority-minor' }
  };
  const DEFAULT_PRIORITY = 'medium';

  // Палитра из 10 возможных цветов для тегов (первые 4 — цвета тегов по умолчанию).
  const PALETTE = [
    { key: 'red',    name: 'красный',     bg: '#e0454f', text: '#ffffff' },
    { key: 'green',  name: 'зеленый',     bg: '#43b56a', text: '#ffffff' },
    { key: 'yellow', name: 'желтый',      bg: '#d4a72c', text: '#2b2205' },
    { key: 'blue',   name: 'синий',       bg: '#4c7cf0', text: '#ffffff' },
    { key: 'gray',   name: 'серый',       bg: '#6b7280', text: '#ffffff' },
    { key: 'brown',  name: 'коричневый',  bg: '#8a5a3b', text: '#ffffff' },
    { key: 'purple', name: 'фиолетовый',  bg: '#8b5cf6', text: '#ffffff' },
    { key: 'cyan',   name: 'голубой',     bg: '#22b8cf', text: '#ffffff' },
    { key: 'pink',   name: 'розовый',     bg: '#ec4899', text: '#ffffff' },
    { key: 'lime',   name: 'салатовый',   bg: '#84cc16', text: '#1a2e05' }
  ];

  function getPaletteEntry(colorKey) {
    return PALETTE.find(p => p.key === colorKey) || PALETTE[0];
  }

  // Список тегов, доступных для этой доски — общий для всех карточек.
  // Задаётся при загрузке доски (см. loadBoard) и меняется через меню
  // карточки (⋯ → Теги → Новый / крестик у тега в списке).
  const DEFAULT_TAG_DEFS = [
    { key: 'yellow', label: 'желтый',  color: 'yellow' },
    { key: 'blue',   label: 'синий',   color: 'blue' },
    { key: 'green',  label: 'зеленый', color: 'green' },
    { key: 'red',    label: 'красный', color: 'red' }
  ];
  let tagRegistry = DEFAULT_TAG_DEFS.map(t => ({ ...t }));

  function getTagDef(key) {
    return tagRegistry.find(t => t.key === key);
  }

  function generateTagKey() {
    return 'tag-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Создаёт новый тег в общем реестре доски (сохранение — на вызывающей стороне).
  function createTagDefinition(label, colorKey) {
    const def = {
      key: generateTagKey(),
      label: label,
      color: PALETTE.some(p => p.key === colorKey) ? colorKey : PALETTE[0].key
    };
    tagRegistry.push(def);
    return def;
  }

  // Удаляет тег из общего реестра доски — он пропадает из меню всех карточек
  // и снимается со всех карточек, где был проставлен.
  function deleteTagDefinition(key) {
    tagRegistry = tagRegistry.filter(t => t.key !== key);
    document.querySelectorAll('.card').forEach(refreshCardTags);
    saveBoard();
  }

  // Перерисовывает бейджи тегов конкретной карточки на основе el.dataset.tags
  // и текущего состояния tagRegistry (теги, удалённые из реестра, пропадают).
  function refreshCardTags(cardEl) {
    const container = cardEl.querySelector(':scope > .card-tags');
    if (!container) return;
    container.innerHTML = '';
    const keys = (cardEl.dataset.tags || '').split(',').filter(Boolean);
    const validKeys = [];
    keys.forEach(key => {
      const def = getTagDef(key);
      if (!def) return; // тег удалён из реестра — не показываем
      validKeys.push(key);
      container.appendChild(buildTagPill(cardEl, def));
    });
    cardEl.dataset.tags = validKeys.join(',');
    container.style.display = validKeys.length ? '' : 'none';
  }

  function buildTagPill(cardEl, def) {
    const swatch = getPaletteEntry(def.color);

    const pill = document.createElement('span');
    pill.className = 'card-tag';
    pill.style.background = swatch.bg;
    pill.style.color = swatch.text;

    const label = document.createElement('span');
    label.className = 'card-tag-label';
    label.textContent = def.label;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'card-tag-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Убрать тег';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      toggleCardTag(cardEl, def.key);
    };

    pill.appendChild(label);
    pill.appendChild(removeBtn);
    return pill;
  }

  // Добавляет/снимает тег с конкретной карточки и сохраняет доску.
  function toggleCardTag(cardEl, key) {
    let keys = (cardEl.dataset.tags || '').split(',').filter(Boolean);
    if (keys.includes(key)) {
      keys = keys.filter(k => k !== key);
    } else {
      keys.push(key);
    }
    cardEl.dataset.tags = keys.join(',');
    refreshCardTags(cardEl);
    saveBoard();
  }

  // Символ чекбокса (☐) в тексте карточки отображается крупнее обычного
  // текста — оборачиваем его в span при отрисовке. Хранится и
  // редактируется он при этом как обычный символ (textContent/value
  // остаются простой строкой, span — только для отображения).
  const CHECKBOX_OFF = '☐';
  const CHECKBOX_ON = '☑';

  // Символ чекбокса в тексте карточки отображается крупнее обычного текста
  // и кликабелен — переключает состояние on/off (меняет сам символ ☐ ↔ ☑).
  // Хранится как обычный символ внутри текста карточки (сохраняется в конфиг
  // вместе с остальным текстом), поэтому его так же можно удалить/
  // скопировать/вставить как букву.
  function renderCardText(container, text) {
    container.innerHTML = '';
    let buffer = '';
    const chars = Array.from(text);

    function flushBuffer() {
      if (buffer) {
        container.appendChild(document.createTextNode(buffer));
        buffer = '';
      }
    }

    chars.forEach((ch, idx) => {
      if (ch === CHECKBOX_OFF || ch === CHECKBOX_ON) {
        flushBuffer();
        const cb = document.createElement('span');
        cb.className = 'card-checkbox-char' + (ch === CHECKBOX_ON ? ' checked' : '');
        cb.textContent = ch;
        cb.title = 'Нажмите, чтобы отметить';
        cb.addEventListener('click', (e) => {
          e.stopPropagation();
          const current = Array.from(container.textContent);
          current[idx] = current[idx] === CHECKBOX_OFF ? CHECKBOX_ON : CHECKBOX_OFF;
          renderCardText(container, current.join(''));
          saveBoard();
        });
        container.appendChild(cb);
      } else {
        buffer += ch;
      }
    });
    flushBuffer();
  }

  function createCardElement(text, priority, initialTags) {
    priority = PRIORITIES[priority] ? priority : DEFAULT_PRIORITY;
    const info = PRIORITIES[priority];

    const id = 'card-' + (cardIdCounter++);
    const el = document.createElement('div');
    el.className = 'card ' + info.className;
    el.draggable = true;
    el.id = id;
    el.dataset.priority = priority;

    const badge = document.createElement('div');
    badge.className = 'card-priority-badge';
    const badgeDot = document.createElement('span');
    badgeDot.className = 'dot';
    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = info.label;
    badge.appendChild(badgeDot);
    badge.appendChild(badgeLabel);

    const textEl = document.createElement('div');
    textEl.className = 'card-text';
    renderCardText(textEl, text);
    textEl.title = 'Двойной клик — редактировать';

    // --- Редактирование текста карточки по двойному клику ---
    textEl.addEventListener('dblclick', () => {
      const originalText = textEl.textContent;

      const editArea = document.createElement('textarea');
      editArea.className = 'card-text-edit';
      editArea.value = originalText;

      el.draggable = false; // не мешаем drag'ом выделению текста при редактировании
      textEl.replaceWith(editArea);
      editArea.focus();
      editArea.setSelectionRange(editArea.value.length, editArea.value.length);

      function resize() {
        editArea.style.height = 'auto';
        editArea.style.height = editArea.scrollHeight + 'px';
      }
      resize();
      editArea.addEventListener('input', resize);

      let finished = false;
      function finishEdit(save) {
        if (finished) return;
        finished = true;
        if (save) {
          const newText = editArea.value.trim();
          renderCardText(textEl, newText || originalText);
        }
        editArea.replaceWith(textEl);
        el.draggable = true;
        if (save && textEl.textContent !== originalText) {
          saveBoard();
        }
      }

      editArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finishEdit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finishEdit(false);
        } else if (e.key === 'Enter') {
          // если в текущей строке есть чекбокс — продолжаем список:
          // на новую строку тоже добавляем пустой чекбокс
          const pos = editArea.selectionStart;
          const value = editArea.value;
          const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
          const currentLine = value.slice(lineStart, pos);
          if (currentLine.includes(CHECKBOX_OFF) || currentLine.includes(CHECKBOX_ON)) {
            e.preventDefault();
            const insertion = '\n' + CHECKBOX_OFF;
            const before = value.slice(0, pos);
            const after = value.slice(editArea.selectionEnd);
            editArea.value = before + insertion + after;
            const newPos = pos + insertion.length;
            editArea.setSelectionRange(newPos, newPos);
            resize();
          }
        }
      });

      editArea.addEventListener('blur', () => finishEdit(true));
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'card-delete';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Удалить карточку';
    delBtn.onclick = () => {
      const col = el.closest('.column');
      el.remove();
      if (col) updateColumnCount(col);
      saveBoard();
    };

    // --- Меню карточки (три точки) — пока только смена приоритета ---
    const menuWrapper = document.createElement('div');
    menuWrapper.className = 'card-menu-wrapper';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'card-menu-btn';
    menuBtn.innerHTML = '&#8943;'; // ⋯
    menuBtn.title = 'Меню карточки';

    const menu = document.createElement('div');
    menu.className = 'card-menu';

    function closeMenu() {
      menu.classList.remove('open');
      renderMenuRoot();
    }

    function renderMenuRoot() {
      menu.innerHTML = '';

      const priorityItem = document.createElement('button');
      priorityItem.type = 'button';
      priorityItem.className = 'card-menu-item';
      priorityItem.textContent = 'Приоритет';
      priorityItem.onclick = (e) => {
        e.stopPropagation();
        renderMenuPriority();
      };
      menu.appendChild(priorityItem);

      const tagItem = document.createElement('button');
      tagItem.type = 'button';
      tagItem.className = 'card-menu-item';
      tagItem.textContent = 'Теги';
      tagItem.onclick = (e) => {
        e.stopPropagation();
        renderMenuTag();
      };
      menu.appendChild(tagItem);

      const checkboxItem = document.createElement('button');
      checkboxItem.type = 'button';
      checkboxItem.className = 'card-menu-item';
      checkboxItem.textContent = 'Чекбокс';
      checkboxItem.onclick = (e) => {
        e.stopPropagation();
        // символ чекбокса добавляется в конец текста как обычный символ —
        // его можно удалить/скопировать/вставить как букву; сохраняется
        // на сервере как часть текста карточки.
        const current = textEl.textContent;
        const separator = current === '' || current.endsWith('\n') ? '' : '\n';
        renderCardText(textEl, current + separator + CHECKBOX_OFF);
        closeMenu();
        saveBoard();
      };
      menu.appendChild(checkboxItem);
    }

    function renderMenuPriority() {
      menu.innerHTML = '';
      Object.keys(PRIORITIES).forEach(key => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-item card-menu-priority-option';
        if (key === el.dataset.priority) opt.classList.add('active');
        opt.textContent = PRIORITIES[key].label;
        opt.onclick = (e) => {
          e.stopPropagation();
          el.className = 'card ' + PRIORITIES[key].className;
          el.dataset.priority = key;
          badgeLabel.textContent = PRIORITIES[key].label;
          closeMenu();
          saveBoard();
        };
        menu.appendChild(opt);
      });
    }

    function renderMenuTag() {
      menu.innerHTML = '';

      const currentKeys = new Set((el.dataset.tags || '').split(',').filter(Boolean));

      tagRegistry.forEach(def => {
        const row = document.createElement('div');
        row.className = 'card-menu-tag-row';

        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-item card-menu-priority-option card-menu-tag-toggle';
        if (currentKeys.has(def.key)) opt.classList.add('active');

        const swatch = document.createElement('span');
        swatch.className = 'card-menu-tag-swatch';
        swatch.style.background = getPaletteEntry(def.color).bg;

        opt.appendChild(swatch);
        opt.appendChild(document.createTextNode(def.label));
        opt.onclick = (e) => {
          e.stopPropagation();
          toggleCardTag(el, def.key);
          renderMenuTag(); // не закрываем меню — можно выбрать сразу несколько тегов
        };

        const deleteTagBtn = document.createElement('button');
        deleteTagBtn.type = 'button';
        deleteTagBtn.className = 'card-menu-tag-delete';
        deleteTagBtn.innerHTML = '&times;';
        deleteTagBtn.title = 'Удалить тег из списка (снимется со всех карточек)';
        deleteTagBtn.onclick = (e) => {
          e.stopPropagation();
          const ok = confirm('Удалить тег «' + def.label + '» из списка? Он будет снят со всех карточек.');
          if (!ok) return;
          deleteTagDefinition(def.key);
          renderMenuTag();
        };

        row.appendChild(opt);
        row.appendChild(deleteTagBtn);
        menu.appendChild(row);
      });

      const newTagBtn = document.createElement('button');
      newTagBtn.type = 'button';
      newTagBtn.className = 'card-menu-item card-menu-new-tag-btn';
      newTagBtn.textContent = '+ Новый';
      newTagBtn.onclick = (e) => {
        e.stopPropagation();
        const name = prompt('Название нового тега:', '');
        if (name === null) return; // отмена
        const label = name.trim();
        if (!label) return; // без названия тег не создаём
        renderMenuColorPicker(label);
      };
      menu.appendChild(newTagBtn);
    }

    function renderMenuColorPicker(label) {
      menu.innerHTML = '';

      const heading = document.createElement('div');
      heading.className = 'card-menu-color-heading';
      heading.textContent = 'Цвет для «' + label + '»';
      menu.appendChild(heading);

      PALETTE.forEach(p => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-item card-menu-priority-option';

        const swatch = document.createElement('span');
        swatch.className = 'card-menu-tag-swatch';
        swatch.style.background = p.bg;

        opt.appendChild(swatch);
        opt.appendChild(document.createTextNode(p.name));
        opt.onclick = (e) => {
          e.stopPropagation();
          createTagDefinition(label, p.key);
          saveBoard();
          renderMenuTag();
        };
        menu.appendChild(opt);
      });

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'card-menu-item card-menu-color-back';
      backBtn.textContent = '← Назад';
      backBtn.onclick = (e) => {
        e.stopPropagation();
        renderMenuTag();
      };
      menu.appendChild(backBtn);
    }

    renderMenuRoot();

    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) {
        renderMenuRoot();
        menu.classList.add('open');
      }
    };

    menuWrapper.appendChild(menuBtn);
    menuWrapper.appendChild(menu);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(menuWrapper);
    actions.appendChild(delBtn);

    el.appendChild(badge);

    // --- Теги карточки (можно повесить несколько, реестр общий для доски) ---
    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'card-tags';
    tagsContainer.style.display = 'none';
    el.appendChild(tagsContainer);

    el.dataset.tags = (initialTags || []).join(',');
    refreshCardTags(el);

    el.appendChild(textEl);
    el.appendChild(actions);

    el.addEventListener('dragstart', (e) => {
      e.stopPropagation(); // не даём событию всплыть до столбца и запустить его drag
      draggedCardEl = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', (e) => {
      e.stopPropagation();
      el.classList.remove('dragging');
      draggedCardEl = null;
      document.querySelectorAll('.column').forEach(updateColumnCount);
      saveBoard();
    });

    return el;
  }

  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function getDragAfterColumn(container, x) {
    const columns = [...container.querySelectorAll('.column:not(.column-dragging)')];
    return columns.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function attachColumnDragEvents(columnEl) {
    const cardsContainer = columnEl.querySelector('.cards');

    // --- перетаскивание карточек внутри/между столбцами ---
    columnEl.addEventListener('dragover', (e) => {
      if (draggedColumnEl) return; // сейчас двигаем столбец, а не карточку
      if (!draggedCardEl) return;
      e.preventDefault();
      columnEl.classList.add('drag-over');
      const afterElement = getDragAfterElement(cardsContainer, e.clientY);
      if (afterElement == null) {
        cardsContainer.appendChild(draggedCardEl);
      } else {
        cardsContainer.insertBefore(draggedCardEl, afterElement);
      }
    });

    columnEl.addEventListener('dragleave', (e) => {
      if (!columnEl.contains(e.relatedTarget)) {
        columnEl.classList.remove('drag-over');
      }
    });

    columnEl.addEventListener('drop', (e) => {
      if (draggedColumnEl) return;
      e.preventDefault();
      columnEl.classList.remove('drag-over');
      document.querySelectorAll('.column').forEach(updateColumnCount);
    });

    // --- перетаскивание самого столбца ---
    columnEl.draggable = true;

    columnEl.addEventListener('dragstart', (e) => {
      // не начинаем перетаскивание столбца, если тянут карточку или взаимодействуют с полем/кнопкой
      if (e.target.closest('.card') || e.target.closest('.column-title-input') ||
          e.target.closest('.column-delete') || e.target.closest('.add-form')) {
        e.preventDefault();
        return;
      }
      draggedColumnEl = columnEl;
      columnEl.classList.add('column-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });

    columnEl.addEventListener('dragend', () => {
      columnEl.classList.remove('column-dragging');
      draggedColumnEl = null;
      saveBoard();
    });
  }

  function setupAutoGrow(textarea) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });
    textarea.addEventListener('keydown', (e) => {
      // Enter — перенос строки (многострочный текст), Ctrl/Cmd+Enter — отправка карточки
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        textarea.closest('form').requestSubmit();
      }
    });
  }

  function createColumn(title, cards) {
    cards = cards || [];
    const columnId = 'col-' + (columnIdCounter++);
    const color = nextDotColor();

    const columnEl = document.createElement('div');
    columnEl.className = 'column';
    columnEl.dataset.columnId = columnId;

    // header
    const header = document.createElement('div');
    header.className = 'column-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'column-title';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'column-drag-handle';
    dragHandle.innerHTML = '&#8942;&#8942;';
    dragHandle.title = 'Перетащить столбец';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;

    const titleInput = document.createElement('input');
    titleInput.className = 'column-title-input';
    titleInput.value = title;
    titleInput.maxLength = 40;
    titleInput.title = 'Название столбца';
    titleInput.addEventListener('change', () => saveBoard());

    titleWrap.appendChild(dragHandle);
    titleWrap.appendChild(dot);
    titleWrap.appendChild(titleInput);

    const headerRight = document.createElement('div');
    headerRight.className = 'header-right';

    const countEl = document.createElement('div');
    countEl.className = 'count';
    countEl.textContent = '0';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'column-delete';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Удалить столбец';
    deleteBtn.onclick = () => {
      const cardsCount = columnEl.querySelectorAll('.card').length;
      if (cardsCount > 0) {
        const ok = confirm('В столбце "' + titleInput.value + '" есть карточки (' + cardsCount + '). Удалить столбец вместе с ними?');
        if (!ok) return;
      }
      columnEl.remove();
      saveBoard();
    };

    headerRight.appendChild(countEl);
    headerRight.appendChild(deleteBtn);

    header.appendChild(titleWrap);
    header.appendChild(headerRight);

    // cards container
    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'cards';

    // add form
    const form = document.createElement('form');
    form.className = 'add-form';

    const row = document.createElement('div');
    row.className = 'add-form-row';

    const prioritySelect = document.createElement('select');
    prioritySelect.className = 'priority-select';
    prioritySelect.title = 'Приоритет карточки';
    Object.keys(PRIORITIES).forEach(key => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PRIORITIES[key].label;
      if (key === DEFAULT_PRIORITY) opt.selected = true;
      prioritySelect.appendChild(opt);
    });

    const textarea = document.createElement('textarea');
    textarea.className = 'add-input';
    textarea.rows = 1;
    textarea.placeholder = 'Новая карточка...';
    textarea.required = true;

    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'add-btn';
    addBtn.textContent = '+';

    row.appendChild(textarea);
    row.appendChild(addBtn);
    form.appendChild(prioritySelect);
    form.appendChild(row);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = textarea.value.trim();
      if (!value) return;
      cardsContainer.appendChild(createCardElement(value, prioritySelect.value));
      textarea.value = '';
      textarea.style.height = 'auto';
      prioritySelect.value = DEFAULT_PRIORITY;
      updateColumnCount(columnEl);
      saveBoard();
    });

    setupAutoGrow(textarea);

    columnEl.appendChild(header);
    columnEl.appendChild(cardsContainer);
    columnEl.appendChild(form);

    attachColumnDragEvents(columnEl);

    cards.forEach(c => cardsContainer.appendChild(createCardElement(c.text, c.priority, c.tags)));
    updateColumnCount(columnEl);

    return columnEl;
  }

  const addColumnBtn = document.createElement('button');
  addColumnBtn.type = 'button';
  addColumnBtn.className = 'add-column';
  addColumnBtn.innerHTML = '+ Добавить столбец';
  addColumnBtn.onclick = () => {
    const name = prompt('Название нового столбца:', 'Новый столбец');
    if (name === null) return;
    const trimmed = name.trim() || 'Новый столбец';
    const columnEl = createColumn(trimmed, []);
    board.insertBefore(columnEl, addColumnBtn);
    saveBoard();
  };

  board.appendChild(addColumnBtn);

  // --- Сохранение состояния доски на сервер ---
  const boardTitleInput = document.getElementById('board-title');

  function serializeBoard() {
    const columns = [];
    board.querySelectorAll(':scope > .column').forEach(columnEl => {
      const title = columnEl.querySelector('.column-title-input').value;
      const cards = [];
      columnEl.querySelectorAll('.cards > .card').forEach(cardEl => {
        const text = cardEl.querySelector('.card-text').textContent;
        const priority = cardEl.dataset.priority || DEFAULT_PRIORITY;
        const tags = (cardEl.dataset.tags || '').split(',').filter(Boolean);
        cards.push({ text, priority, tags });
      });
      columns.push({ title, cards });
    });
    return { title: boardTitleInput.value, columns, tagDefs: tagRegistry };
  }

  function saveBoard() {
    fetch(BOARD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serializeBoard())
    }).catch(err => console.error('Не удалось сохранить доску:', err));
  }

  // --- Загрузка состояния доски с сервера при открытии страницы ---
  function renderColumns(columns) {
    columns.forEach(col => {
      const columnEl = createColumn(col.title, col.cards || []);
      board.insertBefore(columnEl, addColumnBtn);
    });
  }

  async function loadBoard() {
    try {
      const res = await fetch(BOARD_API_URL);
      const data = await res.json();
      if (data.title) {
        boardTitleInput.value = data.title;
      }
      // реестр тегов доски — важно установить ДО отрисовки карточек,
      // чтобы бейджи тегов сразу отрисовались с правильными цветами/названиями
      if (Array.isArray(data.tagDefs)) {
        tagRegistry = data.tagDefs;
      }
      // если файла нет или он пуст — data.columns будет пустым массивом,
      // и доска просто останется пустой (без столбцов)
      if (data.columns && data.columns.length > 0) {
        renderColumns(data.columns);
      }
    } catch (err) {
      console.error('Не удалось загрузить доску с сервера:', err);
    }
  }

  boardTitleInput.addEventListener('change', () => saveBoard());

  if (BOARD_ID) {
    loadBoard();
  }

  // --- Drag-n-drop для перестановки столбцов ---
  board.addEventListener('dragover', (e) => {
    if (!draggedColumnEl) return;
    e.preventDefault();
    const afterElement = getDragAfterColumn(board, e.clientX);
    if (afterElement == null) {
      board.insertBefore(draggedColumnEl, addColumnBtn);
    } else {
      board.insertBefore(draggedColumnEl, afterElement);
    }
  });

  board.addEventListener('drop', (e) => {
    if (!draggedColumnEl) return;
    e.preventDefault();
  });

  // Прокрутка доски колесом мыши по горизонтали (без Shift),
  // но только если курсор НЕ над списком карточек, который сам можно скроллить вертикально
  board.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    const cardsEl = e.target.closest('.cards');
    if (cardsEl && cardsEl.scrollHeight > cardsEl.clientHeight) {
      // отдаём событие списку карточек — пусть скроллится вертикально сам
      return;
    }
    board.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // Закрываем открытое меню карточки при клике вне его
  document.addEventListener('click', (e) => {
    if (e.target.closest('.card-menu-wrapper')) return;
    document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
  });
