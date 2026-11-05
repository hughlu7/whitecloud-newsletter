/**
 * 「六頁編排」分頁。
 * 第 1 階段只做「各單元採用狀況總覽」（一單元一頁，顯示已採用筆數、照片數與建議版型）；
 * 真正的 A4 六頁排版、下載文字稿、列印 PDF 在第 3 階段完成。
 */
WC.layout = (function () {
  const U = WC.util;

  /** 依已採用素材數與照片數建議版型（第 3 階段會再細化並提示拆分） */
  function suggest(items) {
    const n = items.length;
    const ph = items.reduce(function (s, r) { return s + r.photos.length; }, 0);
    if (!n) return { layout: '—', note: '尚無已採用素材' };
    if (n === 1 && ph <= 2) return { layout: '故事版', note: '一則故事配主照片' };
    if (ph >= 3) return { layout: '相簿版', note: ph > 9 ? '照片 ' + ph + ' 張，建議精選 9 張以內' : '多照片配短圖說' };
    if (items.some(function (r) { return r.layout === '探索版'; })) return { layout: '探索版', note: '依嘗試→發現→調整呈現' };
    return { layout: n > 3 ? '相簿版' : '故事版', note: n > 3 ? '素材 ' + n + ' 筆，建議精簡或拆分' : '' };
  }

  function render() {
    const cfg = WC.state.config;
    const used = WC.state.records.filter(function (r) { return r.status === '已採用'; });
    const total = cfg.units.length;
    const rows = cfg.units.map(function (unit, i) {
      const items = used.filter(function (r) { return r.unit === unit; });
      const s = suggest(items);
      const ph = items.reduce(function (n, r) { return n + r.photos.length; }, 0);
      return '<div class="page-mini">' +
        '<div class="page-mini-head">' + U.esc(cfg.newsletterName) + ' ' + U.esc(WC.state.month) + ' ' +
        String(i + 1).padStart(2, '0') + '/' + String(total).padStart(2, '0') + '</div>' +
        '<h3>' + U.esc(unit) + '</h3>' +
        '<p>已採用 <b>' + items.length + '</b> 筆 · 照片 <b>' + ph + '</b> 張</p>' +
        '<p>建議版型：<b>' + U.esc(s.layout) + '</b></p>' +
        (s.note ? '<p class="muted">' + U.esc(s.note) + '</p>' : '') +
        '<ul>' + items.map(function (r) { return '<li>' + U.esc(r.title) + '</li>'; }).join('') + '</ul>' +
        '<div class="page-mini-foot">' + U.esc(cfg.footer) + '</div></div>';
    }).join('');
    U.$('#pages-body').innerHTML = rows;
    renderOrphans(used, cfg.units);
  }

  /** 已採用、但單元已不在設定表清單內的紀錄：不會出現在六頁中，提示主編改單元 */
  function renderOrphans(used, units) {
    const box = U.$('#pages-orphans');
    const orphans = used.filter(function (r) { return units.indexOf(r.unit) < 0; });
    box.hidden = !orphans.length;
    if (!orphans.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<b>有 ' + orphans.length + ' 筆已採用紀錄的單元已不在清單內</b>，不會排進六頁；請開啟紀錄改成現有單元：' +
      '<ul>' + orphans.map(function (r) {
        return '<li>' + U.esc(r.title) + '（' + U.esc(r.unit) + '，' + U.esc(U.dateLabel(r.date)) + '）</li>';
      }).join('') + '</ul>';
  }

  return { render: render, suggest: suggest };
})();
