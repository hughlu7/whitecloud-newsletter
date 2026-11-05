/**
 * 「本月素材」分頁：一行統計、單元與狀態篩選、紀錄卡片列表。
 *
 * UX 改版：
 *   - 狀態用文字＋顏色＋圖示表達；給人看的名稱見 LABEL（送後端的值不變：「已確認」顯示為「已送出」）。
 *   - 老師：自己的卡片排在前面（「我的紀錄」），其他人的在後（「其他老師」）。
 *   - 主編：卡片上直接有「採用／不採用」按鈕，一鍵切換，不必開編輯視窗；老師看不到這些按鈕。
 */
WC.records = (function () {
  const U = WC.util;
  const STATUSES = ['草稿', '已確認', '已採用', '不採用'];
  const STATUS_CLASS = { '草稿': 'st-draft', '已確認': 'st-ok', '已採用': 'st-used', '不採用': 'st-no' };
  const LABEL = { '草稿': '草稿', '已確認': '已送出', '已採用': '已採用', '不採用': '不採用' };
  const ICON = { '草稿': '✎', '已確認': '➤', '已採用': '✓', '不採用': '–' };
  // 一鍵操作進行中的紀錄 ID：'saving'（送出中）→ 'done'（已存好、等重新載入）。
  // 'done' 要等 WC.app.reload() 拿到新資料、最後一次重繪前才清掉（clearDone），
  // 避免中間有別的重繪時，按鈕帶著舊的 updatedAt 又變成可按。
  const pendingIds = {};

  function label(s) { return LABEL[s] || s; }
  /** 這筆紀錄的一鍵操作（採用、移頁、改版型…）是否進行中；進行中時所有相關按鈕都要停用 */
  function isPending(id) { return !!pendingIds[id]; }
  function clearDone() { Object.keys(pendingIds).forEach(function (id) { if (pendingIds[id] === 'done') delete pendingIds[id]; }); }
  function isEditorRole() { return WC.state.me && WC.state.me.role === '主編'; }
  function isMine(r) { return WC.state.me && r.authorEmail === WC.state.me.email; }

  function photoCount(list) {
    return list.reduce(function (n, r) { return n + (r.photos ? r.photos.length : 0); }, 0);
  }

  function renderStats() {
    const all = WC.state.records;
    U.$('#stat-records').textContent = all.length;
    U.$('#stat-photos').textContent = photoCount(all);
    U.$('#stat-used').textContent = all.filter(function (r) { return r.status === '已採用'; }).length;
    const pending = all.filter(function (r) { return r.status === '已確認'; }).length;
    U.$('#stat-pending').textContent = pending;
    U.$('#stat-pending-wrap').hidden = !isEditorRole() || !pending;
  }

  function renderFilters() {
    const units = WC.state.config.units;
    const counts = {};
    const byStatus = WC.state.records.filter(function (r) { return !WC.state.filterStatus || r.status === WC.state.filterStatus; });
    byStatus.forEach(function (r) { counts[r.unit] = (counts[r.unit] || 0) + 1; });
    const chips = [{ v: '', label: '全部', n: byStatus.length }].concat(units.map(function (u) {
      return { v: u, label: u, n: counts[u] || 0 };
    }));
    U.$('#unit-filter').innerHTML = chips.map(function (c) {
      const on = WC.state.filterUnit === c.v;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-unit="' + U.esc(c.v) + '" aria-pressed="' + on + '">' +
        U.esc(c.label) + ' <span class="chip-n">' + c.n + '</span></button>';
    }).join('');
    U.$('#status-filter').value = WC.state.filterStatus;
    updateChipHint();
  }

  /** v2.1：單元標籤列還能左右捲時，顯示漸層與「›」 */
  function updateChipHint() {
    const el = U.$('#unit-filter'), wrap = U.$('#unit-filter-wrap');
    if (!el || !wrap) return;
    const max = el.scrollWidth - el.clientWidth;
    wrap.classList.toggle('can-scroll-right', max > 2 && el.scrollLeft < max - 2);
    wrap.classList.toggle('can-scroll-left', el.scrollLeft > 2);
  }

  function filtered() {
    return WC.state.records.filter(isVisible);
  }

  function statusBadge(s) {
    return '<span class="status ' + (STATUS_CLASS[s] || '') + '"><span aria-hidden="true">' + (ICON[s] || '') + '</span> ' + U.esc(label(s)) + '</span>';
  }

  function cardHtml(r) {
    const photos = r.photos || [];
    const thumbs = photos.slice(0, 4).map(function (p, i) {
      return '<button type="button" class="thumb-btn" data-act="view" data-i="' + i + '" aria-label="放大看「' + U.esc(r.title) + '」第 ' + (i + 1) + ' 張照片">' +
        '<img data-photo-id="' + U.esc(p.thumbId) + '" alt="" loading="lazy"></button>';
    }).join('');
    const more = photos.length > 4 ? '<button type="button" class="thumb-btn more" data-act="view" data-i="4" aria-label="看「' + U.esc(r.title) + '」其餘 ' + (photos.length - 4) + ' 張照片">+' + (photos.length - 4) + '</button>' : '';
    const text = r.newsletter || r.summary || r.rawText || '';
    const busy = isPending(r.id);
    const openLabel = !r.canEdit || r.photosBroken ? '檢視' : r.status === '草稿' && isMine(r) ? '繼續' : '編輯';
    let decide = '';
    if (isEditorRole()) {
      const dis = busy || r.photosBroken ? ' disabled' : '';
      const used = r.status === '已採用', no = r.status === '不採用';
      decide = '<div class="decide" role="group" aria-label="主編決定">' +
        '<button type="button" class="btn-sm btn-adopt' + (used ? ' on' : '') + '" data-act="adopt" aria-pressed="' + used + '"' + dis + '>' +
        (busy ? '處理中…' : used ? '✓ 已採用' : '採用') + '</button>' +
        '<button type="button" class="btn-sm btn-reject' + (no ? ' on' : '') + '" data-act="reject" aria-pressed="' + no + '"' + dis + '>' +
        (no ? '– 不採用' : '不採用') + '</button></div>';
    }
    return '<article class="card ' + (STATUS_CLASS[r.status] || '') + '-card' + (busy ? ' is-busy' : '') + '" data-id="' + U.esc(r.id) + '"' + (busy ? ' aria-busy="true"' : '') + '>' +
      '<div class="card-top"><span class="unit-tag">' + U.esc(r.unit) + '</span>' + statusBadge(r.status) + '</div>' +
      (r.photosBroken ? '<p class="broken-tag" role="alert">⚠ 照片資料損壞，請聯絡管理者</p>' : '') +
      '<h3>' + U.esc(r.title) + '</h3>' +
      '<p class="meta">' + U.esc(U.dateLabel(r.date)) + ' · ' + U.esc(r.authorName) + (isMine(r) ? '（我）' : '') +
      ' · ' + photos.length + ' 張照片' + (r.layout ? ' · ' + U.esc(r.layout) : '') + '</p>' +
      (photos.length ? '<div class="thumbs">' + thumbs + more + '</div>' : '') +
      (text ? '<p class="excerpt">' + U.esc(text.length > 90 ? text.slice(0, 90) + '…' : text) + '</p>' : '') +
      // v2.1：老師自己的、還能改的紀錄，提醒主編採用後就不能再修改
      (!isEditorRole() && isMine(r) && r.canEdit ? '<p class="lock-hint">主編採用後就不能再修改</p>' : '') +
      '<div class="card-actions">' + decide +
      '<button type="button" class="btn-sm btn-open" data-act="open">' + openLabel + '</button>' +
      '</div></article>';
  }

  function emptyHtml() {
    return '<div class="empty">' + (WC.state.records.length
      ? '這個篩選條件下沒有紀錄。'
      : U.esc(U.monthLabel(WC.state.month)) + '還沒有活動紀錄。按「＋ 記錄今天的活動」，拍幾張照片、說幾句話就好。') + '</div>';
  }

  function renderList() {
    const list = filtered();
    const box = U.$('#record-list');
    if (!list.length) { box.innerHTML = emptyHtml(); return; }
    if (isEditorRole()) {
      box.innerHTML = '<div class="cards">' + list.map(cardHtml).join('') + '</div>';
    } else {
      // 老師：自己的在前
      const mine = list.filter(isMine), others = list.filter(function (r) { return !isMine(r); });
      box.innerHTML =
        '<h2 class="list-h">我的紀錄 <small>' + mine.length + '</small></h2>' +
        (mine.length ? '<div class="cards">' + mine.map(cardHtml).join('') + '</div>' : '<p class="muted small list-empty">這個月您還沒有紀錄。</p>') +
        (others.length ? '<h2 class="list-h">其他老師 <small>' + others.length + '</small></h2><div class="cards">' + others.map(cardHtml).join('') + '</div>' : '');
    }
    WC.photos.hydrate(box);
  }

  function render() { renderStats(); renderFilters(); renderList(); }

  /** 只改狀態／單元／版型的一鍵操作（主編）；其他欄位原樣送回，後端規則不變 */
  async function quickUpdate(rec, patch, okMsg) {
    if (pendingIds[rec.id]) return false;
    pendingIds[rec.id] = 'saving';
    WC.app.render();
    const data = {
      id: rec.id, title: rec.title, date: rec.date, unit: rec.unit, rawText: rec.rawText, summary: rec.summary,
      newsletter: rec.newsletter, layout: rec.layout, status: rec.status, photos: rec.photos
    };
    Object.assign(data, patch);
    let ok = false;
    try {
      await WC.api.saveRecord(data, rec.updatedAt);
      ok = true;
      if (okMsg) U.toast(okMsg, 'ok');
    } catch (err) {
      U.toast((err && err.code === 'CONFLICT' ? '這筆剛被別人改過，已重新載入，請再按一次。' : '更新失敗：' + U.errMsg(err)), 'error');
    } finally {
      pendingIds[rec.id] = 'done';
    }
    await WC.app.reload(); // 合併重載；resolve 時已是最後一次重繪後的畫面
    return ok;
  }

  function findRec(id) { return WC.state.records.find(function (r) { return r.id === id; }); }

  function bind() {
    U.$('#unit-filter').addEventListener('scroll', updateChipHint, { passive: true });
    window.addEventListener('resize', updateChipHint);
    U.$('#unit-filter-more').addEventListener('click', function () {
      const el = U.$('#unit-filter');
      el.scrollBy({ left: Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' });
    });
    U.$('#unit-filter').addEventListener('click', function (e) {
      const b = e.target.closest('[data-unit]');
      if (!b) return;
      WC.state.filterUnit = b.getAttribute('data-unit');
      render();
    });
    U.$('#status-filter').addEventListener('change', function (e) {
      WC.state.filterStatus = e.target.value;
      render();
    });
    U.$('#record-list').addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const rec = findRec(b.closest('.card').getAttribute('data-id'));
      if (!rec) return;
      const act = b.getAttribute('data-act');
      if (act === 'open') { WC.editor.open(rec); return; }
      if (act === 'view') { WC.viewer.open(WC.viewer.fromPhotos(rec.photos), Number(b.getAttribute('data-i')), b, { title: rec.title, date: rec.date }); return; }
      if (!isEditorRole()) return;
      // 再按一次已選的按鈕＝取消決定，回到「已送出」
      if (act === 'adopt') {
        const to = rec.status === '已採用' ? '已確認' : '已採用';
        quickUpdate(rec, { status: to }, to === '已採用' ? '已採用「' + rec.title + '」，排在「' + rec.unit + '」頁' : '已取消採用「' + rec.title + '」');
      }
      if (act === 'reject') {
        const to = rec.status === '不採用' ? '已確認' : '不採用';
        quickUpdate(rec, { status: to }, to === '不採用' ? '「' + rec.title + '」設為不採用' : '已取消不採用「' + rec.title + '」');
      }
    });
  }

  /** 某筆紀錄在目前篩選下是否看得到 */
  function isVisible(rec) {
    return (!WC.state.filterUnit || rec.unit === WC.state.filterUnit) &&
      (!WC.state.filterStatus || rec.status === WC.state.filterStatus);
  }

  return {
    render: render, bind: bind, isVisible: isVisible, quickUpdate: quickUpdate, findRec: findRec, isPending: isPending, clearDone: clearDone,
    STATUS_CLASS: STATUS_CLASS, STATUSES: STATUSES, label: label, statusBadge: statusBadge
  };
})();
