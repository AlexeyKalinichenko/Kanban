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
    pencil: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z"/><path d="M14.5 5.5l3 3"/>'),
    tag: svg('<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>'),
    list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
    checkbox: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.5l3 3 5-6"/>'),
    grip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>'
  };

  const board = document.getElementById('board');

  // --- Окно подтверждения в стиле доски (вместо системного confirm) ---
  // Само окно — в общем модуле static/dialog.js.
  function showConfirmDialog(options) {
    return window.KanbanDialog.confirm(options);
  }

  function wordForCards(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'карточка';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'карточки';
    return 'карточек';
  }

  function nextDotColor() {
    return dotColors[(columnIdCounter - 1) % dotColors.length];
  }

  function updateColumnCount(columnEl) {
    const cardsContainer = columnEl.querySelector('.cards');
    const countEl = columnEl.querySelector('.count');
    countEl.textContent = cardsContainer.children.length;
  }

  const PRIORITIES = {
    // цвета плашек задаются в style.css (--prio-critical и т.д., свои для каждой темы)
    critical: { label: 'Критический', className: 'priority-critical' },
    medium:   { label: 'Средний',     className: 'priority-medium' },
    minor:    { label: 'Минорный',    className: 'priority-minor' }
  };
  const DEFAULT_PRIORITY = 'medium';

  // Палитра из 10 возможных цветов для тегов (первые 4 — цвета тегов по умолчанию).
  // Насыщенные цвета; текст белый, на жёлтом и салатовом — тёмный.
  // Ключи не менялись — старые файлы досок открываются без миграции.
  const PALETTE = [
    { key: 'red',    name: 'красный',     bg: '#dc2626', text: '#ffffff' },
    { key: 'green',  name: 'зеленый',     bg: '#15803d', text: '#ffffff' },
    { key: 'yellow', name: 'желтый',      bg: '#eab308', text: '#1c1c1e' },
    { key: 'blue',   name: 'синий',       bg: '#2563eb', text: '#ffffff' },
    { key: 'gray',   name: 'серый',       bg: '#6b7280', text: '#ffffff' },
    { key: 'brown',  name: 'коричневый',  bg: '#92400e', text: '#ffffff' },
    { key: 'purple', name: 'фиолетовый',  bg: '#7c3aed', text: '#ffffff' },
    { key: 'cyan',   name: 'голубой',     bg: '#0e7490', text: '#ffffff' },
    { key: 'pink',   name: 'розовый',     bg: '#be185d', text: '#ffffff' },
    { key: 'lime',   name: 'салатовый',   bg: '#65a30d', text: '#1c1c1e' }
  ];

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
  // Максимальная длина названия тега (символов)
  const TAG_LABEL_MAX = 15;

  function createTagDefinition(label, colorKey) {
    const def = {
      key: generateTagKey(),
      label: Array.from(label || '').slice(0, TAG_LABEL_MAX).join(''),
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
    // тег без названия — просто цветная плашка
    if (!def.label) pill.classList.add('card-tag-no-label');
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
  // маркер пункта списка: жирная точка + пробел (обычные символы текста)
  const LIST_BULLET = '• ';
  const CHECKBOX_ON = '☑';

  // --- Жирный текст в карточке ---
  // В «сыром» тексте карточки (он же хранится в файле доски) жирный фрагмент
  // обрамляется маркерами **…**, например: «Купить **хлеб** и молоко».
  // Маркеры не переходят через перевод строки: каждая строка размечена отдельно.
  const BOLD_MARK = '**';

  // Разбивает одну строку сырого текста на куски [{ text, bold }].
  // Непарный последний маркер ** считается обычным текстом.
  function richLineSegments(line) {
    const parts = line.split(BOLD_MARK);
    if (parts.length % 2 === 0) {
      const last = parts.pop();
      parts[parts.length - 1] += BOLD_MARK + last;
    }
    const segments = [];
    parts.forEach((text, i) => {
      if (text) segments.push({ text, bold: i % 2 === 1 });
    });
    return segments;
  }

  // Собирает строку сырого текста из символов [{ ch, bold }] одной строки
  function charsToRawLine(chars) {
    let out = '';
    let i = 0;
    while (i < chars.length) {
      const bold = chars[i].bold;
      let run = '';
      while (i < chars.length && chars[i].bold === bold) {
        run += chars[i].ch;
        i++;
      }
      if (bold && run.trim()) {
        // пробелы по краям оставляем снаружи маркеров: «**слово** »
        const lead = run.match(/^\s*/)[0];
        const trail = run.match(/\s*$/)[0];
        out += lead + BOLD_MARK + run.slice(lead.length, run.length - trail.length) + BOLD_MARK + trail;
      } else {
        out += run;
      }
    }
    return out;
  }

  // Сырой текст карточки (с маркерами жирного). Хранится в data-raw у
  // элемента текста; textContent — это уже видимый текст без маркеров.
  function getCardRawText(textEl) {
    return textEl.dataset.raw !== undefined ? textEl.dataset.raw : textEl.textContent;
  }

  function isBoldElement(node) {
    if (node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'B' || tag === 'STRONG') return true;
    const weight = node.style && node.style.fontWeight;
    if (!weight) return false;
    if (weight === 'bold' || weight === 'bolder') return true;
    const num = parseInt(weight, 10);
    return !isNaN(num) && num >= 600;
  }

  function isNotBoldElement(node) {
    if (node.nodeType !== 1 || !node.style) return false;
    const weight = node.style.fontWeight;
    if (weight === 'normal' || weight === 'lighter') return true;
    const num = parseInt(weight, 10);
    return !isNaN(num) && num < 600;
  }

  const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);

  // Переводит содержимое редактора (DOM) в сырой текст с маркерами **…**.
  // options.plain — без маркеров (нужно, чтобы узнать текст строки до курсора);
  // options.keepTrailingBreak — не отбрасывать последний <br> (служебный <br>
  // в конце поля браузер добавляет, чтобы была видна пустая последняя строка).
  function editorNodesToRaw(root, options) {
    const opts = options || {};
    // Обычная структура редактора: каждая строка — отдельный <div>
    // (в том числе пустая строка — <div><br></div>). Тогда текст — это
    // строки-<div>, соединённые переводом строки.
    const kids = Array.from(root.childNodes);
    if (kids.length > 0 && kids.every(n => n.nodeName === 'DIV')) {
      return kids.map((div, i) => editorNodesToRaw(div, {
        plain: opts.plain,
        keepTrailingBreak: opts.keepTrailingBreak && i === kids.length - 1
      })).join('\n');
    }
    const chars = [];
    const push = (ch, bold) => chars.push({ ch, bold });
    const lastIsNewline = () => chars.length === 0 || chars[chars.length - 1].ch === '\n';

    function walk(node, bold) {
      if (node.nodeType === 3) {
        for (const ch of node.nodeValue) {
          if (ch === '\r') continue;
          push(ch === ' ' ? ' ' : ch, bold);
        }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeName === 'BR') {
        // <br> — последний в блоке служебный: он лишь «держит» пустую строку
        const parent = node.parentNode;
        const isLastInBlock = parent && parent !== root && BLOCK_TAGS.has(parent.nodeName) && node === parent.lastChild;
        if (isLastInBlock && !lastIsNewline()) return;
        if (isLastInBlock && lastIsNewline() && parent.childNodes.length > 1) return;
        if (!isLastInBlock) push('\n', bold);
        return;
      }
      let childBold = bold;
      if (isBoldElement(node)) childBold = true;
      else if (isNotBoldElement(node)) childBold = false;
      const isBlock = BLOCK_TAGS.has(node.nodeName) && node !== root;
      if (isBlock && !lastIsNewline()) push('\n', false);
      node.childNodes.forEach(child => walk(child, childBold));
    }

    walk(root, false);
    // служебный <br> в самом конце поля
    if (!opts.keepTrailingBreak && chars.length && chars[chars.length - 1].ch === '\n') {
      const lastNode = root.lastChild;
      if (lastNode && lastNode.nodeName === 'BR') chars.pop();
    }

    if (opts.plain) return chars.map(c => c.ch).join('');
    const lines = [[]];
    chars.forEach(c => {
      if (c.ch === '\n') lines.push([]);
      else lines[lines.length - 1].push(c);
    });
    return lines.map(charsToRawLine).join('\n');
  }

  // Заполняет редактор содержимым сырого текста (жирное — в <b>)
  // --- Отступ строки и перенос длинных строк ---
  // Каждая строка текста — отдельный блок. Если строка начинается с отступа
  // (табы/пробелы), то при переносе длинной строки продолжение тоже идёт с
  // этим отступом («висячий» отступ): блоку задаётся padding-left на ширину
  // отступа и такой же отрицательный text-indent для первой строки.
  // Ширина считается в пробелах (таб = 4 пробела, как tab-size), ширина
  // пробела шрифта — в CSS-переменной --space-w (измеряется ниже).
  const TAB_SPACES = 4;

  function indentOf(plainLine) {
    return plainLine.match(/^[\t ]*/)[0];
  }

  function indentUnits(indent) {
    let units = 0;
    for (const ch of indent) units += ch === '\t' ? TAB_SPACES : 1;
    return units;
  }

  function setLineIndent(lineEl, indent) {
    const units = indentUnits(indent);
    if (units) lineEl.style.setProperty('--indent', units);
    else lineEl.style.removeProperty('--indent');
  }

  // Ширина пробела текущего шрифта карточек (Nunito) — для точного отступа
  function measureSpaceWidth() {
    const probe = document.createElement('span');
    probe.className = 'card-text';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
    probe.textContent = ' '.repeat(40);
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 40;
    probe.remove();
    if (width > 0) document.documentElement.style.setProperty('--space-w', width + 'px');
  }
  measureSpaceWidth();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureSpaceWidth);

  // Видимый текст одной строки (без маркеров жирного)
  function plainLine(rawLine) {
    return richLineSegments(rawLine).map(s => s.text).join('');
  }

  // Заполняет редактор содержимым сырого текста: каждая строка — <div>,
  // жирное — в <b>, пустая строка — <div><br></div>
  function fillEditorFromRaw(editor, raw) {
    editor.innerHTML = '';
    raw.split('\n').forEach(line => {
      const lineEl = document.createElement('div');
      richLineSegments(line).forEach(seg => {
        const node = document.createTextNode(seg.text);
        if (seg.bold) {
          const b = document.createElement('b');
          b.appendChild(node);
          lineEl.appendChild(b);
        } else {
          lineEl.appendChild(node);
        }
      });
      if (!lineEl.firstChild) lineEl.appendChild(document.createElement('br'));
      setLineIndent(lineEl, indentOf(plainLine(line)));
      editor.appendChild(lineEl);
    });
  }

  // Ставит курсор в конец текста. Курсор кладём внутрь последнего текстового
  // узла (а не на границу элемента): Safari в позиции «после <b>/в конце <div>»
  // иногда не рисует курсор.
  function placeCaretAtEnd(editor) {
    const range = document.createRange();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let lastText = null;
    let node;
    while ((node = walker.nextNode())) lastText = node;
    const lastLine = editor.lastElementChild;
    const lastLineEmpty = lastLine && lastLine.nodeName === 'DIV' &&
      lastLine.childNodes.length === 1 && lastLine.firstChild.nodeName === 'BR';
    if (lastLineEmpty) {
      range.setStart(lastLine, 0);
    } else if (lastText) {
      range.setStart(lastText, lastText.nodeValue.length);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Символ чекбокса в тексте карточки отображается крупнее обычного текста
  // и кликабелен — переключает состояние on/off (меняет сам символ ☐ ↔ ☑).
  // Хранится как обычный символ внутри текста карточки (сохраняется в конфиг
  // вместе с остальным текстом), поэтому его так же можно удалить/
  // скопировать/вставить как букву.
  //
  // Каждая строка оборачивается в span.card-line (первая — .card-line-title,
  // отмеченный пункт чек-листа — .card-line-done), жирные фрагменты — в
  // strong.card-bold. Сырой текст с маркерами хранится в container.dataset.raw
  // (на нём держатся редактирование и сохранение).
  function renderCardText(container, raw) {
    container.innerHTML = '';
    container.dataset.raw = raw;
    let checkboxIndex = 0;

    raw.split('\n').forEach((line, lineIndex) => {
      const segments = richLineSegments(line);
      const visible = segments.map(s => s.text).join('');
      // первый значимый символ строки (отступ табами/пробелами не считается)
      const firstChar = Array.from(visible.trimStart())[0] || '';

      const lineEl = document.createElement('span');
      let cls = 'card-line';
      if (firstChar === CHECKBOX_ON) cls += ' card-line-done';
      else if (lineIndex === 0 && firstChar !== CHECKBOX_OFF) cls += ' card-line-title';
      lineEl.className = cls;
      container.appendChild(lineEl);
      setLineIndent(lineEl, indentOf(visible));

      // Отступ в начале строки (табы/пробелы) выводим отдельно от содержимого:
      // у выполненного пункта зачёркивается только содержимое, а не отступ.
      const indent = visible.match(/^[\t ]*/)[0];
      if (indent) {
        lineEl.appendChild(document.createTextNode(indent));
        let rest = indent.length;
        while (rest > 0 && segments.length) {
          const take = Math.min(rest, segments[0].text.length);
          segments[0] = { text: segments[0].text.slice(take), bold: segments[0].bold };
          rest -= take;
          if (!segments[0].text) segments.shift();
        }
      }
      const bodyEl = document.createElement('span');
      bodyEl.className = 'card-line-body';
      lineEl.appendChild(bodyEl);

      segments.forEach(seg => {
        let target = bodyEl;
        if (seg.bold) {
          target = document.createElement('strong');
          target.className = 'card-bold';
          bodyEl.appendChild(target);
        }
        let buffer = '';
        const flush = () => {
          if (buffer) {
            target.appendChild(document.createTextNode(buffer));
            buffer = '';
          }
        };
        Array.from(seg.text).forEach(ch => {
          if (ch !== CHECKBOX_OFF && ch !== CHECKBOX_ON) {
            buffer += ch;
            return;
          }
          flush();
          const myIndex = checkboxIndex++;
          const cb = document.createElement('span');
          cb.className = 'card-checkbox-char' + (ch === CHECKBOX_ON ? ' checked' : '');
          cb.textContent = ch;
          cb.title = 'Нажмите, чтобы отметить';
          cb.addEventListener('click', (e) => {
            e.stopPropagation();
            // переключаем N-й по счёту чекбокс в сыром тексте
            const chars = Array.from(container.dataset.raw);
            let seen = 0;
            for (let i = 0; i < chars.length; i++) {
              if (chars[i] === CHECKBOX_OFF || chars[i] === CHECKBOX_ON) {
                if (seen === myIndex) {
                  chars[i] = chars[i] === CHECKBOX_OFF ? CHECKBOX_ON : CHECKBOX_OFF;
                  break;
                }
                seen++;
              }
            }
            renderCardText(container, chars.join(''));
            saveBoard();
          });
          target.appendChild(cb);
        });
        flush();
      });
    });
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
    // столбики уровня: сколько закрашено — задаёт класс приоритета карточки (style.css)
    const badgeBars = document.createElement('span');
    badgeBars.className = 'card-priority-bars';
    badgeBars.setAttribute('aria-hidden', 'true');
    badgeBars.innerHTML = '<i></i><i></i><i></i>';
    const badgeLabel = document.createElement('span');
    badgeLabel.textContent = info.label;
    badge.appendChild(badgeBars);
    badge.appendChild(badgeLabel);
    badge.insertAdjacentHTML('beforeend', ICONS.chevronDown);

    const textEl = document.createElement('div');
    textEl.className = 'card-text';
    // ссылка на элемент текста: пока открыт редактор, его нет в DOM карточки,
    // но сохранение доски должно брать последний сохранённый текст из него
    el.cardTextEl = textEl;
    renderCardText(textEl, text);
    textEl.title = 'Двойной клик — редактировать';

    // Двойной клик по тексту браузер по умолчанию превращает в выделение слова
    // (синяя подсветка успевала мелькнуть перед открытием редактора, особенно
    // в Safari). Отменяем выделение на втором нажатии — редактор при этом
    // открывается как обычно.
    textEl.addEventListener('mousedown', (e) => {
      if (e.detail >= 2) e.preventDefault();
    });

    // --- Редактирование текста карточки по двойному клику ---
    // Редактор — поле с форматированием (contenteditable): в нём сразу видно
    // жирный текст. При сохранении содержимое переводится обратно в «сырой»
    // текст карточки, где жирное выделено маркерами **…** (см. richLineSegments).
    // Открыть редактор можно двойным кликом по тексту или кнопкой-карандашом
    textEl.addEventListener('dblclick', () => openEditor());

    // Закрывает открытый редактор этой карточки (null — редактор закрыт)
    let closeOpenEditor = null;

    function openEditor() {
      if (closeOpenEditor) return; // редактор уже открыт
      // на всякий случай снимаем выделение, если браузер всё же его поставил
      const selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();

      const originalText = getCardRawText(textEl);

      const editArea = document.createElement('div');
      editArea.className = 'card-text-edit';
      editArea.contentEditable = 'true';
      editArea.draggable = false;
      editArea.spellcheck = true;
      editArea.setAttribute('role', 'textbox');
      editArea.setAttribute('aria-multiline', 'true');
      fillEditorFromRaw(editArea, originalText);

      // Панель редактора под полем ввода — видна только во время редактирования:
      // «Жирный», «Список», «Чекбокс».
      const editWrap = document.createElement('div');
      editWrap.className = 'card-edit-wrap';
      const toolbar = document.createElement('div');
      toolbar.className = 'card-edit-toolbar';

      function makeTool(html, label, onClick, extraClass) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'card-edit-tool' + (extraClass ? ' ' + extraClass : '');
        btn.innerHTML = html;
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.tabIndex = -1;
        // mousedown с preventDefault — чтобы поле ввода не теряло фокус
        // (иначе сработал бы blur и редактор закрылся бы)
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (onClick) onClick();
        });
        toolbar.appendChild(btn);
        return btn;
      }

      // «Жирный»: встроенная команда браузера делает ровно то, что нужно:
      //  - без выделения — включает/выключает жирный для вводимых букв;
      //  - выделение целиком жирное — становится обычным, и наоборот;
      //  - в выделении часть жирная, часть нет — всё становится жирным.
      function toggleBold() {
        editArea.focus();
        try { document.execCommand('styleWithCSS', false, false); } catch (err) { /* не критично */ }
        document.execCommand('bold');
        updateBoldState();
      }
      const boldBtn = makeTool('<span aria-hidden="true">Ж</span>', 'Жирный (Cmd+B / Ctrl+B)', toggleBold, 'card-edit-tool-bold');
      boldBtn.setAttribute('aria-pressed', 'false');
      makeTool(ICONS.list, 'Список', () => insertMarkerAtCursor(LIST_BULLET));
      makeTool(ICONS.checkbox, 'Добавить чекбокс', () => insertMarkerAtCursor(CHECKBOX_OFF));
      editWrap.appendChild(editArea);
      editWrap.appendChild(toolbar);

      // Пока открыт редактор, перетаскивание выключено у всех элементов над ним
      // (карточка и столбец). Иначе Safari по зажатой кнопке мыши начинает
      // тащить ближайший перетаскиваемый элемент вместо выделения текста.
      const dragLocked = [];
      for (let node = el; node; node = node.parentElement) {
        if (node.draggable) {
          node.draggable = false;
          dragLocked.push(node);
        }
      }
      textEl.replaceWith(editWrap);
      editArea.focus();
      placeCaretAtEnd(editArea);
      closeOpenEditor = (save) => finishEdit(save);
      editBtn.classList.add('active');

      // Подсветка кнопки «B», когда в месте курсора включён жирный шрифт
      function updateBoldState() {
        let on = false;
        try { on = document.queryCommandState('bold'); } catch (err) { on = false; }
        boldBtn.classList.toggle('active', on);
        boldBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      function onSelectionChange() {
        if (document.activeElement === editArea) updateBoldState();
      }
      document.addEventListener('selectionchange', onSelectionChange);
      editArea.addEventListener('keyup', updateBoldState);
      editArea.addEventListener('mouseup', updateBoldState);
      updateBoldState();

      // Текст текущей строки от её начала до курсора (без форматирования)
      function lineBeforeCaret() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return '';
        const range = sel.getRangeAt(0).cloneRange();
        range.setStart(editArea, 0);
        const before = editorNodesToRaw(range.cloneContents(), { plain: true, keepTrailingBreak: true });
        return before.slice(before.lastIndexOf('\n') + 1);
      }

      // Текст текущей строки от курсора до её конца (без форматирования)
      function lineAfterCaret() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return '';
        const range = sel.getRangeAt(0).cloneRange();
        range.setEnd(editArea, editArea.childNodes.length);
        const after = editorNodesToRaw(range.cloneContents(), { plain: true });
        const lineEnd = after.indexOf('\n');
        return lineEnd === -1 ? after : after.slice(0, lineEnd);
      }

      // Чекбокс и точка списка — обычные символы текста: их можно удалить/
      // скопировать/вставить как буквы; сохраняются на сервере как часть текста.
      // Маркер ставится в начало текущей строки (после отступа), где бы ни стоял
      // курсор; курсор остаётся на своём месте в тексте (а если был в начале
      // строки — встаёт сразу после маркера). Если в строке уже есть такой же
      // маркер — второй не добавляется; если другой — он заменяется.
      // Ставит/заменяет маркер в начале одной строки сырого текста (после
      // отступа). Такой же маркер повторно не ставится, другой — заменяется.
      // Если строка начинается с жирного (**), маркер ставится перед **.
      function applyMarkerToRawLine(rawLine, marker) {
        const m = rawLine.match(/^([\t ]*)((?:\*\*)?)/);
        const indent = m[1];
        const boldPrefix = m[2];
        let rest = rawLine.slice(indent.length + boldPrefix.length);
        let existing = '';
        if (rest.startsWith(CHECKBOX_OFF) || rest.startsWith(CHECKBOX_ON)) existing = rest[0];
        else if (rest.startsWith(LIST_BULLET)) existing = LIST_BULLET;
        else if (rest.startsWith(LIST_BULLET.trim())) existing = LIST_BULLET.trim();
        const isCheckbox = (x) => x === CHECKBOX_OFF || x === CHECKBOX_ON;
        if (existing && isCheckbox(existing) === isCheckbox(marker)) return rawLine;
        rest = rest.slice(existing.length);
        // «****» после удаления маркера из начала жирного куска не оставляем
        const bold = boldPrefix && rest.startsWith(BOLD_MARK) ? rest.slice(BOLD_MARK.length) : boldPrefix + rest;
        return indent + marker + bold;
      }

      // Выделяет в редакторе текст по позициям в «плоском» тексте (без маркеров **)
      function selectPlainRange(startOffset, endOffset) {
        // редактор после fillEditorFromRaw: строки — <div>, между ними «\n»
        const lines = Array.from(editArea.children);
        const locate = (offset) => {
          let lineStart = 0;
          for (let i = 0; i < lines.length; i++) {
            const lineEl = lines[i];
            const len = (lineEl.textContent || '').length;
            if (offset <= lineStart + len || i === lines.length - 1) {
              let rest = Math.min(offset - lineStart, len);
              const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                if (rest <= node.nodeValue.length) return [node, rest];
                rest -= node.nodeValue.length;
              }
              return [lineEl, 0];
            }
            lineStart += len + 1;
          }
          return [editArea, editArea.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...locate(startOffset));
        range.setEnd(...locate(endOffset));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // Маркер для выделенного текста: в начало каждой строки, которую задевает
      // выделение (пустые строки пропускаются), отступы сохраняются.
      function applyMarkerToSelectedLines(marker) {
        const sel = window.getSelection();
        const range = sel.getRangeAt(0);
        const plainUpTo = (container, offset) => {
          const r = document.createRange();
          r.setStart(editArea, 0);
          r.setEnd(container, offset);
          return editorNodesToRaw(r.cloneContents(), { plain: true, keepTrailingBreak: true });
        };
        const beforeStart = plainUpTo(range.startContainer, range.startOffset);
        const beforeEnd = plainUpTo(range.endContainer, range.endOffset);
        let startLine = beforeStart.split('\n').length - 1;
        let endLine = beforeEnd.split('\n').length - 1;
        // выделение закончилось в самом начале следующей строки — её не трогаем
        if (endLine > startLine && beforeEnd.endsWith('\n')) endLine--;
        // выделение началось в самом конце строки (захвачен только перевод
        // строки) — эту строку тоже не трогаем
        if (endLine > startLine && beforeEnd.slice(beforeStart.length).startsWith('\n')) startLine++;

        const rawLines = editorNodesToRaw(editArea).split('\n');
        for (let i = startLine; i <= endLine && i < rawLines.length; i++) {
          const plain = richLineSegments(rawLines[i]).map(x => x.text).join('');
          if (!plain.trim()) continue;
          rawLines[i] = applyMarkerToRawLine(rawLines[i], marker);
        }
        fillEditorFromRaw(editArea, rawLines.join('\n'));

        // выделяем обработанные строки целиком
        const plainLines = rawLines.map(l => richLineSegments(l).map(x => x.text).join(''));
        let start = 0;
        for (let i = 0; i < startLine; i++) start += plainLines[i].length + 1;
        let end = start;
        for (let i = startLine; i <= endLine && i < plainLines.length; i++) {
          end += plainLines[i].length + (i < endLine ? 1 : 0);
        }
        selectPlainRange(start, end);
        updateBoldState();
      }

      function insertMarkerAtCursor(marker) {
        editArea.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        if (!sel.isCollapsed) {
          applyMarkerToSelectedLines(marker);
          return;
        }
        const before = lineBeforeCaret();
        const line = before + lineAfterCaret();
        const indent = line.match(/^[\t ]*/)[0];
        const rest = line.slice(indent.length);

        // маркер, который уже стоит в начале строки
        let existing = '';
        if (rest.startsWith(CHECKBOX_OFF) || rest.startsWith(CHECKBOX_ON)) existing = rest[0];
        else if (rest.startsWith(LIST_BULLET)) existing = LIST_BULLET;
        else if (rest.startsWith(LIST_BULLET.trim())) existing = LIST_BULLET.trim();
        const isCheckbox = (m) => m === CHECKBOX_OFF || m === CHECKBOX_ON;
        const sameKind = existing && (isCheckbox(existing) === isCheckbox(marker));
        if (sameKind) {
          updateBoldState();
          return;
        }

        const moveCaret = (count) => {
          const dir = count > 0 ? 'forward' : 'backward';
          for (let i = 0; i < Math.abs(count); i++) sel.modify('move', dir, 'character');
        };
        // переходим в начало строки, за отступ
        moveCaret(-before.length + indent.length);
        if (existing) {
          for (let i = 0; i < existing.length; i++) sel.modify('extend', 'forward', 'character');
          document.execCommand('delete');
        }
        document.execCommand('insertText', false, marker);

        // возвращаем курсор на прежнее место в тексте строки
        const oldTextPos = before.length - indent.length - existing.length; // позиция курсора в тексте после маркера
        if (oldTextPos > 0) moveCaret(oldTextPos);
        updateBoldState();
      }

      let finished = false;
      function finishEdit(save) {
        if (finished) return;
        finished = true;
        closeOpenEditor = null;
        editBtn.classList.remove('active');
        document.removeEventListener('selectionchange', onSelectionChange);
        if (save) {
          const newText = editorNodesToRaw(editArea).replace(/^\n+|\n+$/g, '');
          renderCardText(textEl, newText.trim() ? newText : originalText);
        }
        editWrap.replaceWith(textEl);
        dragLocked.forEach(node => { node.draggable = true; });
        if (save && getCardRawText(textEl) !== originalText) {
          saveBoard();
        }
      }

      editArea.addEventListener('keydown', (e) => {
        // Cmd+B / Ctrl+B — то же, что кнопка «Ж». Клавиша определяется по
        // физической позиции (KeyB), поэтому работает и в русской раскладке.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
            (e.code === 'KeyB' || e.key === 'b' || e.key === 'B' || e.key === 'и' || e.key === 'И')) {
          e.preventDefault();
          toggleBold();
          return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finishEdit(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finishEdit(false);
        } else if (e.key === 'Enter' && !e.isComposing) {
          // перевод строки вставляем сами (браузеры по-разному оформляют Enter
          // в поле с форматированием); если строка — пункт чек-листа или списка,
          // новая строка начинается с того же маркера
          e.preventDefault();
          const currentLine = lineBeforeCaret();
          let marker = '';
          if (currentLine.includes(CHECKBOX_OFF) || currentLine.includes(CHECKBOX_ON)) {
            marker = CHECKBOX_OFF;
          } else if (currentLine.trimStart().startsWith(LIST_BULLET.trim())) {
            marker = LIST_BULLET;
          }
          // Пустой пункт (в строке только маркер и отступ, без текста):
          // Enter не создаёт новую строку, а стирает маркер (вместе с отступом) —
          // курсор остаётся на этой же, теперь пустой строке.
          const afterCaret = lineAfterCaret();
          const wholeLine = currentLine + afterCaret;
          const hasMarker = wholeLine.includes(CHECKBOX_OFF) || wholeLine.includes(CHECKBOX_ON) ||
            wholeLine.trimStart().startsWith(LIST_BULLET.trim());
          const itemText = wholeLine
            .split(CHECKBOX_OFF).join('')
            .split(CHECKBOX_ON).join('')
            .replace(LIST_BULLET.trim(), '')
            .trim();
          if (hasMarker && !itemText) {
            const sel = window.getSelection();
            sel.collapseToEnd();
            for (let i = 0; i < afterCaret.length; i++) sel.modify('move', 'forward', 'character');
            for (let i = 0; i < wholeLine.length; i++) sel.modify('extend', 'backward', 'character');
            if (!sel.isCollapsed) document.execCommand('delete');
            return;
          }
          // новая строка получает тот же отступ (табы/пробелы), что и текущая —
          // и для обычного текста, и для пунктов списка/чек-листа
          const indent = currentLine.match(/^[\t ]*/)[0];
          // новая строка наследует режим «жирный» (браузер его сбрасывает)
          let wasBold = false;
          try { wasBold = document.queryCommandState('bold'); } catch (err) { wasBold = false; }
          document.execCommand('insertParagraph');
          let nowBold = wasBold;
          try { nowBold = document.queryCommandState('bold'); } catch (err) { nowBold = wasBold; }
          if (nowBold !== wasBold) document.execCommand('bold');
          if (indent || marker) {
            document.execCommand('insertText', false, indent + marker);
          }
        } else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Tab сдвигает всю текущую строку вправо: табуляция добавляется в начало
          // строки, где бы ни стоял курсор (фокус на кнопки при этом не уходит).
          // Shift+Tab убирает один отступ в начале строки (табуляцию или до
          // 4 пробелов). Курсор остаётся на том же месте в тексте строки.
          // При выделении сдвигается строка, где начинается выделение.
          e.preventDefault();
          const sel = window.getSelection();
          if (!sel.rangeCount) return;
          sel.collapseToStart();
          const before = lineBeforeCaret();
          const moveCaret = (count) => {
            const dir = count > 0 ? 'forward' : 'backward';
            for (let i = 0; i < Math.abs(count); i++) sel.modify('move', dir, 'character');
          };
          if (!e.shiftKey) {
            moveCaret(-before.length);
            document.execCommand('insertText', false, '\t');
            moveCaret(before.length);
          } else {
            const line = before + lineAfterCaret();
            let remove = 0;
            if (line.startsWith('\t')) remove = 1;
            else remove = Math.min(4, line.match(/^ */)[0].length);
            if (remove) {
              moveCaret(-before.length);
              for (let i = 0; i < remove; i++) sel.modify('extend', 'forward', 'character');
              document.execCommand('delete');
              moveCaret(Math.max(0, before.length - remove));
            }
          }
        }
      });

      // После любого изменения: у каждой строки-<div> обновляем отступ переноса.
      // Если браузер нарушил структуру «одна строка = один <div>» (вставка,
      // слияние строк и т.п.) — пересобираем содержимое, сохраняя курсор.
      function normalizeEditor() {
        const children = Array.from(editArea.childNodes);
        const regular = children.length > 0 && children.every(n =>
          n.nodeName === 'DIV' &&
          !Array.from(n.querySelectorAll('br, div, p')).some(x =>
            !(x.nodeName === 'BR' && n.childNodes.length === 1 && n.firstChild === x)));
        if (!regular) {
          const sel = window.getSelection();
          let start = 0;
          let end = 0;
          if (sel.rangeCount && editArea.contains(sel.anchorNode)) {
            const range = sel.getRangeAt(0);
            const upTo = (container, offset) => {
              const r = document.createRange();
              r.setStart(editArea, 0);
              r.setEnd(container, offset);
              return editorNodesToRaw(r.cloneContents(), { plain: true, keepTrailingBreak: true }).length;
            };
            start = upTo(range.startContainer, range.startOffset);
            end = upTo(range.endContainer, range.endOffset);
          }
          fillEditorFromRaw(editArea, editorNodesToRaw(editArea));
          selectPlainRange(start, end);
          return;
        }
        children.forEach(lineEl => {
          setLineIndent(lineEl, indentOf(editorNodesToRaw(lineEl, { plain: true })));
        });
      }
      editArea.addEventListener('input', normalizeEditor);

      // вставка из буфера — только как простой текст (без чужого оформления)
      editArea.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (text) document.execCommand('insertText', false, text.replace(/\r\n?/g, '\n'));
      });

      editArea.addEventListener('blur', () => finishEdit(true));
    }

    // --- Кнопка «Редактировать» (карандаш): открывает редактор текста,
    // повторный клик — сохраняет и закрывает его (как Ctrl+Enter)
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'card-menu-btn card-edit-btn';
    editBtn.innerHTML = ICONS.pencil;
    editBtn.title = 'Редактировать текст';
    editBtn.setAttribute('aria-label', 'Редактировать текст');
    // не даём полю редактора потерять фокус раньше клика по кнопке
    editBtn.addEventListener('mousedown', (e) => e.preventDefault());
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      if (closeOpenEditor) closeOpenEditor(true);
      else openEditor();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'card-delete';
    delBtn.innerHTML = ICONS.close;
    delBtn.title = 'Удалить карточку';
    delBtn.setAttribute('aria-label', 'Удалить карточку');
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
      // в окне показываем первую строку карточки (без символов чекбоксов),
      // чтобы было понятно, какая карточка удаляется
      const firstLine = (getCardRawText(textEl).split('\n').map(plainLine).find(l => l.trim()) || '')
        .replace(/[☐☑]/g, '').trim();
      const shortTitle = firstLine.length > 60 ? firstLine.slice(0, 57).trimEnd() + '…' : firstLine;
      const ok = await showConfirmDialog({
        title: 'Удалить карточку?',
        message: shortTitle ? '«' + shortTitle + '» будет удалена.' : 'Карточка будет удалена.',
        confirmLabel: 'Удалить'
      });
      if (!ok) return;
      const col = el.closest('.column');
      el.remove();
      if (col) updateColumnCount(col);
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
        swatch.style.background = getPaletteEntry(def.color).bg;

        const tLabel = document.createElement('span');
        tLabel.className = 'card-menu-item-label';
        if (def.label) {
          tLabel.textContent = def.label;
        } else {
          tLabel.textContent = 'без названия';
          tLabel.classList.add('card-menu-item-label-empty');
        }

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
        const tagName = def.label ? '«' + def.label + '»' : 'без названия';
        deleteTagBtn.setAttribute('aria-label', 'Удалить тег ' + tagName + ' из списка');
        deleteTagBtn.title = 'Удалить тег из списка (снимется со всех карточек)';
        deleteTagBtn.onclick = (e) => {
          e.stopPropagation();
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
        renderMenuColorPicker();
      };
      menu.appendChild(newTagBtn);
    }

    // Создание нового тега: поле для названия + выбор цвета.
    // Тег создаётся кликом по цвету; пустое название — тег без текста.
    function renderMenuColorPicker() {
      menu.innerHTML = '';

      const heading = document.createElement('div');
      heading.className = 'card-menu-color-heading';
      heading.textContent = 'Новый тег';
      menu.appendChild(heading);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'card-menu-tag-name-input';
      nameInput.placeholder = 'Название';
      nameInput.maxLength = TAG_LABEL_MAX;
      nameInput.setAttribute('aria-label', 'Название нового тега');
      nameInput.addEventListener('click', (e) => e.stopPropagation());
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          renderMenuTag();
        } else if (e.key === 'Enter') {
          e.preventDefault(); // тег создаётся выбором цвета
        }
      });
      menu.appendChild(nameInput);

      const colorHeading = document.createElement('div');
      colorHeading.className = 'card-menu-color-heading';
      colorHeading.textContent = 'Цвет';
      menu.appendChild(colorHeading);

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
          createTagDefinition(nameInput.value.trim(), p.key);
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

      nameInput.focus();
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

    // Кнопки справа в шапке карточки: редактировать, теги, удалить
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(editBtn);
    actions.appendChild(menuWrapper);
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
        pSwatch.className = 'card-menu-priority-swatch';
        // цвет рамки — из --prio-<приоритет> текущей темы
        pSwatch.style.setProperty('--prio', 'var(--prio-' + key + ')');
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

    head.appendChild(labels);
    head.appendChild(actions);
    el.appendChild(head);

    el.appendChild(textEl);
    // теги — отдельной строкой под текстом карточки
    el.appendChild(tagsContainer);

    el.dataset.tags = (initialTags || []).join(',');
    refreshCardTags(el);

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
      // (и не тащим столбец, пока в нём открыт редактор карточки)
      if (e.target.closest('.card') || e.target.closest('.column-title-input') ||
          e.target.closest('.column-delete') || e.target.closest('.add-form') ||
          columnEl.querySelector('.card-edit-wrap')) {
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
    deleteBtn.onclick = async () => {
      const cardsCount = columnEl.querySelectorAll('.card').length;
      if (cardsCount > 0) {
        const name = titleInput.value.trim() || 'Без названия';
        const ok = await showConfirmDialog({
          title: 'Удалить столбец «' + name + '»?',
          message: 'В столбце ' + cardsCount + ' ' + wordForCards(cardsCount) +
            '. Они будут удалены вместе со столбцом.',
          confirmLabel: 'Удалить'
        });
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
    form.appendChild(row);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = textarea.value.trim();
      if (!value) return;
      // новая карточка всегда создаётся со средним приоритетом —
      // сменить его можно кликом по плашке приоритета на карточке
      cardsContainer.appendChild(createCardElement(value, DEFAULT_PRIORITY));
      textarea.value = '';
      textarea.style.height = 'auto';
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
  // Новый столбец создаётся сразу, без диалога. Название выделяется,
  // чтобы его можно было тут же перепечатать (сохранится по Enter или уходу из поля).
  addColumnBtn.onclick = () => {
    const columnEl = createColumn('Новый столбец', []);
    board.insertBefore(columnEl, addColumnBtn);
    saveBoard();
    columnEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    const titleInput = columnEl.querySelector('.column-title-input');
    titleInput.focus({ preventScroll: true });
    titleInput.select();
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
        const text = getCardRawText(cardEl.cardTextEl || cardEl.querySelector('.card-text'));
        const priority = cardEl.dataset.priority || DEFAULT_PRIORITY;
        const tags = (cardEl.dataset.tags || '').split(',').filter(Boolean);
        cards.push({ text, priority, tags });
      });
      columns.push({ title, cards });
    });
    const background = window.KanbanBoardBg ? window.KanbanBoardBg.get() : '';
    return { title: boardTitleInput.value, background, columns, tagDefs: tagRegistry };
  }

  // Точка в заголовке столбца окрашивается по его позиции на доске — так её цвет
  // совпадает с отрезком полоски на плитке доски (start.js) и после
  // перетаскивания, добавления или удаления столбцов.
  function recolorColumnDots() {
    board.querySelectorAll(':scope > .column').forEach((columnEl, i) => {
      const dot = columnEl.querySelector('.column-title .dot');
      if (dot) dot.style.background = dotColors[i % dotColors.length];
    });
  }

  // Гость: первое изменение доски создаёт аккаунт — сначала обязательное окно
  // «Как вас зовут?» (static/guest.js), затем сохранение. Пока окно открыто,
  // изменения копятся; сохраняется последнее состояние доски.
  let accountReady = !window.KanbanGuest;
  let accountGate = null;

  function saveBoard() {
    recolorColumnDots();
    if (accountReady) {
      sendBoard();
      return;
    }
    if (!accountGate) {
      accountGate = window.KanbanGuest.ensureNamed().then(() => {
        accountReady = true;
        accountGate = null;
        sendBoard();
      });
    }
  }

  function sendBoard() {
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
    recolorColumnDots();
  }

  async function loadBoard() {
    try {
      const res = await fetch(BOARD_API_URL);
      if (res.status === 404) {
        // доску удалили (например, в другой вкладке) — возвращаемся к списку
        window.location.href = '/';
        return;
      }
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
