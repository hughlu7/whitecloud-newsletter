/**
 * v2.5「設定」分頁（只有主編看得到；後端 getSettings／saveSettings 也只限主編）。
 *
 * 做法：打開分頁時向後端要一次目前設定（含 configVersion 與各單元「所有月份」的紀錄數），
 * 在畫面上改的是一份「草稿」（新增、改名、刪除、上下移、其他文字），按「儲存設定」才一次送出 saveSettings。
 *   - 改名：送 { name: 新名, from: 原名 }，後端在鎖內把紀錄一起改名（不改紀錄的 updatedAt）。
 *   - 刪除：該單元還有紀錄（含其他已刪單元要搬進來的）時，必須先選「移到哪個單元」；沒有紀錄也要確認。
 *   - 樂觀鎖：送出時帶 expectedVersion；別的主編先存了 → CONFLICT，提示重新載入設定。
 * 名稱規則與後端 cleanUnitName_ 相同（前端先擋，後端一定再驗一次）。
 */
WC.settings = (function () {
  const U = WC.util;
  const DEFAULT_LIMITS = { unitName: 12, unitsMin: 1, unitsMax: 12, maxPhotos: 20, className: 20, newsletterName: 20, footer: 60, emptyText: 100 };
  let server = null;   // 最後一次 getSettings／saveSettings 的結果
  let draft = null;    // { units:[{key,name,from,count}], removed:[{key,name,count,moveToKey}], info:{…} }
  let keySeq = 0;
  let editingKey = '';
  let loading = false, saving = false;
  let focusAfter = null;   // 重畫後要聚焦的元素 { key, act }

  function isEditor() { return WC.state.me && WC.state.me.role === '主編'; }
  function lim() { return Object.assign({}, DEFAULT_LIMITS, server && server.limits); }
  function newKey() { keySeq += 1; return 'u' + keySeq; }
  function $s(sel) { return U.$('#panel-settings ' + sel); }
  /** 以單元名稱為鍵的物件一律用 hasOwnProperty 取值（名稱可能是 constructor、toString、__proto__） */
  function countOf(counts, name) { return counts && Object.prototype.hasOwnProperty.call(counts, name) ? Number(counts[name]) || 0 : 0; }
  const UNIT_BAD_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]/;
  const CTRL_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

  function fromServer(res) {
    server = res;
    const counts = res.unitCounts;
    draft = {
      units: res.config.units.map(function (u) { return { key: newKey(), name: u, from: u, count: countOf(counts, u) }; }),
      removed: [],
      info: {
        className: res.config.className || '', newsletterName: res.config.newsletterName || '', footer: res.config.footer || '',
        emptyText: res.config.emptyText || '', maxPhotos: res.config.maxPhotos
      }
    };
    editingKey = '';
  }

  /** 這個單元刪除時要搬的紀錄數：自己的紀錄＋已刪單元選擇搬進來的 */
  function carried(u) {
    return u.count + draft.removed.reduce(function (n, r) { return n + (r.moveToKey === u.key ? r.count : 0); }, 0);
  }
  function unitByKey(k) { return draft.units.find(function (u) { return u.key === k; }); }

  // ---------- 變更摘要 ----------
  function changes() {
    if (!draft || !server) return [];
    const out = [];
    const cfg = server.config;
    draft.units.forEach(function (u) {
      if (!u.from) out.push({ kind: 'add', text: '新增單元「' + u.name + '」' });
      else if (u.from !== u.name) out.push({ kind: 'rename', records: u.count, text: '「' + u.from + '」改名為「' + u.name + '」' + (u.count ? '（' + u.count + ' 筆紀錄一起改）' : '（沒有紀錄）') });
    });
    draft.removed.forEach(function (r) {
      const to = r.moveToKey ? unitByKey(r.moveToKey) : null;
      out.push({ kind: 'remove', records: r.count, text: '刪除單元「' + r.name + '」' + (to && r.count ? '（' + r.count + ' 筆紀錄移到「' + to.name + '」）' : '（沒有紀錄）') });
    });
    const keptOrder = draft.units.filter(function (u) { return u.from; }).map(function (u) { return u.from; });
    const oldOrder = cfg.units.filter(function (u) { return keptOrder.indexOf(u) >= 0; });
    if (keptOrder.join('\n') !== oldOrder.join('\n')) out.push({ kind: 'order', text: '調整單元順序' });
    const labels = { className: '班級名稱', newsletterName: '家訊名稱', footer: '頁尾標語', emptyText: '沒有素材時的頁面文字', maxPhotos: '每筆照片上限' };
    Object.keys(labels).forEach(function (k) {
      const a = String(draft.info[k] == null ? '' : draft.info[k]).trim(), b = String(cfg[k] == null ? '' : cfg[k]).trim();
      if (a !== b) out.push({ kind: 'info', text: labels[k] + '改為「' + (a || '（預設）') + '」' });
    });
    return out;
  }
  function isDirty() { return changes().length > 0; }

  // ---------- 名稱檢查（與後端 cleanUnitName_ 相同，另外擋「和這次要刪的單元同名」） ----------
  function cleanName(v) { return String(v == null ? '' : v).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim(); }
  function nameError(name, exceptKey) {
    const L = lim();
    if (!name) return '單元名稱不可空白';
    if (/[,，、]/.test(name)) return '單元名稱不能有逗號或頓號';
    if (UNIT_BAD_CHARS_RE.test(name)) return '單元名稱不可換行，也不可含控制字元或看不見的特殊字元';
    if (U.charLen(name) > L.unitName) return '單元名稱最多 ' + L.unitName + ' 字（目前 ' + U.charLen(name) + ' 字），請刪減';
    if (draft.units.some(function (u) { return u.key !== exceptKey && u.name === name; })) return '已經有「' + name + '」這個單元';
    if (draft.removed.some(function (r) { return r.name === name; })) return '「' + name + '」是這次要刪除的單元，請先儲存刪除，或換一個名稱';
    return '';
  }

  // ---------- 畫面 ----------
  function showMsg(html, type) {
    const box = $s('#settings-msg');
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.className = 'settings-msg ' + (type || 'info');
    box.innerHTML = html;
    box.hidden = false;
  }
  function unitErr(msg) {
    const p = $s('#set-unit-err');
    p.textContent = msg || '';
    p.hidden = !msg;
  }

  function rowHtml(u, i, n) {
    const L = lim();
    const name = U.esc(u.name);
    const meta = [];
    if (!u.from) meta.push('<span class="set-badge new">新增</span>');
    else if (u.from !== u.name) meta.push('<span class="set-badge">原名：' + U.esc(u.from) + '</span>');
    const c = carried(u);
    meta.push('<span class="muted">' + (u.from ? c + ' 筆紀錄' : c ? c + ' 筆紀錄（搬入）' : '尚無紀錄') + '</span>');
    if (editingKey === u.key) {
      return '<li class="set-unit editing" data-key="' + u.key + '">' +
        '<span class="set-no" aria-hidden="true">' + (i + 1) + '</span>' +
        '<div class="set-rename"><label class="visually-hidden" for="set-rename-input">「' + name + '」的新名稱</label>' +
        '<input id="set-rename-input" type="text" value="' + name + '" autocomplete="off" aria-describedby="set-rename-count">' +
        '<small id="set-rename-count" class="counter set-name-count">' + U.charLen(u.name) + '／' + L.unitName + '</small>' +
        '<button type="button" class="btn btn-primary" data-act="rename-ok">確定</button>' +
        '<button type="button" class="btn" data-act="rename-cancel">取消</button></div></li>';
    }
    return '<li class="set-unit" data-key="' + u.key + '">' +
      '<span class="set-no" aria-label="第 ' + (i + 1) + ' 頁">' + (i + 1) + '</span>' +
      '<div class="set-name"><b>' + name + '</b><small>' + meta.join(' · ') + '</small></div>' +
      '<div class="set-tools">' +
      '<button type="button" class="btn-sm" data-act="up" aria-label="把「' + name + '」往前移一頁"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="btn-sm" data-act="down" aria-label="把「' + name + '」往後移一頁"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button type="button" class="btn-sm" data-act="rename" aria-label="把「' + name + '」改名">改名</button>' +
      '<button type="button" class="btn-sm btn-out" data-act="delete" aria-label="刪除「' + name + '」"' + (n <= L.unitsMin ? ' disabled' : '') + '>刪除</button>' +
      '</div></li>';
  }

  function render() {
    const panel = U.$('#panel-settings');
    if (!panel) return;
    updateTabDot();
    if (!draft) {
      $s('#set-unit-list').innerHTML = '<li class="set-loading">' + (loading ? '載入設定中…' : '尚未載入') + '</li>';
      $s('#set-save').disabled = true;
      $s('#set-reset').disabled = true;
      return;
    }
    const L = lim();
    const n = draft.units.length;
    $s('#set-units-count').textContent = '共 ' + n + ' 個單元＝家訊 ' + n + ' 頁';
    $s('#set-unit-list').innerHTML = draft.units.map(function (u, i) { return rowHtml(u, i, n); }).join('');
    $s('#set-min-note').hidden = n > L.unitsMin;
    $s('#set-min-note').textContent = '至少要保留 ' + L.unitsMin + ' 個單元，所以最後一個不能刪除。';
    updateNameCount($s('#set-unit-new'), $s('#set-unit-new-count'));
    const full = n >= L.unitsMax;
    $s('#set-unit-add').disabled = full || saving;
    $s('#set-unit-new').disabled = full || saving;
    $s('#set-unit-new').placeholder = full ? '已達 ' + L.unitsMax + ' 個單元上限' : '新單元名稱（例如：戶外教學）';
    // 其他設定（使用者正在輸入的欄位不要被重設游標）
    ['className', 'newsletterName', 'footer', 'emptyText', 'maxPhotos'].forEach(function (k) {
      const el = $s('#set-' + k);
      if (document.activeElement !== el) el.value = draft.info[k];
    });
    $s('#set-maxPhotos-max').textContent = L.maxPhotos;
    $s('#set-maxPhotos').max = L.maxPhotos;
    renderMaxPhotosWarn();
    $s('#set-layouts').innerHTML = (server.config.layouts || []).map(function (l) { return '<span class="set-chip">' + U.esc(l) + '</span>'; }).join('');
    updateCounters();
    const ch = changes();
    $s('#set-dirty').textContent = ch.length ? '有 ' + ch.length + ' 項修改尚未儲存' : '沒有未儲存的修改';
    $s('#set-dirty').classList.toggle('on', !!ch.length);
    $s('#set-save').disabled = !ch.length || saving;
    $s('#set-save').textContent = saving ? '儲存中…' : '儲存設定';
    $s('#set-reset').disabled = !ch.length || saving;
    if (focusAfter) {
      const f = focusAfter; focusAfter = null;
      const row = $s('[data-key="' + f.key + '"]');
      let el = row && f.act ? row.querySelector('[data-act="' + f.act + '"]') : null;
      if (el && el.disabled) el = row.querySelector('[data-act="' + (f.act === 'up' ? 'down' : 'up') + '"]:not(:disabled)') || row.querySelector('[data-act="rename"]');
      if (f.sel) el = $s(f.sel);
      if (el) el.focus();
    }
  }

  function renderMaxPhotosWarn() {
    const w = $s('#set-maxPhotos-warn');
    const used = server ? server.maxPhotosUsed || 0 : 0;
    const v = Number(draft.info.maxPhotos);
    const show = isFinite(v) && used > v;
    w.hidden = !show;
    w.textContent = show ? '已有紀錄放了 ' + used + ' 張照片；改小後，那些紀錄要先刪減照片才能再存檔。' : '';
  }

  function updateCounters() {
    U.$all('#panel-settings [data-count-for]').forEach(function (el) {
      const input = U.$('#' + el.getAttribute('data-count-for'));
      if (!input) return;
      const max = Number(input.getAttribute('data-maxchars'));
      const len = U.charLen(input.value);
      el.textContent = len + '／' + max;
      el.classList.toggle('near', len >= max * 0.9);
    });
  }

  function updateTabDot() {
    const dot = U.$('#tab-settings-dot');
    if (dot) dot.hidden = !(draft && isDirty());
  }

  // ---------- 載入 ----------
  async function load() {
    if (!isEditor()) return;
    loading = true;
    draft = null;
    render();
    try {
      const res = await WC.api.getSettings();
      fromServer(res);
      showMsg('');
      // 複核 2：別人改過設定（衝突後重新載入、或手改設定表）→ 頁首、篩選、分頁頁數、本月紀錄一起更新
      if (res.configVersion !== WC.state.configVersion) await adoptConfig(res);
    } catch (e) {
      showMsg('讀取設定失敗：' + U.esc(U.errMsg(e)) + ' <button type="button" class="btn-sm" data-act="reload-settings">再試一次</button>', 'error');
    } finally {
      loading = false;
      render();
    }
  }

  /** 把後端回來的新設定套用到整個畫面（不整頁重載）：state、頁首、篩選、分頁頁數，再重抓本月紀錄（單元名稱可能變了） */
  async function adoptConfig(res) {
    WC.state.config = res.config;
    WC.state.configVersion = res.configVersion;
    if (WC.state.filterUnit && res.config.units.indexOf(WC.state.filterUnit) < 0) WC.state.filterUnit = '';
    WC.app.applyConfig(res.config);
    try { await WC.app.reload(); } catch (e) { /* reload 自己會提示 */ }
  }

  /** 單元名稱輸入框的「n／12」；超過時變色並提示（不默默截斷） */
  function updateNameCount(input, out) {
    if (!input || !out) return;
    const L = lim();
    const len = U.charLen(cleanName(input.value));
    out.textContent = len + '／' + L.unitName;
    out.classList.toggle('near', len > L.unitName);
    return len > L.unitName;
  }

  /** 有未儲存的設定時先問（頁內確認視窗）；回傳 true＝可以繼續（沒有修改，或使用者選擇放棄） */
  async function confirmDiscard(what) {
    if (!draft || !isDirty()) return true;
    const n = changes().length;
    const ok = await confirmDialog({
      title: '設定還沒儲存',
      html: '<p>「⚙ 設定」有 <b>' + n + '</b> 項修改還沒儲存。' + U.esc(what || '繼續') + '會放棄這些修改。</p>',
      okText: '放棄修改', danger: true
    });
    if (!ok) return false;
    clear();
    return true;
  }

  /** 切到「設定」分頁時呼叫：沒有未儲存的修改就重新讀一次（拿到最新的版本與紀錄數） */
  function onShow() {
    if (!isEditor() || loading || saving) return;
    if (!draft || !isDirty()) load();
    else render();
  }

  /** 換身分（示範模式）或重新登入時清掉草稿 */
  function clear() { server = null; draft = null; editingKey = ''; showMsg(''); unitErr(''); updateTabDot(); }

  /** 只更新各單元紀錄數（UNIT_HAS_RECORDS 時用；保留草稿） */
  async function refreshCounts() {
    try {
      const res = await WC.api.getSettings();
      if (res.configVersion !== server.configVersion) return false;
      const counts = res.unitCounts;
      server = Object.assign({}, server, { unitCounts: counts, maxPhotosUsed: res.maxPhotosUsed });
      draft.units.forEach(function (u) { if (u.from) u.count = countOf(counts, u.from); });
      draft.removed.forEach(function (r) { r.count = countOf(counts, r.name); });
      return true;
    } catch (e) { return false; }
  }

  // ---------- 單元操作 ----------
  function move(key, delta) {
    const i = draft.units.findIndex(function (u) { return u.key === key; });
    const j = i + delta;
    if (i < 0 || j < 0 || j >= draft.units.length) return;
    const t = draft.units[i]; draft.units[i] = draft.units[j]; draft.units[j] = t;
    focusAfter = { key: key, act: delta < 0 ? 'up' : 'down' };
    render();
  }

  function addUnit() {
    const input = $s('#set-unit-new');
    const name = cleanName(input.value);
    if (draft.units.length >= lim().unitsMax) { unitErr('最多 ' + lim().unitsMax + ' 個單元（家訊最多 ' + lim().unitsMax + ' 頁）'); return; }
    const err = nameError(name, '');
    if (err) { unitErr(err); input.focus(); return; }
    unitErr('');
    const u = { key: newKey(), name: name, from: '', count: 0 };
    draft.units.push(u);
    input.value = '';
    focusAfter = { sel: '#set-unit-new' };
    render();
    U.toast('已加入「' + name + '」（第 ' + draft.units.length + ' 頁），記得按「儲存設定」', 'info');
  }

  function startRename(key) {
    editingKey = key;
    unitErr('');
    render();
    const el = $s('#set-rename-input');
    if (el) { el.focus(); el.select(); }
  }
  function commitRename() {
    const u = unitByKey(editingKey);
    if (!u) { editingKey = ''; render(); return; }
    const name = cleanName($s('#set-rename-input').value);
    const err = nameError(name, u.key);
    if (err) { unitErr(err); $s('#set-rename-input').focus(); return; }
    unitErr('');
    u.name = name;
    editingKey = '';
    focusAfter = { key: u.key, act: 'rename' };
    render();
  }
  function cancelRename() {
    const k = editingKey;
    editingKey = '';
    unitErr('');
    focusAfter = { key: k, act: 'rename' };
    render();
  }

  async function askDelete(key, opener) {
    const u = unitByKey(key);
    if (!u) return;
    if (draft.units.length <= lim().unitsMin) { unitErr('至少要保留 ' + lim().unitsMin + ' 個單元'); return; }
    const n = carried(u);
    const others = draft.units.filter(function (x) { return x.key !== key; });
    const pages = draft.units.length;
    let body = '';
    if (n) {
      body = '<p>「<b>' + U.esc(u.name) + '</b>」還有 <b>' + n + '</b> 筆紀錄（所有月份）。刪除前，請選擇這些紀錄要移到哪個單元：</p>' +
        '<label class="set-field"><span>移到</span><select id="set-move-to">' +
        '<option value="">（請選擇）</option>' +
        others.map(function (x) { return '<option value="' + x.key + '">' + U.esc(x.name) + '</option>'; }).join('') + '</select></label>' +
        '<p class="set-err" id="set-move-err" role="alert" hidden>請先選擇要移到哪個單元。</p>';
    } else {
      body = '<p>確定要刪除「<b>' + U.esc(u.name) + '</b>」單元嗎？這個單元目前沒有紀錄。</p>';
    }
    body += '<p class="muted small">家訊會從 ' + pages + ' 頁變成 ' + (pages - 1) + ' 頁。按「儲存設定」後才會真的刪除。</p>';
    const ok = await confirmDialog({
      title: '刪除單元', html: body, okText: n ? '刪除並移動紀錄' : '刪除', danger: true, opener: opener,
      beforeOk: function () {
        if (!n) return true;
        const v = U.$('#set-move-to').value;
        U.$('#set-move-err').hidden = !!v;
        if (!v) U.$('#set-move-to').focus();
        return !!v;
      },
      focus: n ? '#set-move-to' : null
    });
    if (!ok) return;
    const toKey = n ? ok.moveTo : '';
    draft.units = others;
    // 原本要搬進這個單元的（已刪單元的紀錄）改搬到新的目標
    draft.removed.forEach(function (r) { if (r.moveToKey === key) r.moveToKey = toKey; });
    if (u.from) draft.removed.push({ key: key, name: u.from, count: u.count, moveToKey: toKey });
    if (editingKey === key) editingKey = '';
    focusAfter = { sel: '#set-unit-new' };
    render();
    U.toast('已刪除「' + u.name + '」' + (n ? '，紀錄將移到「' + unitByKey(toKey).name + '」' : '') + '；按「儲存設定」後才會真的刪除', 'info');
  }

  // ---------- 確認視窗（頁內對話框） ----------
  let confirmState = null;
  function confirmDialog(o) {
    return new Promise(function (resolve) {
      const box = U.$('#set-confirm');
      U.$('#set-confirm-h').textContent = o.title;
      U.$('#set-confirm-body').innerHTML = o.html;
      const go = U.$('#set-confirm-go');
      go.textContent = o.okText || '確定';
      go.classList.toggle('btn-danger-solid', !!o.danger);
      box.hidden = false;
      document.body.classList.add('modal-open');
      confirmState = { resolve: resolve, opener: o.opener || document.activeElement, beforeOk: o.beforeOk };
      const f = o.focus ? U.$(o.focus) : go;
      (f || go).focus();
    });
  }
  function closeConfirm(result) {
    if (!confirmState) return;
    const st = confirmState;
    if (result && st.beforeOk && !st.beforeOk()) return;
    const moveSel = U.$('#set-move-to');
    const value = result ? { moveTo: moveSel ? moveSel.value : '' } : false;
    confirmState = null;
    U.$('#set-confirm').hidden = true;
    if (U.$('#editor').hidden) document.body.classList.remove('modal-open');
    st.resolve(value);
    if (!result && st.opener && document.contains(st.opener)) st.opener.focus();
  }

  // ---------- 儲存 ----------
  function readInfo() {
    const L = lim();
    const v = function (k) { return cleanName($s('#set-' + k).value); };
    const info = { className: v('className'), newsletterName: v('newsletterName'), footer: v('footer'), emptyText: String($s('#set-emptyText').value || '').replace(/[\r\n\t]+/g, ' ').trim() };
    const labels = { className: ['班級名稱', '#set-className'], newsletterName: ['家訊名稱', '#set-newsletterName'], footer: ['頁尾標語', '#set-footer'], emptyText: ['沒有素材時的頁面文字', '#set-emptyText'] };
    for (const k in labels) if (CTRL_BIDI_RE.test(info[k])) return { err: labels[k][0] + '不可含控制字元或文字方向控制字元', sel: labels[k][1] };
    const mp = Number($s('#set-maxPhotos').value);
    if (!info.className) return { err: '請填寫班級名稱', sel: '#set-className' };
    if (!info.newsletterName) return { err: '請填寫家訊名稱', sel: '#set-newsletterName' };
    if (!(Math.floor(mp) === mp && mp >= 1 && mp <= L.maxPhotos)) return { err: '每筆照片上限必須是 1–' + L.maxPhotos + ' 的整數', sel: '#set-maxPhotos' };
    info.maxPhotos = mp;
    return { info: info };
  }

  async function save() {
    if (saving || !draft) return;
    if (editingKey) { commitRename(); if (editingKey) return; }
    const r = readInfo();
    if (r.err) { showMsg(U.esc(r.err), 'error'); $s(r.sel).focus(); return; }
    draft.info = r.info;
    const ch = changes();
    if (!ch.length) { render(); return; }
    // 會動到既有紀錄（改名、刪除）時先確認
    const heavy = ch.filter(function (c) { return c.kind === 'rename' || c.kind === 'remove'; });
    if (heavy.length) {
      const affected = heavy.reduce(function (n, c) { return n + (c.records || 0); }, 0);
      const ok = await confirmDialog({
        title: '請確認以下修改',
        html: '<p>' + (affected ? '共有 <b>' + affected + '</b> 筆既有紀錄會一起改到新的單元。' : '這次的改名或刪除不會動到任何紀錄。') + '</p>' +
          '<ul class="confirm-list">' + ch.map(function (c) { return '<li>' + U.esc(c.text) + '</li>'; }).join('') + '</ul>' +
          (affected ? '<p class="muted small">其他老師正在編輯的紀錄，存檔時會自動用新的單元名稱。</p>' : ''),
        okText: '儲存', opener: $s('#set-save')
      });
      if (!ok) return;
    }
    const payload = {
      expectedVersion: server.configVersion,
      settings: draft.info,
      units: draft.units.map(function (u) { return { name: u.name, from: u.from || '' }; }),
      removed: draft.removed.map(function (x) { const t = x.moveToKey ? unitByKey(x.moveToKey) : null; return { name: x.name, moveTo: t ? t.name : '' }; })
    };
    saving = true;
    showMsg('');
    render();
    try {
      const res = await WC.api.saveSettings(payload);
      fromServer(res);
      await adoptConfig(res);
      saving = false;
      showMsg('設定已儲存' + (res.moved ? '，' + res.moved + ' 筆紀錄已改到新的單元。' : '。'), 'ok');
      U.toast('設定已儲存' + (res.moved ? '（' + res.moved + ' 筆紀錄一起更新）' : ''), 'ok');
      render();
      $s('#settings-msg').focus();   // 複核 5：確認視窗關閉後焦點不會掉到頁面開頭
    } catch (e) {
      saving = false;
      if (e.code === 'CONFLICT') {
        showMsg('<b>設定剛被其他主編（或有人在試算表）改過。</b>您的修改還沒存；請重新載入最新設定後再改一次。 <button type="button" class="btn-sm" data-act="reload-settings">重新載入設定</button>', 'error');
      } else if (e.code === 'UNIT_HAS_RECORDS') {
        await refreshCounts();
        showMsg(U.esc(U.errMsg(e)) + '（紀錄數已更新，請重新刪除該單元並選擇要移到哪裡）', 'error');
        // 剛好有人新增了紀錄：把該單元放回清單，讓主編重新選擇搬移目標
        restoreRemoved(e);
      } else if (e.code === 'FORBIDDEN') {
        showMsg(U.esc(U.errMsg(e)), 'error');
      } else {
        showMsg('儲存失敗：' + U.esc(U.errMsg(e)), 'error');
      }
      render();
    }
  }

  /** UNIT_HAS_RECORDS：沒選搬移目標的已刪單元（現在有紀錄了）放回清單最後面 */
  function restoreRemoved() {
    draft.removed = draft.removed.filter(function (r) {
      if (r.moveToKey || !r.count) return true;
      if (draft.units.length < lim().unitsMax && !draft.units.some(function (u) { return u.name === r.name; })) {
        draft.units.push({ key: r.key, name: r.name, from: r.name, count: r.count });
        return false;
      }
      return true;
    });
  }

  function reset() {
    if (!server) return;
    fromServer(server);
    showMsg('');
    unitErr('');
    render();
  }

  function bind() {
    const panel = U.$('#panel-settings');
    if (!panel) return;
    // 回測 6：有未儲存的設定時，關閉分頁或重新整理先由瀏覽器提醒
    window.addEventListener('beforeunload', function (e) {
      if (draft && isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });
    U.bindCharLimits(panel);
    panel.addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.getAttribute('data-act');
      if (act === 'reload-settings') { load(); return; }
      if (!draft || saving) return;
      const li = b.closest('[data-key]');
      const key = li ? li.getAttribute('data-key') : '';
      if (act === 'up') move(key, -1);
      if (act === 'down') move(key, 1);
      if (act === 'rename') startRename(key);
      if (act === 'rename-ok') commitRename();
      if (act === 'rename-cancel') cancelRename();
      if (act === 'delete') askDelete(key, b);
    });
    panel.addEventListener('keydown', function (e) {
      if (e.target.id === 'set-rename-input') {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
      }
      if (e.target.id === 'set-unit-new' && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addUnit(); }
    });
    panel.addEventListener('input', function (e) {
      if (!draft) return;
      const m = /^set-(className|newsletterName|footer|emptyText|maxPhotos)$/.exec(e.target.id || '');
      if (m) {
        draft.info[m[1]] = m[1] === 'maxPhotos' ? Number(e.target.value) : e.target.value;
        if (m[1] === 'maxPhotos') renderMaxPhotosWarn();
        updateCounters();
        const ch = changes();
        $s('#set-dirty').textContent = ch.length ? '有 ' + ch.length + ' 項修改尚未儲存' : '沒有未儲存的修改';
        $s('#set-dirty').classList.toggle('on', !!ch.length);
        $s('#set-save').disabled = !ch.length || saving;
        $s('#set-reset').disabled = !ch.length || saving;
        updateTabDot();
      }
      if (e.target.id === 'set-unit-new' || e.target.id === 'set-rename-input') {
        const over = updateNameCount(e.target, e.target.id === 'set-unit-new' ? $s('#set-unit-new-count') : $s('#set-rename-count'));
        unitErr(over ? '單元名稱最多 ' + lim().unitName + ' 字（目前 ' + U.charLen(cleanName(e.target.value)) + ' 字），請刪減' : '');
      }
    });
    const step = function (d) {
      if (!draft) return;
      const L = lim();
      const v = Math.max(1, Math.min(L.maxPhotos, (Number(draft.info.maxPhotos) || 1) + d));
      draft.info.maxPhotos = v;
      $s('#set-maxPhotos').value = v;
      render();
    };
    $s('#set-maxPhotos-dec').addEventListener('click', function () { step(-1); });
    $s('#set-maxPhotos-inc').addEventListener('click', function () { step(1); });
    $s('#set-unit-add').addEventListener('click', addUnit);
    $s('#set-save').addEventListener('click', save);
    $s('#set-reset').addEventListener('click', reset);
    U.$('#set-confirm-go').addEventListener('click', function () { closeConfirm(true); });
    U.$('#set-confirm-cancel').addEventListener('click', function () { closeConfirm(false); });
    U.$('#set-confirm').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeConfirm(false); }
      if (e.key === 'Tab') {   // 焦點留在對話框內
        const f = U.$all('#set-confirm button, #set-confirm select').filter(function (x) { return !x.disabled; });
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  return { bind: bind, onShow: onShow, render: render, clear: clear, confirmDiscard: confirmDiscard, isDirty: function () { return !!draft && isDirty(); },
    _draft: function () { return draft ? JSON.parse(JSON.stringify(draft)) : null; } };
})();
