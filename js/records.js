/**
 * 「本月素材」分頁：統計、單元與狀態篩選、紀錄卡片列表。
 */
WC.records = (function () {
  const U = WC.util;
  const STATUS_CLASS = { '草稿': 'st-draft', '已確認': 'st-ok', '已採用': 'st-used', '不採用': 'st-no' };

  function photoCount(list) {
    return list.reduce(function (n, r) { return n + (r.photos ? r.photos.length : 0); }, 0);
  }

  function renderStats() {
    const all = WC.state.records;
    U.$('#stat-records').textContent = all.length;
    U.$('#stat-photos').textContent = photoCount(all);
    U.$('#stat-used').textContent = all.filter(function (r) { return r.status === '已採用'; }).length;
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
  }

  function filtered() {
    return WC.state.records.filter(function (r) {
      return (!WC.state.filterUnit || r.unit === WC.state.filterUnit) &&
        (!WC.state.filterStatus || r.status === WC.state.filterStatus);
    });
  }

  function cardHtml(r) {
    const photos = r.photos || [];
    const thumbs = photos.slice(0, 4).map(function (p) {
      return '<img data-photo-id="' + U.esc(p.thumbId) + '" alt="" loading="lazy">';
    }).join('');
    const more = photos.length > 4 ? '<span class="more">+' + (photos.length - 4) + '</span>' : '';
    const text = r.newsletter || r.summary || r.rawText || '';
    return '<article class="card" data-id="' + U.esc(r.id) + '">' +
      '<div class="card-top"><span class="unit-tag">' + U.esc(r.unit) + '</span>' +
      '<span class="status ' + (STATUS_CLASS[r.status] || '') + '">' + U.esc(r.status) + '</span></div>' +
      (r.photosBroken ? '<p class="broken-tag" role="alert">⚠ 照片資料損壞，請聯絡管理者</p>' : '') +
      '<h3>' + U.esc(r.title) + '</h3>' +
      '<p class="meta">' + U.esc(U.dateLabel(r.date)) + ' · ' + U.esc(r.authorName) +
      (r.layout ? ' · ' + U.esc(r.layout) : '') + ' · ' + photos.length + ' 張照片</p>' +
      (photos.length ? '<div class="thumbs">' + thumbs + more + '</div>' : '') +
      (text ? '<p class="excerpt">' + U.esc(text.length > 90 ? text.slice(0, 90) + '…' : text) + '</p>' : '') +
      '<div class="card-actions">' +
      '<button type="button" class="btn-sm" data-act="open">' + (r.canEdit ? '編輯' : '檢視') + '</button>' +
      '</div></article>';
  }

  function renderList() {
    const list = filtered();
    const box = U.$('#record-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + (WC.state.records.length
        ? '這個篩選條件下沒有紀錄。'
        : U.esc(U.monthLabel(WC.state.month)) + '還沒有活動紀錄，按右上角「＋ 新增活動紀錄」開始。') + '</div>';
      return;
    }
    box.innerHTML = list.map(cardHtml).join('');
    WC.photos.hydrate(box);
  }

  function render() { renderStats(); renderFilters(); renderList(); }

  function bind() {
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
      const b = e.target.closest('[data-act="open"]');
      if (!b) return;
      const id = b.closest('.card').getAttribute('data-id');
      const rec = WC.state.records.find(function (r) { return r.id === id; });
      if (rec) WC.editor.open(rec);
    });
  }

  /** 某筆紀錄在目前篩選下是否看得到 */
  function isVisible(rec) {
    return (!WC.state.filterUnit || rec.unit === WC.state.filterUnit) &&
      (!WC.state.filterStatus || rec.status === WC.state.filterStatus);
  }

  return { render: render, bind: bind, isVisible: isVisible, STATUS_CLASS: STATUS_CLASS };
})();
