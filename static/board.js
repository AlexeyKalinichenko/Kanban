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

  const dotColors = ['#ff9999', '#0fbcb0', '#4262ff', '#00b473', '#5b76fe', '#fcb900'];

  // SVG-иконки интерфейса (дизайн-система «Like Miro»: без эмодзи и символов-заглушек)
  const svg = (paths, size, extra) =>
    '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '>' + paths + '</svg>';
  const ICONS = {
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    closeSmall: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    plusLarge: svg('<path d="M12 5v14M5 12h14"/>', 18),
    plusSmall: svg('<path d="M12 5v14M5 12h14"/>', 14),
    check: svg('<path d="M5 12l5 5 9-10"/>', 16, ' class="card-menu-check" stroke-width="2.2"'),
    chevronRight: svg('<path d="M9 6l6 6-6 6"/>', 14, ' class="card-menu-chevron"'),
    chevronLeft: svg('<path d="M15 6l-6 6 6 6"/>', 14),
    chevronDown: svg('<path d="M6 9l6 6 6-6"/>', 12, ' class="card-priority-chevron" stroke-width="2.5"'),
    tag: svg('<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>'),
    checkbox: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.5l3 3 5-6"/>'),
    grip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>'
  };

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
    critical: { label: 'Критический', className: 'priority-critical', bg: '#ffc6c6', fg: '#600000' },
    medium:   { label: 'Средний',     className: 'priority-medium',   bg: '#c3faf5', fg: '#187574' },
    minor:    { label: 'Минорный',    className: 'priority-minor',    bg: '#e0e2e8', fg: '#555a6a' }
  };
  const DEFAULT_PRIORITY = 'medium';

  // Палитра из 10 возможных цветов для тегов (первые 4 — цвета тегов по умолчанию).
  // Цвета взяты из дизайн-системы «Like Miro»: пастельный фон + тёмный текст.
  // Ключи не менялись — старые файлы досок открываются без миграции.
  const PALETTE = [
    { key: 'red',    name: 'красный',     bg: '#ffc6c6', text: '#600000' },
    { key: 'green',  name: 'зеленый',     bg: '#c3faf5', text: '#187574' },
    { key: 'yellow', name: 'желтый',      bg: '#fff4c4', text: '#746019' },
    { key: 'blue',   name: 'синий',       bg: '#4262ff', text: '#ffffff' },
    { key: 'gray',   name: 'серый',       bg: '#e0e2e8', text: '#555a6a' },
    { key: 'brown',  name: 'коричневый',  bg: '#ffe6cd', text: '#600000' },
    { key: 'purple', name: 'фиолетовый',  bg: '#f5f3ff', text: '#2a41b6' },
    { key: 'cyan',   name: 'голубой',     bg: '#0fbcb0', text: '#1c1c1e' },
    { key: 'pink',   name: 'розовый',     bg: '#ffd8f4', text: '#600000' },
    { key: 'lime',   name: 'салатовый',   bg: '#00b473', text: '#1c1c1e' }
  ];

  // Кружок цвета в меню: пастельная заливка + тонкий контур цветом текста,
  // чтобы светлые цвета не терялись на белом фоне меню.
  function styleSwatch(swatchEl, bg, fg) {
    swatchEl.style.background = bg;
    swatchEl.style.boxShadow = 'inset 0 0 0 1px ' + fg;
  }

  function getPaletteEntry(colorKey) {
    return PALETTE.find(p => p.key === colorKey) || PALETTE[0];
  }

  // Список тегов, доступных для этой доски — общий для всех карточек.
  // Задаётся при загрузке доски (см. loadBoard) и меняется через кнопку
  // тегов на карточке (→ Новый тег / крестик у тега в списке).
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
    const container = cardEl.querySelector('.card-tags');
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
  //
  // Каждая строка оборачивается в span.card-line (первая — .card-line-title,
  // отмеченный пункт чек-листа — .card-line-done), а переводы строк остаются
  // обычными текстовыми узлами — поэтому container.textContent по-прежнему
  // равен исходному тексту карточки (на этом держатся редактирование и сохранение).
  function renderCardText(container, text) {
    container.innerHTML = '';
    let buffer = '';
    const chars = Array.from(text);
    let lineEl = null;
    let lineIndex = 0;
    let atLineStart = true;

    function startLine(firstChar) {
      lineEl = document.createElement('span');
      let cls = 'card-line';
      if (firstChar === CHECKBOX_ON) cls += ' card-line-done';
      else if (lineIndex === 0 && firstChar !== CHECKBOX_OFF) cls += ' card-line-title';
      lineEl.className = cls;
      container.appendChild(lineEl);
      atLineStart = false;
    }

    function flushBuffer() {
      if (buffer) {
        lineEl.appendChild(document.createTextNode(buffer));
        buffer = '';
      }
    }

    chars.forEach((ch, idx) => {
      if (ch === '\n') {
        if (atLineStart) startLine('');
        flushBuffer();
        container.appendChild(document.createTextNode('\n'));
        lineIndex++;
        atLineStart = true;
        return;
      }
      if (atLineStart) startLine(ch);
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
        lineEl.appendChild(cb);
      } else {
        buffer += ch;
      }
    });
    if (lineEl) flushBuffer();
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

    // Плашка приоритета — это и кнопка: по клику под ней открывается
    // список приоритетов (см. «Меню приоритета» ниже).
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'card-priority-badge';
    badge.title = 'Сменить приоритет';
    const badgeDot = document.createElement('span');
    badgeDot.className = 'dot';
    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = info.label;
    badge.appendChild(badgeDot);
    badge.appendChild(badgeLabel);
    badge.insertAdjacentHTML('beforeend', ICONS.chevronDown);

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
    delBtn.type = 'button';
    delBtn.className = 'card-delete';
    delBtn.innerHTML = ICONS.close;
    delBtn.title = 'Удалить карточку';
    delBtn.setAttribute('aria-label', 'Удалить карточку');
    delBtn.onclick = () => {
      const col = el.closest('.column');
      el.remove();
      if (col) updateColumnCount(col);
      saveBoard();
    };

    // --- Кнопка «Чекбокс»: добавляет пустой чекбокс в конец текста карточки.
    // Символ чекбокса — обычный символ текста: его можно удалить/скопировать/
    // вставить как букву; сохраняется на сервере как часть текста карточки.
    const checkboxBtn = document.createElement('button');
    checkboxBtn.type = 'button';
    checkboxBtn.className = 'card-menu-btn card-checkbox-btn';
    checkboxBtn.innerHTML = ICONS.checkbox;
    checkboxBtn.title = 'Добавить чекбокс';
    checkboxBtn.setAttribute('aria-label', 'Добавить чекбокс');
    checkboxBtn.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      const current = textEl.textContent;
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      renderCardText(textEl, current + separator + CHECKBOX_OFF);
      saveBoard();
    };

    // --- Меню тегов: кнопка с ярлыком открывает список тегов ---
    const menuWrapper = document.createElement('div');
    menuWrapper.className = 'card-menu-wrapper';

    const tagBtn = document.createElement('button');
    tagBtn.type = 'button';
    tagBtn.className = 'card-menu-btn card-tag-btn';
    tagBtn.innerHTML = ICONS.tag;
    tagBtn.title = 'Теги';
    tagBtn.setAttribute('aria-label', 'Теги');

    const menu = document.createElement('div');
    menu.className = 'card-menu';

    function renderMenuTag() {
      menu.innerHTML = '';

      const currentKeys = new Set((el.dataset.tags || '').split(',').filter(Boolean));

      tagRegistry.forEach(def => {
        const row = document.createElement('div');
        row.className = 'card-menu-tag-row';

        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-item card-menu-priority-option card-menu-tag-toggle';
        const tagActive = currentKeys.has(def.key);
        if (tagActive) opt.classList.add('active');

        const swatch = document.createElement('span');
        swatch.className = 'card-menu-tag-swatch';
        const pe = getPaletteEntry(def.color);
        styleSwatch(swatch, pe.bg, pe.text);

        const tLabel = document.createElement('span');
        tLabel.className = 'card-menu-item-label';
        tLabel.textContent = def.label;

        opt.appendChild(swatch);
        opt.appendChild(tLabel);
        if (tagActive) opt.insertAdjacentHTML('beforeend', ICONS.check);
        opt.onclick = (e) => {
          e.stopPropagation();
          toggleCardTag(el, def.key);
          renderMenuTag(); // не закрываем меню — можно выбрать сразу несколько тегов
        };

        const deleteTagBtn = document.createElement('button');
        deleteTagBtn.type = 'button';
        deleteTagBtn.className = 'card-menu-tag-delete';
        deleteTagBtn.innerHTML = ICONS.closeSmall;
        deleteTagBtn.setAttribute('aria-label', 'Удалить тег «' + def.label + '» из списка');
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

      const sep = document.createElement('div');
      sep.className = 'card-menu-sep';
      menu.appendChild(sep);

      const newTagBtn = document.createElement('button');
      newTagBtn.type = 'button';
      newTagBtn.className = 'card-menu-item card-menu-new-tag-btn';
      newTagBtn.innerHTML = ICONS.plusSmall + '<span>Новый тег</span>';
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

      const grid = document.createElement('div');
      grid.className = 'card-menu-color-grid';
      PALETTE.forEach(p => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-color-swatch';
        opt.style.background = p.bg;
        opt.title = p.name;
        opt.setAttribute('aria-label', p.name);
        opt.onclick = (e) => {
          e.stopPropagation();
          createTagDefinition(label, p.key);
          saveBoard();
          renderMenuTag();
        };
        grid.appendChild(opt);
      });
      menu.appendChild(grid);

      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'card-menu-item card-menu-color-back';
      backBtn.innerHTML = ICONS.chevronLeft + '<span>Назад</span>';
      backBtn.onclick = (e) => {
        e.stopPropagation();
        renderMenuTag();
      };
      menu.appendChild(backBtn);
    }

    // Повторный клик по кнопке тегов закрывает список
    tagBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) {
        renderMenuTag();
        menu.classList.add('open');
      }
    };

    menuWrapper.appendChild(tagBtn);
    menuWrapper.appendChild(menu);

    // Кнопки справа в шапке карточки: теги, чекбокс, удалить
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(menuWrapper);
    actions.appendChild(checkboxBtn);
    actions.appendChild(delBtn);

    // --- Меню приоритета: открывается кликом по самой плашке приоритета ---
    const priorityWrapper = document.createElement('div');
    priorityWrapper.className = 'card-menu-wrapper card-priority-wrapper';

    const priorityMenu = document.createElement('div');
    priorityMenu.className = 'card-menu card-priority-menu';

    function renderPriorityMenu() {
      priorityMenu.innerHTML = '';
      Object.keys(PRIORITIES).forEach(key => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'card-menu-item card-menu-priority-option';
        const isActive = key === el.dataset.priority;
        if (isActive) opt.classList.add('active');
        const pSwatch = document.createElement('span');
        pSwatch.className = 'card-menu-tag-swatch';
        styleSwatch(pSwatch, PRIORITIES[key].bg, PRIORITIES[key].fg);
        const pLabel = document.createElement('span');
        pLabel.className = 'card-menu-item-label';
        pLabel.textContent = PRIORITIES[key].label;
        opt.appendChild(pSwatch);
        opt.appendChild(pLabel);
        if (isActive) opt.insertAdjacentHTML('beforeend', ICONS.check);
        opt.onclick = (e) => {
          e.stopPropagation();
          priorityMenu.classList.remove('open');
          if (key === el.dataset.priority) return;
          el.className = 'card ' + PRIORITIES[key].className;
          el.dataset.priority = key;
          badgeLabel.textContent = PRIORITIES[key].label;
          saveBoard();
        };
        priorityMenu.appendChild(opt);
      });
    }

    badge.onclick = (e) => {
      e.stopPropagation();
      const isOpen = priorityMenu.classList.contains('open');
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) {
        renderPriorityMenu();
        priorityMenu.classList.add('open');
      }
    };

    priorityWrapper.appendChild(badge);
    priorityWrapper.appendChild(priorityMenu);

    // Верхняя строка карточки: бейдж приоритета и теги слева, кнопки ⋯ и × справа
    const head = document.createElement('div');
    head.className = 'card-head';
    const labels = document.createElement('div');
    labels.className = 'card-labels';
    labels.appendChild(priorityWrapper);

    // --- Теги карточки (можно повесить несколько, реестр общий для доски) ---
    const tagsContainer = document.createElement('div');
    tagsContainer.className = 'card-tags';
    tagsContainer.style.display = 'none';
    labels.appendChild(tagsContainer);

    head.appendChild(labels);
    head.appendChild(actions);
    el.appendChild(head);

    el.dataset.tags = (initialTags || []).join(',');
    refreshCardTags(el);

    el.appendChild(textEl);

    el.addEventListener('dragstart', (e) => {
      e.stopPropagation(); // не даём событию всплыть до столбца и запустить его drag
      draggedCardEl = el;
      e.dataTransfer.effectAllowed = 'move';
      // класс ставим на следующем тике: браузер уже снял изображение карточки
      // для курсора, а на её месте остаётся пунктирная «ячейка»
      setTimeout(() => { if (draggedCardEl === el) el.classList.add('dragging'); }, 0);
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
    dragHandle.innerHTML = ICONS.grip;
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
    deleteBtn.type = 'button';
    deleteBtn.className = 'column-delete';
    deleteBtn.innerHTML = ICONS.close;
    deleteBtn.title = 'Удалить столбец';
    deleteBtn.setAttribute('aria-label', 'Удалить столбец');
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
    addBtn.innerHTML = ICONS.plusLarge;
    addBtn.title = 'Добавить карточку';
    addBtn.setAttribute('aria-label', 'Добавить карточку');

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
  addColumnBtn.innerHTML = ICONS.plus + '<span>Добавить столбец</span>';
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
    const background = window.KanbanBoardBg ? window.KanbanBoardBg.get() : '';
    return { title: boardTitleInput.value, background, columns, tagDefs: tagRegistry };
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
      // цвет фона доски (пустая строка — обычный фон)
      if (window.KanbanBoardBg) {
        window.KanbanBoardBg.apply(data.background || '');
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

  // смена цвета фона в палитре — сохраняем доску
  if (window.KanbanBoardBg) {
    window.KanbanBoardBg.onChange(() => saveBoard());
  }

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
