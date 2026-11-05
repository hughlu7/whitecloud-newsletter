/**
 * 「六頁編排」分頁＋版型建議規則。
 *
 * 第 1 階段：一個單元一頁，列出每頁目前放了哪些「已採用」素材。
 * 主編可以（按鈕操作，不做拖拉）：
 *   - 把素材移到別的單元頁（改 unit）、移出六頁（改回「已送出」）
 *   - 改單筆素材的版型
 *   - 從下方「待挑選」直接採用
 * 老師看得到六頁內容，但沒有這些按鈕。
 * A4 六頁排版、下載文字稿、列印 PDF 仍在第 3 階段。
 */
WC.layout = (function () {
  const U = WC.util;
  const EXPLORE_RE = /試了|試試|嘗試|發現|改成|調整|再試|失敗|結果/;
  let movingId = '';  // 正在選「移到哪一頁」的紀錄

  /**
   * 單筆紀錄的版型建議（新增視窗用）：
   *   原始紀錄出現「試了／發現／改成」等字眼 → 探索版；照片 2 張以上 → 相簿版；其餘 → 故事版。
   *   探索版優先，因為有思考歷程的紀錄，照片多也適合用探索版呈現。
   */
  function suggestFor(photoCount, rawText) {
    const has = function (l) { return WC.state.config.layouts.indexOf(l) >= 0; };
    if (EXPLORE_RE.test(String(rawText || '')) && has('探索版')) return '探索版';
    if (photoCount >= 2 && has('相簿版')) return '相簿版';
    if (has('故事版')) return '故事版';
    return WC.state.config.layouts[0] || '';
  }

  /** 一頁的版型建議（依已採用素材數與照片數；第 3 階段會再細化並提示拆分） */
  function suggest(items) {
    const n = items.length;
    const ph = items.reduce(function (s, r) { return s + r.photos.length; }, 0);
    if (!n) return { layout: '—', note: '尚無已採用素材' };
    if (n === 1) return { layout: items[0].layout || suggestFor(ph, items[0].rawText), note: '' };
    if (ph > 9) return { layout: '相簿版', note: '照片 ' + ph + ' 張，建議精選 9 張以內' };
    if (n > 3) return { layout: '相簿版', note: '素材 ' + n + ' 筆，建議精簡或拆到下個月' };
    if (items.some(function (r) { return r.layout === '探索版'; })) return { layout: '探索版', note: '依嘗試→發現→調整呈現' };
    return { layout: ph >= 3 ? '相簿版' : '故事版', note: '' };
  }

  function isEditorRole() { return WC.state.me && WC.state.me.role === '主編'; }

  function itemHtml(r, units, canAct) {
    const pending = WC.records.isPending(r.id);
    const busy = r.photosBroken || pending;
    let tools = '';
    if (canAct) {
      const layouts = WC.state.config.layouts;
      tools = '<div class="pi-tools">' +
        '<div class="seg" role="group" aria-label="「' + U.esc(r.title) + '」的版型">' + layouts.map(function (l) {
          const on = r.layout === l;
          return '<button type="button" class="seg-b' + (on ? ' on' : '') + '" data-act="layout" data-v="' + U.esc(l) + '" aria-pressed="' + on + '"' + (busy ? ' disabled' : '') + '>' + U.esc(l.replace('版', '')) + '</button>';
        }).join('') + '</div>' +
        '<button type="button" class="btn-sm" data-act="move" aria-expanded="' + (movingId === r.id) + '"' + (busy ? ' disabled' : '') + '>移到…</button>' +
        '</div>';
      if (movingId === r.id) {
        tools += '<div class="move-menu" role="group" aria-label="移到哪一頁">' + units.map(function (u, i) {
          const here = u === r.unit;
          return '<button type="button" class="btn-sm" data-act="to" data-v="' + U.esc(u) + '"' + (here ? ' disabled aria-current="true"' : busy ? ' disabled' : '') + '>' +
            (i + 1) + '. ' + U.esc(u) + (here ? '（目前）' : '') + '</button>';
        }).join('') +
          '<button type="button" class="btn-sm btn-out" data-act="out"' + (busy ? ' disabled' : '') + '>移出六頁</button>' +
          '<button type="button" class="btn-sm" data-act="move-cancel"' + (pending ? ' disabled' : '') + '>取消</button></div>';
      }
    }
    const photos = r.photos || [];
    return '<li class="pi' + (pending ? ' is-busy' : '') + '" data-id="' + U.esc(r.id) + '"' + (pending ? ' aria-busy="true"' : '') + '>' +
      (pending ? '<span class="pi-busy" role="status">處理中…</span>' : '') +
      '<div class="pi-main">' +
      (photos.length ? '<button type="button" class="thumb-btn pi-thumb" data-act="view" aria-label="放大看「' + U.esc(r.title) + '」的 ' + photos.length + ' 張照片"><img data-photo-id="' + U.esc(photos[0].thumbId) + '" alt=""></button>' : '<span class="pi-thumb pi-nophoto" aria-hidden="true">✎</span>') +
      '<div><b class="pi-title">' + U.esc(r.title) + '</b><small class="muted">' + photos.length + ' 張 · ' + U.esc(r.layout || '未定版型') + ' · ' + U.esc(r.authorName) + '</small></div>' +
      '</div>' + tools + '</li>';
  }

  function render() {
    const cfg = WC.state.config;
    const canAct = isEditorRole();
    const used = WC.state.records.filter(function (r) { return r.status === '已採用'; });
    const total = cfg.units.length;
    if (movingId && !used.some(function (r) { return r.id === movingId; })) movingId = '';
    U.$('#pages-role-note').textContent = canAct ? '在每頁可改版型、把素材移到別頁或移出；下方「待挑選」可直接採用。' : '';
    const rows = cfg.units.map(function (unit, i) {
      const items = used.filter(function (r) { return r.unit === unit; });
      const s = suggest(items);
      const ph = items.reduce(function (n, r) { return n + r.photos.length; }, 0);
      return '<section class="page-mini' + (items.length ? '' : ' is-empty') + '" aria-label="第 ' + (i + 1) + ' 頁 ' + U.esc(unit) + '">' +
        '<div class="page-mini-head">' + U.esc(cfg.newsletterName) + ' ' + U.esc(WC.state.month) + ' ' +
        String(i + 1).padStart(2, '0') + '/' + String(total).padStart(2, '0') + '</div>' +
        '<h3>' + U.esc(unit) + '</h3>' +
        '<p class="page-sum">' + items.length + ' 筆 · 照片 ' + ph + ' 張' + (items.length ? ' · 建議 <b>' + U.esc(s.layout) + '</b>' : '') + '</p>' +
        (s.note && items.length ? '<p class="page-warn">' + U.esc(s.note) + '</p>' : '') +
        (items.length ? '<ul class="pi-list">' + items.map(function (r) { return itemHtml(r, cfg.units, canAct); }).join('') + '</ul>'
          : '<p class="muted small page-empty">這頁還沒有素材' + (canAct ? '，從下方「待挑選」採用。' : '。') + '</p>') +
        '<div class="page-mini-foot">' + U.esc(cfg.footer) + '</div></section>';
    }).join('');
    U.$('#pages-body').innerHTML = rows;
    renderPool(canAct);
    renderOrphans(used, cfg.units);
    WC.photos.hydrate(U.$('#panel-pages'));
  }

  /** 待挑選（已送出、尚未決定）：主編可直接採用 */
  function renderPool(canAct) {
    const box = U.$('#pages-pool');
    const pool = WC.state.records.filter(function (r) { return r.status === '已確認'; });
    box.hidden = !canAct;
    if (!canAct) { box.innerHTML = ''; return; }
    box.innerHTML = '<h3>待挑選 <small class="muted">' + pool.length + ' 筆已送出、還沒決定</small></h3>' +
      (pool.length ? '<ul class="pool-list">' + pool.map(function (r) {
        const ph = r.photos || [];
        const pending = WC.records.isPending(r.id);
        return '<li class="pi' + (pending ? ' is-busy' : '') + '" data-id="' + U.esc(r.id) + '"' + (pending ? ' aria-busy="true"' : '') + '>' +
          (pending ? '<span class="pi-busy" role="status">處理中…</span>' : '') + '<div class="pi-main">' +
          (ph.length ? '<button type="button" class="thumb-btn pi-thumb" data-act="view" aria-label="放大看「' + U.esc(r.title) + '」的 ' + ph.length + ' 張照片"><img data-photo-id="' + U.esc(ph[0].thumbId) + '" alt=""></button>' : '<span class="pi-thumb pi-nophoto" aria-hidden="true">✎</span>') +
          '<div><b class="pi-title">' + U.esc(r.title) + '</b><small class="muted">' + U.esc(r.unit) + ' · ' + ph.length + ' 張 · ' + U.esc(r.authorName) + '</small></div></div>' +
          '<div class="pi-tools"><button type="button" class="btn-sm btn-adopt" data-act="adopt"' + (r.photosBroken || pending ? ' disabled' : '') + '>' +
          (pending ? '處理中…' : '採用到「' + U.esc(r.unit) + '」') + '</button>' +
          '<button type="button" class="btn-sm" data-act="open">看內容</button></div></li>';
      }).join('') + '</ul>' : '<p class="muted small">目前沒有待挑選的素材。</p>');
  }

  /** 已採用、但單元已不在設定表清單內的紀錄：不會出現在六頁中，提示主編改單元 */
  function renderOrphans(used, units) {
    const box = U.$('#pages-orphans');
    const orphans = used.filter(function (r) { return units.indexOf(r.unit) < 0; });
    box.hidden = !orphans.length;
    if (!orphans.length) { box.innerHTML = ''; return; }
    const canAct = isEditorRole();
    box.innerHTML = '<b>有 ' + orphans.length + ' 筆已採用紀錄的單元已不在清單內</b>，不會排進六頁；' +
      (canAct ? '請按「移到…」改成現有單元：' : '請主編改成現有單元：') +
      '<ul class="pi-list">' + orphans.map(function (r) {
        return canAct ? itemHtml(r, units, true).replace('<b class="pi-title">', '<b class="pi-title">（' + U.esc(r.unit) + '）')
          : '<li>' + U.esc(r.title) + '（' + U.esc(r.unit) + '，' + U.esc(U.dateLabel(r.date)) + '）</li>';
      }).join('') + '</ul>';
  }

  function bind() {
    U.$('#panel-pages').addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const li = b.closest('[data-id]');
      if (!li) return;
      const rec = WC.records.findRec(li.getAttribute('data-id'));
      if (!rec) return;
      const act = b.getAttribute('data-act'), v = b.getAttribute('data-v');
      if (act === 'open') { WC.editor.open(rec); return; }
      if (act === 'view') { WC.viewer.open(WC.viewer.fromPhotos(rec.photos), 0, b, { title: rec.title, date: rec.date }); return; }
      if (!isEditorRole() || WC.records.isPending(rec.id)) return;
      if (act === 'move') { movingId = movingId === rec.id ? '' : rec.id; render(); focusIn(rec.id, movingId ? '.move-menu button:not(:disabled)' : '[data-act="move"]'); return; }
      if (act === 'move-cancel') { movingId = ''; render(); focusIn(rec.id, '[data-act="move"]'); return; }
      if (act === 'to') {
        movingId = '';
        // quickUpdate 會等 WC.app.reload() 合併後的「最後一次重繪」完成才 resolve，焦點不會被之後的重繪吃掉
        WC.records.quickUpdate(rec, { unit: v }, '「' + rec.title + '」移到「' + v + '」頁').then(function () { focusIn(rec.id, '[data-act="move"]'); });
      }
      if (act === 'out') { movingId = ''; WC.records.quickUpdate(rec, { status: '已確認' }, '「' + rec.title + '」已移出六頁，回到待挑選'); }
      if (act === 'layout' && v !== rec.layout) WC.records.quickUpdate(rec, { layout: v }, '「' + rec.title + '」改用' + v);
      if (act === 'adopt') WC.records.quickUpdate(rec, { status: '已採用' }, '已採用「' + rec.title + '」，排在「' + rec.unit + '」頁');
    });
  }

  function focusIn(id, sel) {
    const el = U.$('#panel-pages [data-id="' + CSS.escape(id) + '"] ' + sel);
    if (el) el.focus();
  }

  return { render: render, bind: bind, suggest: suggest, suggestFor: suggestFor };
})();
