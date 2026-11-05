/**
 * 六頁編排的 A4 預覽與列印（第 3 階段，v2.0）。
 *
 * 流程：
 *   1. WCPrint.plan()：已採用紀錄 → 六頁配置（空單元預設保留；主編可切換隱藏）。
 *   2. 先用縮圖 render＋fit，畫面馬上看得到。
 *   3. 背景載入「實際會印出」的原圖（plan 內每筆已截取的 photos），分批呼叫 getPhotos：
 *      每批最多 BATCH 張，後端回應超過上限時會把剩下的放進 deferred，這裡下一輪再要。
 *   4. 原圖到齊後重新 render＋fit，更新紅黃提示。
 *   5. 「列印／另存 PDF」：原圖未到齊時先等（顯示進度），再顯示頁內確認框，確認後 window.print()。
 *
 * 量測一律在 100% 比例下進行；手機寬度的縮小預覽（zoom）在 fit() 之後才設，列印前清掉。
 * 所有使用者文字都經 esc()（print.js 內）或 textContent。
 */
WC.printview = (function () {
  const U = WC.util;
  const BATCH = 6;                 // 原圖約 300KB／張，6 張約 2.4MB（base64），遠低於 6MB 上限
  const fullCache = {};            // photo.id → data URL 或 null
  let emptyMode = 'keep';
  let current = null;              // { plan, issues, key }
  let renderSeq = 0;
  let loading = null;              // 載入原圖中的 Promise
  let loadedKey = '';
  let fetchCalls = 0;              // 回測用

  function isEditorRole() { return WC.state.me && WC.state.me.role === '主編'; }

  function root() { return U.$('#print-root'); }
  function sheets() { return U.$('#print-sheets'); }

  /** 這次會印出的照片清單 [{ id, thumbId }] */
  function printedPhotos(P) {
    const out = [];
    P.pages.forEach(function (pg) { pg.items.forEach(function (it) { it.photos.forEach(function (p) { out.push(p); }); }); });
    return out;
  }

  /** 先用原圖，沒有就用縮圖（WC.photos 快取），都沒有就給 1×1 透明圖 */
  function photoUrl(thumbFor) {
    return function (id) {
      if (fullCache[id]) return fullCache[id];
      const t = thumbFor[id];
      return (t && WC.photos.cached(t)) || 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    };
  }

  const WAIT_MAX_MS = 60000;   // v2.1 M6：等待原圖、字型最多 60 秒

  /** v2.1：印給家長前的內容檢查（代號、待補充、隱私字眼），以及相簿圖說被收起或截斷。回傳追加的 issues */
  function contentIssues(P, box) {
    const out = [];
    const byId = {};
    WC.state.records.forEach(function (r) { byId[r.id] = r; });
    P.pages.forEach(function (pg) {
      pg.items.forEach(function (it) {
        const rec = byId[it.id] || {};
        const slot = box.querySelector('.slot[data-id="' + cssEsc(it.id) + '"]');
        const found = WC.printcheck.checkRecord({ newsletter: rec.newsletter, summary: rec.summary }, it.photos);
        if (found.length) {
          // v2.3：只有提醒等級（privacysoft，例如「尖叫」）時用黃框
          const lv = found.every(function (x) { return x.kind === 'privacysoft'; }) ? 'yellow' : 'red';
          out.push({ level: lv, kind: 'content', page: pg.index, unit: pg.unit, id: it.id, title: it.title, messages: found.map(function (x) { return x.field + '：' + x.text; }) });
          flag(slot, lv, (lv === 'red' ? '⚠ 待處理：' : '請確認：') + WC.printcheck.summary(found));
        }
        const withCap = it.photos.filter(function (p) { return p.caption; }).length;
        if (withCap) {
          const msgs = [];
          if (it.layout !== '相簿版') msgs.push(withCap + ' 張照片的圖說不會印出（只有相簿版印圖說）');
          else {
            const g = slot && slot.querySelector('.grid.has-cap');
            if (g && !g.classList.contains('cap')) msgs.push('格子太小，' + withCap + ' 張照片的圖說已收起不印（建議減少照片或改成整頁）');
            else if (slot) {
              const cut = Array.prototype.filter.call(slot.querySelectorAll('figcaption'), function (f) { return f.scrollWidth - f.clientWidth > 1; }).length;
              if (cut) msgs.push(cut + ' 張照片的圖說太長、印出來會被截斷（以…結尾）');
            }
          }
          if (it.hiddenPhotos) {
            const hiddenCaps = (rec.photos || []).slice(it.photos.length).filter(function (p) { return p.caption; }).length;
            if (hiddenCaps) msgs.push('另有 ' + hiddenCaps + ' 張有圖說的照片超過版位上限、不會印出');
          }
          if (msgs.length) {
            out.push({ level: 'yellow', kind: 'caption', page: pg.index, unit: pg.unit, id: it.id, title: it.title, messages: msgs });
            flag(slot, 'yellow', '△ ' + msgs.join('；'));
          }
        }
      });
    });
    return out;
  }

  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  /** 在版位加一條提示（只在螢幕顯示；print.css 的 @media print 會隱藏 .flag） */
  function flag(slot, level, text) {
    if (!slot) return;
    slot.classList.add(level === 'red' ? 'is-over' : 'is-warn');
    let f = slot.querySelector('.flag.' + level + '.flag-extra');
    if (!f) {
      f = document.createElement('div');
      f.className = 'flag ' + level + ' flag-extra';
      slot.appendChild(f);
      const n = slot.querySelectorAll('.flag').length;
      if (n > 1) f.style.top = ((n - 1) * 5.2) + 'mm';
    }
    f.textContent = text;
    f.title = text;
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (r) { setTimeout(function () { r('__timeout__'); }, ms); })]);
  }

  async function waitAssets(box) {
    try { if (document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 10000); } catch (e) { /* 用後備字型 */ }
    const imgs = Array.prototype.slice.call(box.querySelectorAll('img'));
    await withTimeout(Promise.all(imgs.map(function (im) { return im.decode ? im.decode().catch(function () {}) : null; })), 20000);
  }

  function planNow() {
    const cfg = WC.state.config;
    return WCPrint.plan(WC.state.records, {
      className: cfg.className, newsletterName: cfg.newsletterName, footer: cfg.footer, units: cfg.units, emptyText: cfg.emptyText
    }, { month: WC.state.month, emptyMode: emptyMode });
  }

  /** 先載入縮圖（共用 WC.photos 佇列與快取） */
  async function ensureThumbs(list) {
    await Promise.all(list.map(function (p) { return WC.photos.get(p.thumbId); }));
  }

  /** 分批載入原圖；後端回 deferred 的下一輪再要。回傳失敗張數 */
  async function loadFull(list, onProgress) {
    const need = list.map(function (p) { return p.id; }).filter(function (id, i, a) { return !(id in fullCache) && a.indexOf(id) === i; });
    const total = need.length;
    let queue = need.slice();
    let done = 0, failed = 0, guard = 0;
    if (onProgress) onProgress(0, total);
    while (queue.length && guard++ < 200) {
      const batch = queue.slice(0, BATCH);
      queue = queue.slice(BATCH);
      let res;
      try {
        fetchCalls += 1;
        res = await WC.api.getPhotos(batch);
      } catch (e) {
        failed += batch.length; done += batch.length;
        if (onProgress) onProgress(done, total);
        continue;
      }
      const deferred = res.deferred || [];
      batch.forEach(function (id) {
        if (deferred.indexOf(id) >= 0) return;
        fullCache[id] = (res.photos || {})[id] || null;
        if (!fullCache[id]) failed += 1;
        done += 1;
      });
      queue = deferred.concat(queue);
      if (onProgress) onProgress(done, total);
    }
    return failed;
  }

  function setStatus(text, cls) {
    const el = U.$('#print-status');
    el.textContent = text;
    el.className = 'print-status' + (cls ? ' ' + cls : '');
  }

  function renderIssues(P, issues) {
    const red = issues.filter(function (i) { return i.level === 'red'; }).length;
    const sum = U.$('#print-sum');
    sum.className = 'print-sum ' + (red ? 'bad' : 'ok');
    sum.textContent = '共 ' + P.pages.length + ' 頁。' + (red
      ? '有 ' + red + ' 處放不下（紅框），建議拆分或精簡；列印時超出部分會被截掉，不會多出頁面。'
      : issues.length ? '全部放得下；黃框是提醒（例如已自動縮小字級）。' : '全部放得下。');
    const ul = U.$('#print-issues');
    ul.innerHTML = '';
    ul.hidden = !issues.length;
    issues.forEach(function (i) {
      const li = document.createElement('li');
      li.className = i.level === 'red' ? 'bad' : 'warn';
      li.textContent = (i.page ? '第 ' + i.page + ' 頁 ' : '') + i.unit + (i.title ? '「' + i.title + '」' : '') + '：' + i.messages.join('；');
      ul.appendChild(li);
    });
  }

  /** 螢幕比 A4 窄時整體縮小預覽（不影響列印；beforeprint 會清掉） */
  function fitScreen() {
    const box = sheets();
    if (!box) return;
    const avail = (root().clientWidth || window.innerWidth) - 8;
    const need = 214 * 96 / 25.4;
    box.style.zoom = avail < need ? String(Math.max(0.3, avail / need)) : '';
  }

  async function layoutOnce(seq) {
    const P = planNow();
    const list = printedPhotos(P);
    const thumbFor = {};
    list.forEach(function (p) { thumbFor[p.id] = p.thumbId; });
    await ensureThumbs(list);
    if (seq !== renderSeq) return null;
    const box = sheets();
    box.style.zoom = '';
    WCPrint.render(box, P, photoUrl(thumbFor));
    await waitAssets(box);
    if (seq !== renderSeq) return null;
    const issues = WCPrint.fit(box).concat(contentIssues(P, box));
    fitScreen();
    current = { plan: P, issues: issues, list: list };
    renderIssues(P, issues);
    return current;
  }

  /** 六頁編排分頁顯示時呼叫：先用縮圖排，再背景載入原圖後重排 */
  let lastError = null;
  let loadTimedOut = false;

  async function render() {
    if (!window.WCPrint || !root()) return;
    try {
      await renderInner();
    } catch (e) {
      // v2.1 M6：排版失敗時提示，並允許用目前畫面（可能是縮圖）列印
      lastError = e;
      console.error('列印預覽失敗', e);
      setStatus('排版時發生錯誤（' + U.errMsg(e) + '）；仍可列印目前的畫面，或重新整理頁面再試。', 'warn');
      root().dataset.ready = '1';
    }
  }

  async function renderInner() {
    lastError = null;
    loadTimedOut = false;
    const seq = ++renderSeq;
    U.$('#print-empty-mode').hidden = !isEditorRole();
    U.$('#print-empty-mode-sel').value = emptyMode;
    root().dataset.ready = '';
    setStatus('排版中…');
    const first = await layoutOnce(seq);
    if (!first) return;
    const key = JSON.stringify(first.list.map(function (p) { return p.id; }));
    const missing = first.list.some(function (p) { return !(p.id in fullCache); });
    if (!missing) { setStatus(''); root().dataset.ready = '1'; loadedKey = key; return; }
    setStatus('載入原圖中… 0 / ' + first.list.length);
    loading = loadFull(first.list, function (d, t) { if (seq === renderSeq) setStatus('載入原圖中… ' + d + ' / ' + t); });
    let failed = await withTimeout(loading, WAIT_MAX_MS);
    if (failed === '__timeout__') { loadTimedOut = true; failed = first.list.filter(function (p) { return !fullCache[p.id]; }).length; }
    loading = null;
    if (seq !== renderSeq) return;
    await layoutOnce(seq);
    if (seq !== renderSeq) return;
    loadedKey = key;
    setStatus(loadTimedOut ? '原圖載入超過 60 秒，先用已載入的原圖與縮圖排版；可以直接列印（未載入的會是縮圖，畫質較差），或稍後重新整理再試。'
      : failed ? '有 ' + failed + ' 張原圖讀取失敗，列印時會用縮圖（畫質較差）。' : '', (failed || loadTimedOut) ? 'warn' : '');
    root().dataset.ready = '1';
  }

  /** 是否顯示中（只在六頁編排分頁時排版） */
  function refreshIfVisible() {
    if (WC.state.tab === 'pages') render();
  }

  // ---------- 列印確認 ----------

  function redCount() {
    return current ? current.issues.filter(function (i) { return i.level === 'red' && i.kind !== 'content'; }).length : 0;
  }

  function issueLine(i) {
    return (i.page ? '第 ' + i.page + ' 頁' : '') + (i.title ? '「' + i.title + '」' : i.unit ? i.unit : '') + '：' + i.messages.join('；');
  }

  function fillList(id, list) {
    const ul = U.$(id);
    ul.innerHTML = '';
    list.forEach(function (i) { const li = document.createElement('li'); li.textContent = issueLine(i); ul.appendChild(li); });
    ul.hidden = !list.length;
  }

  function openConfirm() {
    const n = redCount();
    const box = U.$('#print-confirm');
    const cut = U.$('#print-confirm-cut');
    cut.hidden = n === 0;
    cut.textContent = n ? '有 ' + n + ' 處內容被截斷，仍要列印嗎？' : '';
    // v2.1：要給家長看的文字有代號、待補充、隱私字眼 → 「有 N 處待處理」；圖說被收起或截斷 → 黃色提醒
    const content = current ? current.issues.filter(function (i) { return i.kind === 'content'; }) : [];
    const caps = current ? current.issues.filter(function (i) { return i.kind === 'caption'; }) : [];
    const todo = U.$('#print-confirm-todo');
    todo.hidden = !content.length;
    todo.textContent = content.length ? '有 ' + content.length + ' 處待處理：' : '';
    fillList('#print-confirm-todo-list', content);
    const capP = U.$('#print-confirm-caps');
    capP.hidden = !caps.length;
    capP.textContent = caps.length ? '另有 ' + caps.length + ' 處圖說印不出來或被截斷：' : '';
    fillList('#print-confirm-caps-list', caps);
    box.hidden = false;
    U.$('#print-confirm-go').focus();
  }

  function closeConfirm() {
    U.$('#print-confirm').hidden = true;
    U.$('#btn-print').focus();
  }

  async function onPrintClick() {
    const btn = U.$('#btn-print');
    btn.disabled = true;
    try {
      if (loading || root().dataset.ready !== '1') {
        setStatus('等原圖載入完成後再列印…（最多 60 秒）');
        const until = Date.now() + WAIT_MAX_MS;
        while (root().dataset.ready !== '1' && Date.now() < until) await new Promise(function (r) { setTimeout(r, 150); });
        if (root().dataset.ready !== '1') setStatus('原圖還沒載完；將用目前畫面列印（部分照片可能是縮圖）。', 'warn');
      }
      openConfirm();
    } finally {
      btn.disabled = false;
    }
  }

  function doPrint() {
    U.$('#print-confirm').hidden = true;
    document.body.classList.add('is-printing');
    sheets().style.zoom = '';
    try { window.print(); } finally {
      setTimeout(function () { document.body.classList.remove('is-printing'); fitScreen(); }, 300);
    }
  }

  function downloadText() {
    const P = current ? current.plan : planNow();
    const blob = new Blob([WCPrint.toMarkdown(P)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = P.config.newsletterName + '_' + P.month + '_文字稿.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function bind() {
    U.$('#btn-print').addEventListener('click', onPrintClick);
    U.$('#btn-print-md').addEventListener('click', downloadText);
    U.$('#print-confirm-go').addEventListener('click', doPrint);
    U.$('#print-confirm-cancel').addEventListener('click', closeConfirm);
    U.$('#print-confirm').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeConfirm(); } });
    U.$('#print-empty-mode-sel').addEventListener('change', function (e) {
      emptyMode = e.target.value === 'hide' ? 'hide' : 'keep';
      render();
    });
    window.addEventListener('beforeprint', function () { if (sheets()) sheets().style.zoom = ''; document.body.classList.add('is-printing'); });
    window.addEventListener('afterprint', function () { document.body.classList.remove('is-printing'); fitScreen(); });
    window.addEventListener('resize', fitScreen);
  }

  return {
    bind: bind, render: render, refreshIfVisible: refreshIfVisible,
    // 回測用
    _state: function () { return { emptyMode: emptyMode, issues: current ? current.issues : [], pages: current ? current.plan.pages.length : 0, fetchCalls: fetchCalls, cached: Object.keys(fullCache).length, loadedKey: loadedKey, error: lastError ? String(lastError) : '', timedOut: loadTimedOut }; },
    _openConfirm: openConfirm
  };
})();
