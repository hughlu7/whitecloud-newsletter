/**
 * 主程式：啟動、登入、月份切換、分頁切換、重新載入資料。
 * 載入順序見 index.html（config → util → state → demo → api → auth → photos → image → speech → records → layout → editor → app）。
 */
WC.app = (function () {
  const U = WC.util;

  async function start() {
    WC.records.bind();
    WC.editor.bind();
    WC.layout.bind();
    bindHeader();
    WC.state.month = readMonthFromUrl() || U.currentMonth();

    if (WC.api.isDemo) {
      document.body.classList.add('is-demo');
      U.$('#demo-bar').hidden = false;
      U.$('#btn-signout').hidden = true;
      await afterSignIn();
      return;
    }
    try {
      await WC.auth.init(function () { afterSignIn(); });
    } catch (e) {
      showFatal(U.errMsg(e));
    }
  }

  async function afterSignIn() {
    try {
      const b = await WC.api.bootstrap();
      WC.state.me = b.me;
      WC.state.config = b.config;
      renderBrokenBanner(b.me, b.brokenRows || []);
      document.title = b.config.newsletterName + '｜' + b.config.className;
      U.$('#brand-name').textContent = b.config.newsletterName;
      U.$('#brand-class').textContent = b.config.className;
      U.$('#who').textContent = b.me.name + '（' + b.me.role + '）';
      U.$('#app').hidden = false;
      await reload();
    } catch (e) {
      if (e.code === 'NOT_MEMBER' || e.code === 'NOT_SETUP') showFatal(e.message);
      else if (e.code !== 'BAD_TOKEN' && e.code !== 'NO_TOKEN') showFatal('載入失敗：' + U.errMsg(e));
    }
  }

  /** 主編登入時，若有照片資料損壞的紀錄，在頁首顯示醒目提示與救回方法；老師不顯示 */
  function renderBrokenBanner(me, rows) {
    const box = U.$('#broken-banner');
    if (me.role !== '主編' || !rows.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = '<b>⚠ 有 ' + rows.length + ' 筆紀錄的照片資料損壞</b>（試算表「照片JSON」欄被改動過）。' +
      '這些紀錄暫時不能編輯或刪除。<b>照片仍在雲端硬碟中且受保護</b>（每張照片都記得自己屬於哪筆紀錄），不會被清理。' +
      '<ul>' + rows.map(function (r) {
        return '<li>紀錄表第 ' + U.esc(r.row) + ' 列：' + U.esc(r.title || '（無標題）') + '</li>';
      }).join('') + '</ul>' +
      '<b>修復方法</b>（擇一）：' +
      '<ol><li>請管理者開啟 Apps Script，先執行 <code>repairBrokenPhotos</code> 預覽，確認後執行 <code>repairBrokenPhotosApply</code>，系統會依照片上的標記重建照片清單。</li>' +
      '<li>或開啟試算表「檔案 → 版本記錄 → 查看版本記錄」，找到改動前的版本，複製該列「照片JSON」欄的內容貼回目前版本的同一格（不要還原整份試算表，以免蓋掉別人的新紀錄）。</li></ol>';
    box.hidden = false;
  }

  function showFatal(msg) {
    const box = U.$('#fatal');
    box.hidden = false;
    U.$('#fatal-msg').textContent = msg;
  }

  function readMonthFromUrl() {
    const m = /[?&]month=(\d{4}-(0[1-9]|1[0-2]))\b/.exec(location.search);
    return m ? m[1] : '';
  }

  /** 重新向後端要該月紀錄並重畫 */
  async function reload() {
    U.$('#month-label').textContent = U.monthLabel(WC.state.month);
    U.$('#month-input').value = WC.state.month;
    U.$('#record-list').innerHTML = '<div class="empty">載入中…</div>';
    try {
      const res = await WC.api.listRecords(WC.state.month);
      WC.state.records = res.records;
    } catch (e) {
      WC.state.records = [];
      U.toast('讀取紀錄失敗：' + U.errMsg(e), 'error');
    }
    render();
  }

  function render() {
    WC.records.render();
    WC.layout.render();
    U.$all('.tab').forEach(function (t) {
      const on = t.getAttribute('data-tab') === WC.state.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    U.$all('.panel').forEach(function (p) { p.hidden = p.id !== 'panel-' + WC.state.tab; });
    const isEditor = WC.state.me && WC.state.me.role === '主編';
    U.$('#role-hint').textContent = isEditor
      ? '您是主編：在卡片上按「採用／不採用」即可決定；到「六頁編排」可把素材移到別頁。'
      : '';
    U.$('#role-hint').hidden = !isEditor;
    const t = U.todayStr();
    U.$('#hero-today').textContent = t.slice(0, 7) === WC.state.month
      ? '今天 ' + U.dateLabel(t)
      : '正在看 ' + U.monthLabel(WC.state.month) + '（新增時日期預設該月 1 日）';
  }

  /** 儲存後：若紀錄被歸到別的月份，切過去，讓使用者看得到 */
  async function afterSave(rec) {
    if (rec.month !== WC.state.month) {
      U.toast('這筆紀錄依活動日期歸到 ' + U.monthLabel(rec.month) + '，已切換月份。', 'info');
      setMonth(rec.month);
      return;
    }
    if (!WC.records.isVisible(rec)) {
      U.toast('已儲存，但目前的篩選條件看不到這筆，已清除篩選。', 'info');
      WC.state.filterUnit = '';
      WC.state.filterStatus = '';
    }
    await reload();
  }

  function setMonth(m) {
    WC.state.month = m;
    WC.state.filterUnit = '';   // 換月份時單元與狀態篩選都清除
    WC.state.filterStatus = '';
    history.replaceState(null, '', location.pathname + '?month=' + m + (/[?&]demo=1\b/.test(location.search) ? '&demo=1' : ''));
    reload();
  }

  function bindHeader() {
    U.$('#month-prev').addEventListener('click', function () { setMonth(U.shiftMonth(WC.state.month, -1)); });
    U.$('#month-next').addEventListener('click', function () { setMonth(U.shiftMonth(WC.state.month, 1)); });
    U.$('#month-input').addEventListener('change', function (e) { if (e.target.value) setMonth(e.target.value); });
    U.$('#btn-new').addEventListener('click', function () { WC.editor.open(null); });
    U.$('#btn-signout').addEventListener('click', function () { WC.auth.signOut(); });
    U.$('#btn-reload').addEventListener('click', function () { location.reload(); });
    U.$('.tabs').addEventListener('click', function (e) {
      const t = e.target.closest('.tab');
      if (!t) return;
      WC.state.tab = t.getAttribute('data-tab');
      render();
    });
    U.$('#demo-role').addEventListener('change', async function (e) {
      WC.demo.setUser(e.target.value);
      await afterSignIn();
      U.toast('已切換示範身分', 'info');
    });
  }

  return { start: start, reload: reload, render: render, afterSave: afterSave };
})();

document.addEventListener('DOMContentLoaded', WC.app.start);
