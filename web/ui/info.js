/*
 * INFO tab renderer: a searchable glossary of collapsible areas instead of a
 * wall of text. The content lives in ui/info-data.js so test/info.test.js can
 * check it without a browser.
 *
 * Interactions:
 *   - search filters by term or by words in the explanation, and opens the
 *     matches automatically
 *   - chips jump to one area
 *   - areas collapse, and inside an area one term opens at a time
 *   - window.INFO.reveal(term, group) opens a specific term; the dashboard
 *     calls it when you tap any field label, so a number and its meaning are
 *     never more than one tap apart.
 */
(function () {
  const GROUPS = Array.isArray(window.INFO_GROUPS) ? window.INFO_GROUPS : [];
  const listEl = document.getElementById('infoList');
  const searchEl = document.getElementById('infoSearch');
  const chipsEl = document.getElementById('infoChips');
  const countEl = document.getElementById('infoCount');
  const introEl = document.getElementById('infoIntro');
  if (!listEl) return;

  if (introEl && window.INFO_INTRO) introEl.innerHTML = window.INFO_INTRO;

  // Visible text of an explanation, for search only. textarea.innerHTML decodes
  // entities and cannot execute anything.
  const scratch = document.createElement('textarea');
  function plain(html) {
    scratch.innerHTML = String(html).replace(/<[^>]*>/g, ' ');
    return scratch.value.replace(/\s+/g, ' ').trim();
  }

  // One flat index so search can span every area.
  const INDEX = [];
  GROUPS.forEach((g, gi) => {
    (g.terms || []).forEach((term, ti) => {
      INDEX.push({
        key: gi + ':' + ti,
        group: g.id,
        groupTitle: g.title,
        term: term.t,
        def: term.d,
        lc: plain(term.t).toLowerCase(),
        text: (plain(term.t) + ' ' + plain(term.d)).toLowerCase()
      });
    });
  });

  const groupById = new Map(GROUPS.map(g => [g.id, g]));

  let filter = 'all';        // 'all' or a group id
  let query = '';            // raw search text
  let openKey = null;        // term currently expanded
  const expanded = new Set(); // areas the reader has opened

  function matches() {
    const q = query.trim().toLowerCase();
    const scoped = INDEX.filter(e => filter === 'all' || e.group === filter);
    if (!q) return scoped;
    // Term matches win: typing "hdop" is asking for the HDOP entry, not every
    // explanation that happens to mention HDOP in passing.
    const byTerm = scoped.filter(e => e.lc.includes(q));
    return byTerm.length ? byTerm : scoped.filter(e => e.text.includes(q));
  }

  function areaOpen(id) {
    if (query.trim()) return true;   // a search should show its hits
    if (filter !== 'all') return filter === id;
    return expanded.has(id);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function chipHtml() {
    const items = [{ id: 'all', short: 'All', title: 'Everything' }]
      .concat(GROUPS.map(g => ({ id: g.id, short: g.short || g.title, title: g.title })));
    return items.map(c =>
      `<button type="button" class="info-chip${c.id === filter ? ' active' : ''}"` +
      ` data-group="${esc(c.id)}" aria-pressed="${c.id === filter}" title="${esc(c.title)}">${esc(c.short)}</button>`
    ).join('');
  }

  function termHtml(e) {
    const open = e.key === openKey;
    return `<div class="info-item${open ? ' open' : ''}" data-key="${e.key}">` +
      `<button type="button" class="info-row" aria-expanded="${open}">` +
      `<span class="info-term">${e.term}</span>` +
      `<span class="info-caret" aria-hidden="true">${open ? '&minus;' : '+'}</span>` +
      `</button>` +
      `<div class="info-def"${open ? '' : ' hidden'}>${e.def}</div>` +
      `</div>`;
  }

  function render() {
    const rows = matches();

    let html = '';
    for (const g of GROUPS) {
      const mine = rows.filter(e => e.group === g.id);
      if (!mine.length) continue;
      const open = areaOpen(g.id);
      html += `<div class="info-group" data-group="${esc(g.id)}">` +
        `<button type="button" class="info-group-head" aria-expanded="${open}">` +
        `<span class="info-group-name">${esc(g.title)}</span>` +
        `<span class="info-group-count">${mine.length}</span>` +
        `<span class="info-caret" aria-hidden="true">${open ? '&minus;' : '+'}</span>` +
        `</button>` +
        `<div class="info-group-body"${open ? '' : ' hidden'}>` +
        mine.map(termHtml).join('') +
        `</div>` +
        `</div>`;
    }

    if (!rows.length) {
      html = `<div class="info-empty">No match for &ldquo;${esc(query.trim())}&rdquo;. ` +
        `Try &ldquo;hdop&rdquo;, &ldquo;gap&rdquo;, &ldquo;heap&rdquo; or clear the search.</div>`;
    }

    listEl.innerHTML = html;
    if (chipsEl) chipsEl.innerHTML = chipHtml();

    if (countEl) {
      countEl.textContent = rows.length === INDEX.length
        ? `${INDEX.length} terms in ${GROUPS.length} areas`
        : `${rows.length} of ${INDEX.length} terms`;
    }
  }

  function setOpen(key) {
    openKey = key;
    render();
    const el = key && listEl.querySelector(`[data-key="${key}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function setFilter(id) {
    filter = id;
    if (id !== 'all') expanded.add(id);
    openKey = null;
    render();
  }

  // Exact, then "starts with", then "contains", each preferring the shortest
  // term so "Tilt" opens "Tilt (MPU)" rather than "Max Tilt".
  function best(list, t) {
    return list.find(e => e.lc === t) ||
      list.find(e => e.lc.indexOf(t) === 0) ||
      list.slice().sort((a, b) => a.lc.length - b.lc.length).find(e => e.lc.includes(t)) ||
      null;
  }

  function pick(term, group) {
    const t = String(term || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return null;
    // Stay inside the panel first: "Tilt" in LIVE is the tilt readout while
    // "Tilt" in MPU is the combined value, and "Status" exists in three tabs.
    return best(group ? INDEX.filter(e => e.group === group) : INDEX, t) || best(INDEX, t);
  }

  listEl.addEventListener('click', (ev) => {
    const head = ev.target.closest('.info-group-head');
    if (head) {
      const group = head.closest('.info-group');
      const id = group && group.dataset.group;
      if (!id) return;
      if (query.trim() || filter !== 'all') {
        // In search or after a chip, collapsing one area would leave an empty
        // screen: clear the restriction instead.
        query = '';
        if (searchEl) searchEl.value = '';
        filter = 'all';
      }
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      openKey = null;
      render();
      return;
    }
    const row = ev.target.closest('.info-row');
    if (!row) return;
    const item = row.closest('.info-item');
    if (!item) return;
    setOpen(item.dataset.key === openKey ? null : item.dataset.key);
  });

  if (chipsEl) {
    chipsEl.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.info-chip');
      if (!chip) return;
      query = '';
      if (searchEl) searchEl.value = '';
      setFilter(chip.dataset.group || 'all');
    });
  }

  if (searchEl) {
    searchEl.addEventListener('input', () => {
      query = searchEl.value || '';
      openKey = null;
      render();
      // One hit means you already know what you asked for: open it.
      const rows = matches();
      if (query.trim() && rows.length === 1) setOpen(rows[0].key);
    });
  }

  window.INFO = {
    reveal(term, group) {
      const hit = pick(term, group);
      if (!hit) return false;
      query = '';
      if (searchEl) searchEl.value = '';
      filter = 'all';
      expanded.add(hit.group);
      setOpen(hit.key);
      return true;
    },
    groupTitle: id => (groupById.get(id) || {}).title || id
  };

  render();
})();
