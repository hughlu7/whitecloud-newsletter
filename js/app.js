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
    WC.printview.bind();
    WC.ai.bind();
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
    // v2.4 F4：bootstrap 與該月紀錄同時送出（兩者互不相依），省一次往返；畫面仍等 bootstrap 的設定到了才畫
    const month = WC.state.month;
    const prefetch = { month: month, p: WC.api.listRecords(month).then(function (r) { return { ok: true, r: r }; }, function (e) { return { ok: false, e: e }; }) };
    try {
      const b = await WC.api.bootstrap();
      WC.state.me = b.me;
      WC.state.config = b.config;
      WC.state.ai = b.ai || { enabled: false };
      renderBrokenBanner(b.me, b.brokenRows || []);
      document.title = b.config.newsletterName + '｜' + b.config.className;
      U.$('#brand-name').textContent = b.config.newsletterName;
      U.$('#brand-class').textContent = b.config.className;
      U.$('#who').textContent = b.me.name + '（' + b.me.role + '）';
      // 版本：前端與後端不同時一併顯示，方便確認部署是否完成
      U.$('#app-version').textContent = '白雲家訊 v' + WC.VERSION +
        (b.version && b.version !== 'demo' && b.version !== WC.VERSION ? '（後端 v' + b.version + '，請確認兩邊都已更新）' : '');
      U.$('#app').hidden = false;
      await reload(prefetch);
    } catch (e) {
      if (e.code === 'NOT_MEMBER') WC.auth.forget();   // 換帳號重新整理時不要再用這個登入
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
  /**
   * 重新向後端要該月紀錄並重畫。
   * 合併呼叫（Gemini 審查）：同一時間只跑一次；進行中又被呼叫，就標記「結束後再跑一次」，
   * 全部跑完才重畫一次。所有呼叫者拿到同一個 Promise，resolve 時畫面已是最後狀態。
   */
  let reloading = null;
  let reloadAgain = false;
  let reloadCount = 0;   // 回測用：實際呼叫 listRecords 的次數
  let loadedMonth = '';

  function reload(prefetch) {
    if (reloading) { reloadAgain = true; return reloading; }
    reloading = (async function () {
      let pre = prefetch || null;
      do {
        reloadAgain = false;
        await loadOnce(pre);
        pre = null;   // 預先抓的結果只用一次；之後的重跑一律重新抓
      } while (reloadAgain);
      WC.records.clearDone();
      render();
    })().finally(function () { reloading = null; });
    return reloading;
  }

  async function loadOnce(pre) {
    const month = WC.state.month;
    U.$('#month-label').textContent = U.monthLabel(month);
    U.$('#month-input').value = month;
    // 只有換月份（或第一次）才清成「載入中…」；同月重載保留卡片，避免連點時按鈕消失
    if (month !== loadedMonth) U.$('#record-list').innerHTML = '<div class="empty">載入中…</div>';
    reloadCount += 1;
    try {
      let res;
      if (pre && pre.month === month) {
        const x = await pre.p;
        if (!x.ok) throw x.e;
        res = x.r;
      } else {
        res = await WC.api.listRecords(month);
      }
      if (month !== WC.state.month) { reloadAgain = true; return; } // 途中換了月份：丟棄並重跑
      WC.state.records = res.records;
      loadedMonth = month;
    } catch (e) {
      WC.state.records = [];
      loadedMonth = '';
      U.toast('讀取紀錄失敗：' + U.errMsg(e), 'error');
    }
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
    WC.printview.refreshIfVisible(); // 只在六頁編排分頁顯示時排 A4 預覽
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

  /** 與後端 listRecords 相同的排序：活動日期，再依建立時間 */
  function sortRecords(list) {
    return list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : 1); });
  }

  /**
   * 儲存後：若紀錄被歸到別的月份，切過去，讓使用者看得到。
   * v2.4 F2：同月份時直接用後端回傳的 record 更新本地清單並重畫，不再整月重抓（省一次 listRecords 往返）。
   * 正在重載中（例如剛按了採用）時，那次重載可能是存檔前抓的，改為讓它結束後再抓一次，避免舊資料蓋掉新紀錄。
   */
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
    if (reloading) { await reload(); return; }
    const list = WC.state.records.filter(function (r) { return r.id !== rec.id; });
    list.push(rec);
    WC.state.records = sortRecords(list);
    localUpdates += 1;
    render();
  }

  /** v2.4 F2：刪除後直接從本地清單移除（同樣避開重載中的競態） */
  async function afterDelete(id) {
    if (reloading) { await reload(); return; }
    WC.state.records = WC.state.records.filter(function (r) { return r.id !== id; });
    localUpdates += 1;
    render();
  }
  let localUpdates = 0;   // 回測用：本地更新次數

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

  return { start: start, reload: function () { return reload(); }, render: render, afterSave: afterSave, afterDelete: afterDelete,
    reloadCount: function () { return reloadCount; }, localUpdates: function () { return localUpdates; } };
})();

document.addEventListener('DOMContentLoaded', WC.app.start);
