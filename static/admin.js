// Страница статистики (/admin): загружает цифры из /api/admin/stats и рисует
// их. Графики — обычные блоки и SVG, без библиотек. Всё, что пришло из
// журнала (логины, строки событий), выводится только как текст (textContent).
(function () {
  const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const STATUS = {
    blocked: { label: 'Заблокирован', icon: 'M12 8v5M12 16.5v.5M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z' },
    suspicious: { label: 'Подозрительно', icon: 'M12 8v5M12 16.5v.5M12 21a9 9 0 100-18 9 9 0 000 18z' },
    normal: { label: 'Норма', icon: 'M5 12.5l4.5 4.5L19 7.5' }
  };
  // последовательная шкала (один оттенок): от «почти ноль» к «много»
  const RAMP = {
    dark: ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef'],
    light: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab']
  };
  const DAYS_KEY = 'kanban-admin-days';

  let days = 30;
  try { days = Number(localStorage.getItem(DAYS_KEY)) || 30; } catch (e) { /* без хранилища */ }
  if (![7, 30, 90].includes(days)) days = 30;
  let filter = 'all';
  let data = null;

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgIcon(path) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.appendChild(p);
    return svg;
  }

  function fmt(n) {
    if (n === null || n === undefined) return '—';
    return String(n).replace('.', ',');
  }

  function niceMax(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  function delta(cur, prev, suffix) {
    if (data && !data.prevComplete) return 'журнал короче двух периодов — сравнивать не с чем';
    if (cur === null || cur === undefined || !prev) return 'нет данных за прошлый период';
    const p = Math.round((cur - prev) / prev * 100);
    return (p >= 0 ? '↑ ' : '↓ ') + Math.abs(p) + '% к прошлому периоду' + (suffix || '');
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // --- ключевые цифры ---
  function renderKpis(k) {
    const box = $('kpis');
    box.replaceChildren();
    const items = [
      ['Новые аккаунты', fmt(k.accounts), delta(k.accounts, k.accountsPrev)],
      ['Активные в день', fmt(k.dau), delta(k.dau, k.dauPrev)],
      ['WAU / MAU', k.wau + ' / ' + k.mau, 'уникальных за 7 и 30 дней'],
      ['Гость → аккаунт', k.conversion === null ? '—' : k.conversion + '%', delta(k.conversion, k.conversionPrev)],
      ['Задали пароль', k.passwordPct === null ? '—' : k.passwordPct + '%',
        k.daysToPassword === null ? 'из новых аккаунтов периода' : 'в среднем через ' + fmt(k.daysToPassword) + ' дн.'],
      ['Средний заход', k.visitAvg === null ? '—' : k.visitAvg + ' мин',
        k.visitMedian === null ? 'нет закрытых заходов' : 'медиана ' + fmt(Math.round(k.visitMedian)) + ' мин']
    ];
    for (const [label, value, note] of items) {
      const card = el('div', 'kpi');
      card.append(el('div', 'kpi-label', label), el('div', 'kpi-value', value), el('div', 'kpi-note', note));
      box.appendChild(card);
    }
  }

  // --- столбчатый график: series = [{key, cls, label}] ---
  function barChart(box, rows, series, height, axisLabels) {
    box.replaceChildren();
    const max = niceMax(Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key]))));
    const y = el('div', 'y-axis');
    y.style.height = height + 'px';
    y.append(el('span', '', max), el('span', '', max / 2), el('span', '', 0));
    const wrap = el('div', 'plot-wrap');
    const plot = el('div', 'plot');
    plot.style.height = height + 'px';
    for (const r of rows) {
      const hit = el('div', 'hit');
      hit.tabIndex = 0;
      for (const s of series) {
        const bar = el('div', 'bar ' + s.cls);
        bar.style.height = (r[s.key] / max * 100).toFixed(1) + '%';
        hit.appendChild(bar);
      }
      const tip = el('div', 'tip');
      tip.appendChild(el('b', '', r.label));
      for (const s of series) {
        tip.appendChild(el('br'));
        tip.appendChild(document.createTextNode(s.label + ': ' + r[s.key]));
      }
      hit.appendChild(tip);
      plot.appendChild(hit);
    }
    wrap.appendChild(plot);
    if (axisLabels) {
      const x = el('div', 'x-axis');
      for (const l of axisLabels) x.appendChild(el('span', '', l));
      wrap.appendChild(x);
    }
    box.append(y, wrap);
  }

  function axisFor(rows) {
    if (!rows.length) return [];
    return [rows[0].label, rows[Math.floor(rows.length / 2)].label, rows[rows.length - 1].label];
  }

  // --- линейный график активных ---
  function lineChart(box, rows, height) {
    box.replaceChildren();
    const max = niceMax(Math.max(1, ...rows.map(r => r.active)));
    const y = el('div', 'y-axis');
    y.style.height = height + 'px';
    y.append(el('span', '', max), el('span', '', max / 2), el('span', '', 0));
    const wrap = el('div', 'plot-wrap');
    const plot = el('div', 'plot');
    plot.style.height = height + 'px';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'line-svg');
    svg.setAttribute('viewBox', '0 0 1000 ' + height);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Активные пользователи по дням');
    const n = rows.length;
    const d = rows.map((r, i) => {
      const px = (i + 0.5) / n * 1000;
      const py = height - r.active / max * height;
      return (i ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
    }).join(' ');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    plot.appendChild(svg);
    const hits = el('div', 'hits');
    for (const r of rows) {
      const hit = el('div', 'hit');
      hit.tabIndex = 0;
      hit.appendChild(el('div', 'cross'));
      const tip = el('div', 'tip');
      tip.append(el('b', '', r.label), el('br'), document.createTextNode('Активных: ' + r.active));
      hit.appendChild(tip);
      hits.appendChild(hit);
    }
    plot.appendChild(hits);
    const x = el('div', 'x-axis');
    for (const l of axisFor(rows)) x.appendChild(el('span', '', l));
    wrap.append(plot, x);
    box.append(y, wrap);
  }

  // --- горизонтальные полосы ---
  function hbars(box, rows) {
    box.replaceChildren();
    const max = Math.max(1, ...rows.map(r => r.value));
    for (const r of rows) {
      const row = el('div', 'hbar');
      const head = el('div', 'hbar-head');
      const b = el('b', '', r.valueLabel);
      if (r.extra) b.appendChild(el('span', '', ' · ' + r.extra));
      head.append(el('span', '', r.label), b);
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = (r.value / max * 100).toFixed(1) + '%';
      track.appendChild(fill);
      row.append(head, track);
      box.appendChild(row);
    }
  }

  function compactBars(box, rows) {
    box.replaceChildren();
    if (!rows.length) { box.appendChild(el('div', 'no-data', 'Нет данных за период')); return; }
    const max = Math.max(1, ...rows.map(r => r.count));
    for (const r of rows) {
      const row = el('div', 'hbar');
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      fill.style.width = (r.count / max * 100).toFixed(1) + '%';
      track.appendChild(fill);
      row.append(el('span', '', r.label), track, el('span', 'pct', r.pct + '%'));
      box.appendChild(row);
    }
  }

  function renderFunnel(f) {
    const pct = (v) => f.guests ? Math.round(v / f.guests * 100) + '%' : '—';
    hbars($('funnel'), [
      { label: 'Гости', value: f.guests, valueLabel: f.guests, extra: f.guests ? '100%' : '' },
      { label: 'Начали первое изменение', value: f.prompted, valueLabel: f.prompted, extra: pct(f.prompted) },
      { label: 'Создали аккаунт', value: f.accounts, valueLabel: f.accounts, extra: pct(f.accounts) },
      { label: 'Задали пароль', value: f.password, valueLabel: f.password, extra: pct(f.password) }
    ]);
    const left = Math.max(0, f.prompted - f.accounts);
    $('dropped').textContent = f.prompted ? Math.round(left / f.prompted * 100) + '% (' + left + ')' : '—';
  }

  function renderDurations(rows) {
    const total = rows.reduce((s, r) => s + r.count, 0);
    $('durations-note').textContent = total
      ? 'по событиям visit.end · ' + total + ' ' + plural(total, 'заход', 'захода', 'заходов')
      : 'закрытых заходов за период пока нет';
    hbars($('durations'), rows.map(r => ({
      label: r.label, value: r.count, valueLabel: r.pct === null ? '—' : r.pct + '%'
    })));
  }

  function renderHours(hours) {
    const rows = hours.map((v, i) => ({ label: i + ':00', v }));
    barChart($('chart-hours'), rows, [{ key: 'v', cls: 's1', label: 'Заходов' }], 140,
      ['0:00', '6:00', '12:00', '18:00', '23:00']);
    const max = Math.max(...hours);
    if (!max) { $('peak').textContent = '—'; return; }
    const top = hours.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]).sort((a, b) => a - b);
    $('peak').textContent = top.map(h => h + ':00–' + (h + 1) + ':00').join(' и ');
  }

  function renderCohorts(cohorts) {
    const box = $('cohorts');
    box.replaceChildren();
    const head = el('div', 'cohort-row head');
    head.append(el('span', '', 'Неделя'), el('span', 'num', 'Аккаунтов'),
      el('span', 'cell', 'День 1'), el('span', 'cell', 'День 7'), el('span', 'cell', 'День 30'));
    box.appendChild(head);
    if (!cohorts.length) { box.appendChild(el('div', 'no-data', 'Пока нет аккаунтов, созданных при включённом журнале')); return; }
    const dark = (window.KanbanTheme ? window.KanbanTheme.getTheme() : 'dark') === 'dark';
    const ramp = dark ? RAMP.dark : RAMP.light;
    const labels = ['День 1', 'День 7', 'День 30'];
    for (const c of cohorts) {
      const row = el('div', 'cohort-row');
      row.append(el('span', '', c.week), el('span', 'num', c.accounts));
      c.retention.forEach((v, i) => {
        const cell = el('span', 'cell', v === null ? '—' : v + '%');
        if (v === null) {
          cell.style.color = 'var(--text2)';
          cell.title = 'срок ещё не прошёл';
        } else {
          const idx = Math.min(ramp.length - 1, Math.floor(v / 70 * ramp.length));
          cell.style.background = ramp[idx];
          cell.style.color = dark ? (idx >= 6 ? '#0d1b2e' : '#ffffff') : (idx >= 5 ? '#ffffff' : '#0d1b2e');
          cell.title = labels[i] + ': ' + v + '%';
        }
        row.appendChild(cell);
      });
      box.appendChild(row);
    }
  }

  function renderDevices(d) {
    compactBars($('browsers'), d.browsers);
    compactBars($('systems'), d.systems);
    $('multi').textContent = d.multiDevicePct === null ? '—' : d.multiDevicePct + '%';
    const box = $('sessions');
    box.replaceChildren();
    for (const [label, value] of [['Входов по паролю', d.logins], ['Выходов', d.logouts], ['Вышли после смены пароля', d.passwordChanged]]) {
      const row = el('div');
      row.append(el('span', 'muted', label), el('b', '', value));
      box.appendChild(row);
    }
  }

  function renderSecurity(rows) {
    const box = $('security');
    box.replaceChildren();
    const head = el('div', 'sec-row head');
    head.append(el('span', '', 'Адрес'), el('span', 'r', 'Неудачных входов'), el('span', 'r', 'Новых аккаунтов'),
      el('span', '', 'Логины'), el('span', '', 'Оценка'));
    box.appendChild(head);
    if (!rows.length) { box.appendChild(el('div', 'no-data', 'За сутки ничего подозрительного: неудачных входов и массового создания аккаунтов нет.')); return; }
    for (const r of rows) {
      const row = el('div', 'sec-row');
      const st = STATUS[r.status] || STATUS.normal;
      const badge = el('span', 'status ' + r.status);
      badge.append(svgIcon(st.icon), document.createTextNode(st.label));
      const names = el('span', 'names', r.names.length ? r.names.join(', ') : '—');
      names.title = r.names.join(', ');
      const cell = el('span');
      cell.appendChild(badge);
      row.append(el('span', 'ip', r.ip), el('span', 'r', r.fails), el('span', 'r', r.creates), names, cell);
      box.appendChild(row);
    }
  }

  function renderFeed() {
    const box = $('feed');
    box.replaceChildren();
    const rows = (data ? data.feed : []).filter(e => filter === 'all' || e.group === filter).slice(0, 30);
    if (!rows.length) { box.appendChild(el('div', 'no-data', 'Событий этого типа пока нет')); return; }
    for (const e of rows) {
      const row = el('div', 'feed-row');
      const d = el('span', 'd', e.details);
      d.title = e.details;
      row.append(el('span', 't', e.time), el('span', 'e', e.event), d);
      box.appendChild(row);
    }
    for (const b of $('filters').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', b.dataset.group === filter ? 'true' : 'false');
    }
  }

  function render() {
    if (!data) return;
    const updated = new Date(data.generatedAt);
    const since = data.since ? new Date(data.since + 'T00:00:00') : null;
    $('meta').textContent = (since ? 'Журнал с ' + since.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' : '') +
      'посчитано в ' + updated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    $('empty').hidden = !data.empty;
    $('content').hidden = data.empty;
    if (data.empty) return;
    renderKpis(data.kpis);
    barChart($('chart-daily'), data.daily, [
      { key: 'guests', cls: 's2', label: 'Гости' },
      { key: 'accounts', cls: 's1', label: 'Новые аккаунты' }
    ], 200, axisFor(data.daily));
    lineChart($('chart-active'), data.daily, 180);
    renderFunnel(data.funnel);
    renderDurations(data.durations);
    renderCohorts(data.cohorts);
    renderHours(data.hours);
    renderDevices(data.devices);
    renderSecurity(data.security);
    renderFeed();
  }

  async function load(fresh) {
    for (const b of $('periods').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', Number(b.dataset.days) === days ? 'true' : 'false');
    }
    $('refresh').disabled = true;
    try {
      const res = await fetch('/api/admin/stats?days=' + days + (fresh ? '&fresh=1' : ''));
      if (res.status === 404) { window.location.href = '/'; return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      render();
    } catch (err) {
      $('meta').textContent = 'Не удалось загрузить статистику. Попробуйте обновить.';
      console.error(err);
    } finally {
      $('refresh').disabled = false;
    }
  }

  // --- управление ---
  $('periods').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    days = Number(b.dataset.days);
    try { localStorage.setItem(DAYS_KEY, String(days)); } catch (err) { /* без хранилища */ }
    load(false);
  });
  $('refresh').addEventListener('click', () => load(true));
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-group]');
    if (!b) return;
    filter = b.dataset.group;
    renderFeed();
  });

  const themeBtn = $('theme-toggle');
  function renderThemeBtn() {
    const dark = window.KanbanTheme.getTheme() === 'dark';
    themeBtn.innerHTML = (dark ? SUN : MOON) + '<span></span>';
    themeBtn.querySelector('span').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
  }
  themeBtn.addEventListener('click', () => {
    window.KanbanTheme.toggleTheme();
    renderThemeBtn();
    if (data && !data.empty) renderCohorts(data.cohorts);
  });
  renderThemeBtn();

  load(false);
})();
