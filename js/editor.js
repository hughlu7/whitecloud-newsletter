/**
 * 「記錄今天的活動」視窗（新增／編輯）。
 *
 * UX 改版（v1.6-ux）：
 *   - 三步驟：①加照片 ②說一說 ③選單元、送出。手機寬度（< 760px）逐步切換；平板、電腦三步並排。
 *   - 送出＝「已確認」（畫面上叫「已送出」）；「只存草稿」＝「草稿」；有內容時關閉會詢問「存成草稿／放棄」。
 *   - 標題可留空：送出前在前端自動補（原始紀錄前 15 字，或「單元 月/日」），後端欄位規則不變。
 *   - 版型由系統依照片數與文字自動建議；想改的人在「進階」點版型卡片。
 *   - 摘要、家訊文案收在「進階」（預設收合）；第 1 階段不顯示 AI 按鈕。
 *   - 鍵盤：Tab 依畫面順序；Ctrl（⌘）+Enter 送出；單行輸入框 Enter 不送出；Esc 關閉。可把照片拖進視窗。
 *
 * 照片流程（v2.4 F1）：選檔 → 在瀏覽器壓縮並預覽 → 立刻在背景上傳（同時最多 2 張）。
 * 送出／存草稿時只等「還沒傳完」的照片；上傳失敗的照片標示「上傳失敗」，可按「重試」或移除（送出時也會自動再試一次）。
 * 只有每一張新照片都上傳成功（有檔案 ID）才寫入紀錄，任何一張沒完成就不送出（不會只送一部分）。
 * 取消或關閉視窗時不刪 Drive 檔，交給後端每週清理（建立超過 72 小時、未屬於任何紀錄的檔案）。
 * 照片放進「上傳當時活動日期」的月份資料夾；之後改日期，照片不搬資料夾（資料夾只是存放位置，不影響權限與顯示）。
 *
 * 開啟序號 session（H1）：每次 open／close 都遞增。非同步工作（壓縮、上傳）每做完一步都比對序號，
 * 不同代表視窗已關閉或換了另一筆紀錄，結果直接丟棄，不會跑進別筆紀錄。
 */
WC.editor = (function () {
  const U = WC.util;
  const LIMITS = { title: 60, rawText: 5000, summary: 500, newsletter: 2000 };
  const FINAL = ['已採用', '不採用'];
  const STEP_MQ = window.matchMedia('(max-width: 759px)');
  let current = null;     // 編輯中的原始紀錄（新增時為 null）
  let photos = [];        // [{ key, kind:'saved'|'pending', photo?, previewUrl, b64?, thumbB64?, w, h, note, meta, up?, upErr? }]
                          //   pending 的 up：'wait' 排隊、'run' 上傳中、'done' 已上傳（photo 有檔案 ID）、'err' 失敗
                          //   note：畫面上的小字（壓縮資訊）；meta：要存進照片JSON 的選填欄位 { caption, note, fx, fy }（v2.0）
  const META_LIMITS = { caption: 40, note: 100 };
  let readOnly = false;
  let dirty = false;
  let busy = false;       // 儲存／刪除進行中
  let compressing = 0;    // 壓縮中的張數
  const UPLOAD_PARALLEL = 2;
  let uploading = 0;      // 這個 session 進行中的上傳數
  let uploadWaiters = []; // 等「沒有排隊／上傳中的照片」的 resolve
  let session = 0;
  let keySeq = 0;
  let lastRemoved = null; // { item, index }：供「復原」用
  let step = 1;
  let layoutManual = '';  // '' = 自動建議；否則為使用者點選的版型
  let statusTouched = false; // 主編在進階改過狀態
  let cancelSend = null;     // v2.6（G4）：等照片上傳時的「取消送出」

  function form() { return U.$('#editor-form'); }
  function field(name) { return form().elements[name]; }
  function box() { return U.$('#editor .modal-box'); }
  function isMine(rec) { return !rec || (WC.state.me && rec.authorEmail === WC.state.me.email); }
  function isEditorRole() { return WC.state.me && WC.state.me.role === '主編'; }

  // ---------- 單元（大按鈕單選） ----------

  /**
   * 單元按鈕。confirmNeeded（v2.1）：草稿當初沒選單元、暫放第一個單元時，重開不預先選取，並標示「請確認單元」；
   * 只列出舊值作為提醒，送出前一定要點選。
   */
  function renderUnits(value, confirmNeeded) {
    const units = WC.state.config.units.slice();
    const legacy = value && units.indexOf(value) < 0;
    if (legacy) units.push(value);
    U.$('#unit-options').innerHTML = units.map(function (u, i) {
      const label = legacy && u === value ? u + '（舊值）' : u;
      return '<label class="unit-opt"><input type="radio" name="unit" value="' + U.esc(u) + '"' +
        (u === value && !confirmNeeded ? ' checked' : '') + (readOnly ? ' disabled' : '') + '><span>' + U.esc(label) + '</span></label>';
    }).join('');
    const note = U.$('#unit-confirm-note');
    if (note) {
      note.hidden = !confirmNeeded;
      note.textContent = confirmNeeded ? '請確認單元：存草稿時還沒選，先暫放在「' + value + '」。' : '';
    }
  }

  function unitValue() {
    const r = U.$('#unit-options input:checked');
    return r ? r.value : '';
  }

  // ---------- 版型（自動建議＋三張卡片） ----------

  function suggestedLayout() {
    return WC.layout.suggestFor(photos.length + compressing, field('rawText').value);
  }

  function layoutValue() { return layoutManual || suggestedLayout(); }

  const LAYOUT_INFO = {
    '故事版': { ico: 'story', tip: '一張主照片＋完整敘述' },
    '相簿版': { ico: 'album', tip: '多張照片＋一句圖說' },
    '探索版': { ico: 'explore', tip: '嘗試→發現→調整' }
  };

  function layoutIcon(cls) {
    if (cls === 'story') return '<span class="lc-ico story" aria-hidden="true"><i class="p big"></i><i class="l"></i></span>';
    if (cls === 'album') return '<span class="lc-ico album" aria-hidden="true"><i class="p"></i><i class="p"></i><i class="p"></i><i class="p"></i></span>';
    if (cls === 'explore') return '<span class="lc-ico explore" aria-hidden="true"><i class="s"></i><i class="a">→</i><i class="s"></i><i class="a">→</i><i class="s"></i></span>';
    return '<span class="lc-ico" aria-hidden="true"></span>';
  }

  function renderLayouts() {
    const list = WC.state.config.layouts.slice();
    const val = layoutValue();
    if (val && list.indexOf(val) < 0) list.push(val);
    const sug = suggestedLayout();
    U.$('#layout-options').innerHTML = list.map(function (l) {
      const info = LAYOUT_INFO[l] || { ico: '', tip: '' };
      const legacy = WC.state.config.layouts.indexOf(l) < 0;
      // v2.1 D24：唯讀時版型卡片也停用
      return '<label class="lc' + (l === val ? ' on' : '') + (readOnly ? ' is-disabled' : '') + '"><input type="radio" name="layoutPick" value="' + U.esc(l) + '"' +
        (l === val ? ' checked' : '') + (readOnly ? ' disabled' : '') + '>' + layoutIcon(info.ico) +
        '<b>' + U.esc(l) + (legacy ? '（舊值）' : '') + '</b><small>' + U.esc(info.tip) + '</small>' +
        (l === sug ? '<em class="lc-sug">建議</em>' : '') + '</label>';
    }).join('');
    U.$('#layout-mode').textContent = layoutManual ? '（您選的）' : '（系統依照片與文字自動建議，可點選更改）';
    updateAdvPreview();
  }

  // ---------- 照片圖說與備註（v2.0，進階區） ----------

  /** 從照片物件取出選填欄位 */
  function pickMeta(p) {
    const m = {};
    if (p && p.caption) m.caption = String(p.caption);
    if (p && p.note) m.note = String(p.note);
    if (p && p.fx != null) m.fx = p.fx;
    if (p && p.fy != null) m.fy = p.fy;
    return m;
  }

  /** 存檔用：只放 ID、尺寸與非空的選填欄位 */
  function withMeta(photo, meta) {
    const out = { id: photo.id, thumbId: photo.thumbId, w: photo.w, h: photo.h };
    meta = meta || {};
    const cap = String(meta.caption || '').trim(), note = String(meta.note || '').trim();
    if (cap) out.caption = cap;
    if (note) out.note = note;
    if (meta.fx != null) out.fx = meta.fx;
    if (meta.fy != null) out.fy = meta.fy;
    return out;
  }

  /** 進階區的「照片圖說與備註」清單（依目前照片順序） */
  function renderPhotoMeta() {
    const box = U.$('#photo-meta');
    if (!box) return;
    const wrap = U.$('#photo-meta-wrap');
    wrap.hidden = !photos.length;
    box.innerHTML = photos.map(function (p, i) {
      const m = p.meta || {};
      const img = p.kind === 'saved'
        ? '<img data-photo-id="' + U.esc(p.photo.thumbId) + '" alt="">'
        : '<img src="' + U.esc(p.previewUrl) + '" alt="">';
      return '<li class="pm" data-key="' + p.key + '">' +
        '<span class="pm-thumb" aria-hidden="true">' + img + '<b>' + (i + 1) + '</b></span>' +
        '<div class="pm-fields">' +
        '<label class="field"><span>第 ' + (i + 1) + ' 張圖說 <small class="counter" data-meta-count="caption"></small></span>' +
        '<input data-meta="caption" data-maxchars="' + META_LIMITS.caption + '" placeholder="相簿版印在照片下方（可不填）" value="' + U.esc(m.caption || '') + '"' + (readOnly ? ' disabled' : '') + '></label>' +
        '<label class="field"><span>備註（不印出） <small class="counter" data-meta-count="note"></small></span>' +
        '<input data-meta="note" data-maxchars="' + META_LIMITS.note + '" placeholder="例如：右邊穿黃衣服的是小明" value="' + U.esc(m.note || '') + '"' + (readOnly ? ' disabled' : '') + '></label>' +
        '</div></li>';
    }).join('');
    U.$all('.pm', box).forEach(updateMetaCounters);
    WC.photos.hydrate(box);
  }

  function updateMetaCounters(li) {
    U.$all('[data-meta]', li).forEach(function (inp) {
      const k = inp.getAttribute('data-meta');
      const c = U.$('[data-meta-count="' + k + '"]', li);
      const len = U.charLen(inp.value);
      c.textContent = len + ' / ' + META_LIMITS[k];
      c.classList.toggle('near', len >= META_LIMITS[k] * 0.9);
    });
  }

  function onMetaInput(e) {
    const inp = e.target.closest('[data-meta]');
    if (!inp) return;
    const li = inp.closest('.pm');
    const p = photos.find(function (x) { return x.key === li.getAttribute('data-key'); });
    if (!p) return;
    p.meta = p.meta || {};
    p.meta[inp.getAttribute('data-meta')] = inp.value;
    dirty = true;
    updateMetaCounters(li);
  }

  function updateAdvPreview() {
    const parts = ['版型：' + layoutValue() + (layoutManual ? '' : '（自動）')];
    const filled = (field('summary').value.trim() ? 1 : 0) + (field('newsletter').value.trim() ? 1 : 0);
    parts.push(filled ? '摘要／文案已填' : '摘要、文案可不填');
    U.$('#adv-preview').textContent = '· ' + parts.join(' · ');
  }

  // ---------- 標題自動帶入 ----------

  function autoTitle() {
    const raw = field('rawText').value.replace(/\s+/g, ' ').trim();
    if (raw) return Array.from(raw).slice(0, 15).join('');
    const u = unitValue() || WC.state.config.units[0], d = field('date').value;
    const md = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : '';
    return ((u || '活動紀錄') + ' ' + md).trim();
  }

  function updateTitlePlaceholder() {
    field('title').placeholder = '空白時自動用「' + autoTitle() + '」';
  }

  // ---------- 開啟／關閉 ----------

  /** 開啟視窗；rec 省略＝新增 */
  function open(rec) {
    U.clearToasts('error');
    const cfg = WC.state.config;
    session += 1;
    compressing = 0;
    resetUploads();
    current = rec || null;
    // 照片資料損壞的紀錄一律唯讀：後端會拒絕存檔，避免把照片清單覆蓋成空的
    readOnly = !!(rec && (!rec.canEdit || rec.photosBroken));
    dirty = false;
    lastRemoved = null;
    statusTouched = false;
    step = 1;

    U.$('#editor-title').textContent = !rec ? '記錄今天的活動' : readOnly ? '檢視活動紀錄' : '編輯活動紀錄';
    field('title').value = rec ? rec.title : '';
    field('date').value = rec ? rec.date : defaultDate();
    renderUnits(rec ? rec.unit : WC.state.filterUnit, !!(rec && rec.status === '草稿' && rec.unitConfirmed === false));
    field('rawText').value = rec ? rec.rawText : '';
    field('summary').value = rec ? rec.summary : '';
    field('newsletter').value = rec ? rec.newsletter : '';

    photos = (rec ? rec.photos : []).map(function (p) {
      return { key: 'k' + (++keySeq), kind: 'saved', photo: p, w: p.w, h: p.h, note: '', meta: pickMeta(p) };
    });
    // 既有紀錄：版型等於自動建議（或空白）就視為自動，之後照片增減會跟著變
    layoutManual = rec && rec.layout && rec.layout !== WC.layout.suggestFor(photos.length, rec.rawText) ? rec.layout : '';

    // 狀態下拉只給主編、且只在編輯既有紀錄時出現
    const sel = field('status');
    sel.innerHTML = WC.records.STATUSES.map(function (s) {
      return '<option value="' + U.esc(s) + '"' + (rec && rec.status === s ? ' selected' : '') + '>' + U.esc(WC.records.label(s)) + '</option>';
    }).join('');
    U.$('#status-wrap').hidden = !(rec && isEditorRole() && !readOnly);

    U.$all('input, textarea, select', form()).forEach(function (el) { el.disabled = readOnly; });
    const finalized = rec && FINAL.indexOf(rec.status) >= 0;
    U.$('#btn-save').hidden = readOnly;
    U.$('#btn-save').textContent = saveLabel();
    U.$('#btn-draft').hidden = readOnly || !!(rec && rec.status !== '草稿');
    U.$('#btn-delete').hidden = !rec || readOnly;
    U.$('#photo-pick').hidden = readOnly;
    const author = U.$('#editor-author');
    author.textContent = rec ? '投稿：' + rec.authorName + (isMine(rec) ? '（我）' : '') + ' · 目前狀態：' + WC.records.label(rec.status) +
      (finalized ? '（主編已定案）' : '') : '';
    author.hidden = !rec;
    const broken = !!(rec && rec.photosBroken);
    U.$('#editor-lock-hint').hidden = readOnly || isEditorRole();
    if (WC.ai) WC.ai.reset();
    U.$('#editor-broken-note').hidden = !broken;
    U.$('#editor-readonly-note').hidden = !readOnly || broken;
    U.$('#photo-undo').hidden = true;
    U.$('#photo-status').textContent = ''; // 上一筆中途關閉時殘留的「壓縮中…」文字
    U.$('#leave-ask').hidden = true;
    U.$('#advanced').open = !!(rec && (rec.summary || rec.newsletter) && readOnly);

    setupSpeechUi();
    renderPhotos();
    renderLayouts();
    updateCounters();
    updateTitlePlaceholder();
    updateFooter();
    updateSaveState();
    applyStepMode();
    U.$('#editor').hidden = false;
    document.body.classList.add('modal-open');
    focusStart();
  }

  function saveLabel() {
    if (!current) return '送出';
    if (current.status === '草稿') return '送出';
    return '儲存';
  }

  function focusStart() {
    const target = readOnly ? U.$('#editor-close') : U.$('#photo-input');
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
  }

  /** 新增時的預設日期：今天若在目前月份就用今天，否則用該月 1 日 */
  function defaultDate() {
    const t = U.todayStr();
    return t.slice(0, 7) === WC.state.month ? t : WC.state.month + '-01';
  }

  /** 使用者想關閉：有修改就詢問一次「存成草稿／放棄」 */
  function requestClose() {
    if (busy) return;
    if (!U.$('#leave-ask').hidden) { hideLeaveAsk(); return; }
    if (readOnly || !(dirty || compressing)) { close(true); return; }
    showLeaveAsk();
  }

  function showLeaveAsk() {
    const keepLabel = current && current.status !== '草稿' ? '儲存修改' : '存成草稿';
    U.$('#leave-save').textContent = keepLabel;
    U.$('#leave-ask-title').textContent = current ? '修改還沒儲存，要怎麼處理？' : '還沒送出，要怎麼處理？';
    U.$('#leave-ask-note').textContent = compressing
      ? '照片還在壓縮（' + compressing + ' 張），完成後才能儲存；選「放棄」會直接丟掉。'
      : uploadsBusy()
        ? '照片還在上傳，按「' + keepLabel + '」會等上傳完成再存；選「放棄」會直接丟掉。'
      : current && current.status !== '草稿'
        ? '「儲存修改」會保留目前狀態（' + WC.records.label(current.status) + '）。'
        : '草稿不會給主編挑選；之後可以從首頁的卡片按「繼續」完成送出。';
    U.$('#leave-save').disabled = compressing > 0;
    U.$('#leave-ask').hidden = false;
    U.$(compressing ? '#leave-back' : '#leave-save').focus();
  }

  function hideLeaveAsk() {
    U.$('#leave-ask').hidden = true;
    focusStart();
  }

  function close(force) {
    if (busy) return;
    if (!force) { requestClose(); return; }
    session += 1;        // 讓進行中的壓縮、上傳結果作廢（已傳到 Drive 的檔案由後端孤兒清理處理）
    compressing = 0;
    resetUploads();
    WC.speech.stop();
    photos.forEach(revokePreview);
    if (lastRemoved) revokePreview(lastRemoved.item);
    photos = [];
    lastRemoved = null;
    U.$('#photo-status').textContent = '';
    U.$('#leave-ask').hidden = true;
    U.$('#editor').hidden = true;
    document.body.classList.remove('modal-open');
    const nb = U.$('#btn-new');
    if (nb && !nb.closest('[hidden]')) nb.focus();
  }

  function revokePreview(p) { if (p && p.kind === 'pending' && p.previewUrl) URL.revokeObjectURL(p.previewUrl); }

  // ---------- 逐步／並排 ----------

  function applyStepMode() {
    const steps = STEP_MQ.matches;
    const b = box();
    b.classList.toggle('is-steps', steps);
    b.setAttribute('data-step', String(step));
    U.$all('.step', b).forEach(function (s) { s.classList.toggle('cur', Number(s.getAttribute('data-step')) === step); });
    U.$all('.step-dot', b).forEach(function (d) {
      const n = Number(d.getAttribute('data-go'));
      d.classList.toggle('on', n === step);
      d.classList.toggle('done', n < step);
      if (n === step) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
    });
  }

  function goStep(n) {
    step = Math.max(1, Math.min(3, n));
    applyStepMode();
    U.$('.modal-body', box()).scrollTop = 0;
    if (!STEP_MQ.matches) return;
    if (step === 2 && !readOnly && !WC.speech.supported()) field('rawText').focus();
  }

  // ---------- 照片 ----------

  function renderPhotos() {
    const max = WC.state.config.maxPhotos;
    const grid = U.$('#photo-grid');
    const dis = busy ? ' disabled' : '';   // 儲存中重畫（例如背景上傳完成）時，照片工具保持停用
    grid.innerHTML = photos.map(function (p, i) {
      const img = p.kind === 'saved'
        ? '<img data-photo-id="' + U.esc(p.photo.thumbId) + '" alt="">'
        : '<img src="' + U.esc(p.previewUrl) + '" alt="">';
      return '<figure class="ph" data-key="' + p.key + '">' +
        '<button type="button" class="ph-view" data-ph="view" aria-label="放大看第 ' + (i + 1) + ' 張' + (p.kind === 'pending' ? '（' + UPLOAD_LABEL[p.up || 'wait'] + '）' : '') + '照片">' + img + '</button>' +
        '<figcaption>' + captionHtml(p, i) + '</figcaption>' + retryHtml(p, i) +
        (readOnly ? '' : '<div class="ph-tools">' +
          '<button type="button" data-ph="left" aria-label="第 ' + (i + 1) + ' 張往前移"' + (i === 0 || busy ? ' disabled' : '') + '>◀</button>' +
          '<button type="button" data-ph="right" aria-label="第 ' + (i + 1) + ' 張往後移"' + (i === photos.length - 1 || busy ? ' disabled' : '') + '>▶</button>' +
          '<button type="button" data-ph="remove" class="ph-remove" aria-label="移除第 ' + (i + 1) + ' 張照片"' + dis + '>✕</button></div>') +
        '</figure>';
    }).join('');
    const n = photos.length + compressing;
    U.$('#photo-count').textContent = n ? n + ' / ' + max + ' 張' : '';
    U.$('#photo-input').disabled = readOnly || busy || n >= max;
    U.$('#photo-pick').classList.toggle('has-photos', n > 0);
    U.$('.dz-main', U.$('#photo-pick')).textContent = n >= max ? '照片已達上限' : n ? '再加照片' : '拍照或選照片';
    const dot = U.$('.step-dot[data-go="1"]');
    if (dot) dot.lastChild.textContent = n ? '照片 ' + n : '照片';
    WC.photos.hydrate(grid);
    renderPhotoMeta();
    if (!layoutManual) renderLayouts();
  }

  async function onFilesPicked(fileList) {
    if (readOnly || busy) return;
    const mySession = session;
    const files = Array.prototype.slice.call(fileList);
    const max = WC.state.config.maxPhotos;
    const room = max - photos.length - compressing;
    if (files.length > room) U.toast('每筆最多 ' + max + ' 張，這次只會加入前 ' + Math.max(0, room) + ' 張。', 'error');
    const take = files.slice(0, Math.max(0, room)).filter(function (f) {
      const bad = WC.image.checkFile(f);
      if (bad) U.toast(bad, 'error');
      return !bad;
    });
    if (!take.length) return;
    const status = U.$('#photo-status');
    compressing += take.length;
    dirty = true;
    updateSaveState();
    renderPhotos();
    for (let i = 0; i < take.length; i++) {
      if (mySession !== session) return; // 視窗已關閉或換紀錄：中止
      status.textContent = '照片壓縮中… ' + (i + 1) + ' / ' + take.length + '（完成前無法送出）';
      let c = null;
      try {
        c = await WC.image.compress(take[i]);
      } catch (e) {
        if (mySession === session) U.toast(take[i].name + '：' + U.errMsg(e), 'error');
      }
      if (mySession !== session) { if (c) URL.revokeObjectURL(c.previewUrl); return; }
      compressing -= 1;
      if (c) {
        photos.push({
          key: 'k' + (++keySeq), kind: 'pending', previewUrl: c.previewUrl, b64: c.fullB64, thumbB64: c.thumbB64,
          w: c.w, h: c.h, note: U.fmtBytes(c.originalBytes) + ' → ' + U.fmtBytes(c.compressedBytes) + '（' + c.w + '×' + c.h + '）',
          meta: {}, up: 'wait', upErr: ''
        });
      }
      pumpUploads();   // v2.4 F1：壓縮好一張就排進背景上傳
      renderPhotos();
      updateFooter();
      updateSaveState();
      if (!U.$('#leave-ask').hidden) showLeaveAsk(); // 詢問畫面開著時，壓縮完成就讓「存成草稿」可按
    }
    status.textContent = '';
    updateUploadStatus();
  }

  // ---------- 背景上傳（v2.4 F1） ----------

  function captionHtml(p, i) {
    return (i === 0 ? '<span class="badge-cover">封面</span> ' : '') + uploadBadge(p) +
      (p.up === 'err' ? '<span class="ph-err">' + U.esc(p.upErr || '上傳失敗') + '</span> ' : '') + U.esc(p.note);
  }

  function retryHtml(p, i) {
    return p.kind === 'pending' && p.up === 'err'
      ? '<button type="button" data-ph="retry" class="ph-retry" aria-label="重新上傳第 ' + (i + 1) + ' 張照片"' + (busy ? ' disabled' : '') + '>重試</button>' : '';
  }

  /**
   * 只更新一張照片的狀態文字與「重試」鈕，不重畫整個照片區：
   * 老師正在打圖說或備註時，背景上傳完成不會讓輸入框失去焦點。
   */
  function patchPhoto(p) {
    const i = photos.indexOf(p);
    const fig = i < 0 ? null : U.$('#photo-grid .ph[data-key="' + p.key + '"]');
    if (!fig) return;
    const cap = fig.querySelector('figcaption');
    cap.innerHTML = captionHtml(p, i);
    const old = fig.querySelector('[data-ph="retry"]');
    const html = retryHtml(p, i);
    if (old && !html) old.remove();
    if (!old && html) cap.insertAdjacentHTML('afterend', html);
    const view = fig.querySelector('[data-ph="view"]');
    if (view) view.setAttribute('aria-label', '放大看第 ' + (i + 1) + ' 張（' + UPLOAD_LABEL[p.up || 'wait'] + '）照片');
  }

  const UPLOAD_LABEL = { wait: '待上傳', run: '上傳中…', done: '已上傳', err: '上傳失敗' };

  function uploadBadge(p) {
    if (p.kind !== 'pending') return '';
    const st = p.up || 'wait';
    return '<span class="badge-new up-' + st + '">' + UPLOAD_LABEL[st] + '</span> ';
  }

  /** 照片放進哪個月份資料夾：目前的活動日期（格式不對時用目前月份） */
  function uploadMonth() {
    const d = field('date').value;
    return /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(d) ? d.slice(0, 7) : WC.state.month;
  }

  /** 是否還有排隊中或上傳中的照片（只看目前視窗裡的照片；被移除的不算） */
  function uploadsBusy() {
    return photos.some(function (p) { return p.kind === 'pending' && ((p.up === 'wait' && p.b64) || p.up === 'run'); });
  }

  /** 開關視窗時：作廢這個 session 的上傳計數，叫醒還在等的人（等的人會比對 session 後放棄） */
  function resetUploads() {
    uploading = 0;
    photos.forEach(function (p) { p.counted = false; });
    const w = uploadWaiters; uploadWaiters = [];
    w.forEach(function (r) { r(); });
  }

  function waitUploads() {
    if (!uploadsBusy()) return Promise.resolve();
    return new Promise(function (resolve) { uploadWaiters.push(resolve); });
  }

  function checkUploadsIdle() {
    if (uploadsBusy()) return;
    const w = uploadWaiters; uploadWaiters = [];
    w.forEach(function (r) { r(); });
  }

  /** 從排隊中的照片依畫面順序開始上傳，同時最多 UPLOAD_PARALLEL 張 */
  function pumpUploads() {
    if (readOnly) return;
    while (uploading < UPLOAD_PARALLEL) {
      const next = photos.find(function (p) { return p.kind === 'pending' && p.up === 'wait' && p.b64; });
      if (!next) break;
      startUpload(next);
    }
    updateUploadStatus();
    checkUploadsIdle();
  }

  /**
   * v2.6（G4）：讓出這張照片佔的上傳名額。用每張照片的 counted 旗標確保只減一次
   * （上傳中被移除時立刻讓出；之後結果回來、或被復原，都不會再減）。
   */
  function releaseSlot(p) {
    if (!p.counted) return;
    p.counted = false;
    uploading = Math.max(0, uploading - 1);
  }
  function isShown(p) { return photos.indexOf(p) >= 0; }

  async function startUpload(p) {
    const mySession = session;
    p.up = 'run'; p.upErr = '';
    uploading += 1;
    p.counted = true;
    try {   // G4：uploading += 1 之後的所有程式都在 try/finally 內，任何例外都會讓出名額
      patchPhoto(p);
      let res = null, err = null;
      try {
        res = await WC.api.uploadPhoto(uploadMonth(), p.b64, p.thumbB64, p.w, p.h);
      } catch (e) { err = e; }
      if (mySession !== session) return; // 視窗已關閉或換了紀錄：結果丟棄，不會進到別筆紀錄
      // 已被移除的照片：結果只記在這張照片上（畫面不畫）；若之後按「復原」，就直接是上傳完成／失敗的狀態
      if (res && res.photo && res.photo.id && res.photo.thumbId) {
        p.photo = res.photo; p.up = 'done';
      } else {
        p.up = 'err';
        p.upErr = err ? U.errMsg(err) : '上傳失敗';
      }
      if (isShown(p)) patchPhoto(p);
    } finally {
      if (mySession === session) {
        releaseSlot(p);
        pumpUploads();
      }
    }
  }

  /** 「上傳照片 x / n」：x＝已完成、n＝這次加入的新照片數 */
  function uploadProgress() {
    const pend = photos.filter(function (p) { return p.kind === 'pending'; });
    const done = pend.filter(function (p) { return p.up === 'done'; }).length;
    const errs = pend.filter(function (p) { return p.up === 'err'; }).length;
    return { n: pend.length, done: done, errs: errs };
  }

  function updateUploadStatus() {
    if (compressing > 0) return; // 壓縮中的文字由 onFilesPicked 顯示
    const g = uploadProgress();
    const status = U.$('#photo-status');
    if (!g.n || (g.done === g.n)) { status.textContent = g.n ? '照片都已上傳（' + g.n + ' 張）' : ''; }
    else {
      status.textContent = '上傳照片 ' + g.done + ' / ' + g.n +
        (g.errs ? '（' + g.errs + ' 張失敗，請按照片上的「重試」或移除）' : '（可以先繼續填寫）');
    }
    if (busy && uploadsBusy()) U.$('#btn-save').textContent = '上傳照片 ' + g.done + ' / ' + g.n + '…';
  }

  function onPhotoTool(e) {
    const b = e.target.closest('[data-ph]');
    if (!b || (busy && b.getAttribute('data-ph') !== 'view')) return;
    const key = b.closest('.ph').getAttribute('data-key');
    const i = photos.findIndex(function (p) { return p.key === key; });
    if (i < 0) return;
    const act = b.getAttribute('data-ph');
    if (act === 'retry') {
      const p = photos[i];
      if (p.kind === 'pending' && p.up === 'err') { p.up = 'wait'; p.upErr = ''; patchPhoto(p); pumpUploads(); }
      const again = U.$('.ph[data-key="' + key + '"] [data-ph="view"]');
      if (again) again.focus();
      return;
    }
    if (act === 'view') {
      // 待上傳的照片用本機預覽圖；已存的用原圖。只讀，不改動 photos 陣列與排序
      const list = photos.map(function (p) {
        return p.kind === 'saved' && p.photo
          ? { thumbId: p.photo.thumbId, fullId: p.photo.id, caption: (p.meta && p.meta.caption) || '', note: (p.meta && p.meta.note) || '' }
          : { localUrl: p.previewUrl, fullB64: p.b64, caption: (p.meta && p.meta.caption) || '', note: (p.meta && p.meta.note) || '' };
      });
      WC.viewer.open(list, i, b, { title: field('title').value.trim() || autoTitle(), date: field('date').value });
      return;
    }
    if (act === 'remove') {
      if (lastRemoved) revokePreview(lastRemoved.item);
      lastRemoved = { item: photos.splice(i, 1)[0], index: i };
      releaseSlot(lastRemoved.item);   // G4：上傳中的照片被移除 → 名額立刻讓出，下一張馬上遞補（下面的 pumpUploads）
      U.$('#photo-undo').hidden = false;
    } else {
      const j = act === 'left' ? i - 1 : i + 1;
      if (j < 0 || j >= photos.length) return;
      const t = photos[i]; photos[i] = photos[j]; photos[j] = t;
    }
    dirty = true;
    renderPhotos();
    updateFooter();
    pumpUploads();   // 移除上傳中／排隊的照片後，更新進度與等待狀態
    // 鍵盤操作後焦點留在同一張照片的同一顆按鈕（或復原鈕）
    const sameKey = act === 'remove' ? null : U.$('.ph[data-key="' + key + '"] [data-ph="' + act + '"]');
    if (sameKey && !sameKey.disabled) sameKey.focus();
    else if (act === 'remove') U.$('#photo-undo').focus();
  }

  function undoRemove() {
    if (!lastRemoved) return;
    if (photos.length + compressing >= WC.state.config.maxPhotos) { U.toast('照片已達上限，無法復原', 'error'); return; }
    photos.splice(Math.min(lastRemoved.index, photos.length), 0, lastRemoved.item);
    lastRemoved = null;
    U.$('#photo-undo').hidden = true;
    renderPhotos();
    updateFooter();
    pumpUploads();   // 復原的照片若還沒上傳完，繼續排隊
  }

  // ---------- 拖放照片 ----------

  function bindDrop() {
    const b = box();
    let depth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
    b.addEventListener('dragenter', function (e) {
      if (!hasFiles(e) || readOnly) return;
      e.preventDefault(); depth += 1; b.classList.add('drag-over');
    });
    b.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = readOnly || busy ? 'none' : 'copy';
    });
    b.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) b.classList.remove('drag-over'); });
    b.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; b.classList.remove('drag-over');
      if (readOnly || busy) return;
      if (STEP_MQ.matches && step !== 1) goStep(1);
      onFilesPicked(e.dataTransfer.files);
    });
    // 視窗外誤放照片時，不讓瀏覽器直接打開圖片離開頁面
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  // ---------- 口述 ----------

  function setupSpeechUi() {
    const btn = U.$('#btn-speech');
    const note = U.$('#speech-note');
    if (!WC.speech.supported()) {
      btn.hidden = true;
      note.textContent = '這個瀏覽器不支援網頁口述；可以用手機鍵盤上的麥克風，或改用 Chrome／Edge。';
      return;
    }
    btn.hidden = readOnly;
    btn.textContent = '🎙 按這裡用說的';
    btn.classList.remove('rec-on');
    note.textContent = '語音由 Google 辨識（會送到 Google 伺服器），本系統不保存錄音。';
  }

  function toggleSpeech() {
    const btn = U.$('#btn-speech');
    const live = U.$('#speech-live');
    if (WC.speech.isActive()) { WC.speech.stop(); return; }
    WC.speech.start(field('rawText'), function (state, detail) {
      if (state === 'listening') { btn.textContent = '■ 說完了，停止'; btn.classList.add('rec-on'); live.textContent = '聆聽中…'; }
      if (state === 'interim') live.textContent = detail ? '…' + detail : '聆聽中…';
      if (state === 'error') U.toast(detail, 'error');
      if (state === 'stopped') { btn.textContent = '🎙 按這裡用說的'; btn.classList.remove('rec-on'); live.textContent = ''; }
    });
  }

  // ---------- 字數、頁尾、儲存鈕狀態 ----------

  /** 每個有 data-count-for 的計數元素顯示「目前／上限」，達 90% 變色提醒 */
  function updateCounters() {
    U.$all('[data-count-for]', form()).forEach(function (el) {
      const name = el.getAttribute('data-count-for');
      const len = Array.from(field(name).value).length, max = LIMITS[name];
      el.textContent = len + ' / ' + max;
      el.classList.toggle('near', len >= max * 0.9);
    });
  }

  function updateFooter() {
    const d = field('date').value;
    const m = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : '—';
    U.$('#editor-footer-info').textContent = '存到 ' + m + ' · ' + photos.length + ' 張照片' +
      (compressing ? '（另有 ' + compressing + ' 張壓縮中）' : '') + ' · Ctrl+Enter 送出';
  }

  function updateSaveState() {
    const save = U.$('#btn-save'), draft = U.$('#btn-draft');
    save.disabled = busy || compressing > 0;
    draft.disabled = busy || compressing > 0;
    if (!busy) save.textContent = compressing > 0 ? '照片壓縮中…' : saveLabel();
  }

  /**
   * 儲存／刪除進行中：停用整個表單（欄位、選照片、照片工具、口述、復原、步驟），避免途中被修改。
   * 結束時依唯讀規則恢復。
   */
  function setBusy(on, label) {
    busy = on;
    ['#btn-delete', '#btn-cancel', '#editor-close', '#btn-draft', '#btn-prev', '#btn-next', '#leave-save', '#leave-discard', '#leave-back']
      .forEach(function (s) { U.$(s).disabled = on; });
    U.$('#btn-save').textContent = on ? (label || '儲存中…') : saveLabel();
    U.$all('input, textarea, select', form()).forEach(function (el) { el.disabled = on || readOnly; });
    U.$all('#photo-grid button, #photo-undo, #btn-speech, .step-dot', U.$('#editor')).forEach(function (el) { el.disabled = on; });
    U.$('#photo-pick').classList.toggle('is-disabled', on);
    if (!on) renderPhotos(); // 重畫時會依張數恢復選照片按鈕與 ◀ ▶ 的停用狀態
    updateSaveState();
  }

  /** 依後端錯誤代碼產生給使用者的訊息（不比對文字） */
  function saveErrorMessage(err) {
    const code = err && err.code;
    if (code === 'PHOTO_EXPIRED') return '有照片已過期，請把顯示灰色的照片移除後重新加入。';
    if (code === 'PHOTO_TAKEN') return '有照片已屬於其他紀錄，請移除後重新加入。如果剛剛按過送出（網路慢或逾時），請先重新整理，看看是否已經存好。';   // G6
    if (code === 'UNIT_CHANGED') return '單元名稱剛被主編調整過，已更新單元選項；請重新選擇單元後再送出（已填的內容都還在）。';
    if (code === 'PHOTOS_BROKEN') return '照片資料損壞，請聯絡管理者。';
    if (code === 'PHOTO_NOT_YOURS') return '有照片是其他老師上傳、尚未存檔的，不能加入您的紀錄；請把它移除後，改用自己上傳的照片。';
    if (code === 'PHOTO_MISMATCH') return '有照片的原圖與縮圖不相符，請把它移除後重新加入。';
    if (code === 'CONFLICT') return '這筆紀錄已被其他人修改過，請關閉視窗、重新整理後再編輯。';
    return U.errMsg(err);
  }

  /**
   * mode：'send'（送出＝已確認；已定案的紀錄保留原狀態）、'draft'（草稿）、'keep'（保留原狀態，關閉詢問時用）
   * 主編在進階改過狀態時，一律以主編選的為準。
   */
  function finalStatus(mode) {
    if (isEditorRole()) {
      if (statusTouched) return field('status').value;
      if (mode === 'draft') return '草稿';
      if (current && (mode === 'keep' || FINAL.indexOf(current.status) >= 0 || current.status === '已確認')) return current.status;
      return mode === 'keep' ? '草稿' : '已確認';
    }
    // 非主編的最後防線（Gemini 審查）：只能送「草稿」或「已確認」，不論 current.status 為何
    if (mode === 'draft') return '草稿';
    if (mode === 'keep' && (!current || current.status === '草稿')) return '草稿';
    return '已確認';
  }

  function collect(mode) {
    let unit = unitValue();
    if (!unit) unit = WC.state.config.units[0];
    return {
      id: current ? current.id : '',
      title: field('title').value.trim() || autoTitle(),
      date: field('date').value,
      unit: unit,
      rawText: field('rawText').value,
      summary: field('summary').value,
      newsletter: field('newsletter').value,
      layout: layoutValue(),
      status: finalStatus(mode),
      unitConfirmed: !!unitValue(),     // v2.1：沒選單元就存草稿時記為未確認
      // v2.5：開啟時的單元。沒改單元而主編剛好改名／互換／搬移時，後端保留伺服器上的單元
      unitAtOpen: current ? current.unit : undefined,
      // v2.6（G1）：畫面上的設定版本。主編剛互換／位移改名、而我新增或改選了單元時，後端回 UNIT_CHANGED
      configVersion: WC.state.configVersion || undefined
    };
  }

  // ---------- 儲存／刪除 ----------

  async function save(mode) {
    if (busy || readOnly) return;
    if (compressing > 0) { U.toast('照片還在壓縮，請稍候再送出。', 'info'); return; }
    const stepsMode = STEP_MQ.matches;
    if (mode === 'send') {
      if (!photos.length && !field('rawText').value.trim()) {
        U.toast('請至少加一張照片，或寫幾句話。', 'error');
        if (stepsMode) goStep(1);
        return;
      }
      if (!unitValue()) {
        U.toast('請選一個家訊單元。', 'error');
        if (stepsMode) goStep(3);
        const first = U.$('#unit-options input');
        if (first) first.focus();
        return;
      }
    }
    if (!field('date').checkValidity()) {
      if (stepsMode) goStep(3);
      field('date').reportValidity();
      return;
    }
    const noUnit = !unitValue();
    WC.speech.stop();
    const mySession = session;
    const data = collect(mode);
    let saved = null;
    U.$('#leave-ask').hidden = true;
    setBusy(true);
    try {
      // 1. 背景上傳（v2.4 F1）：失敗的照片自動再試一次，然後只等還沒傳完的照片
      photos.forEach(function (p) { if (p.kind === 'pending' && p.up === 'err') { p.up = 'wait'; p.upErr = ''; } });
      pumpUploads();
      if (uploadsBusy()) {
        const g = uploadProgress();
        setBusy(true, '上傳照片 ' + g.done + ' / ' + g.n + '…');
        // v2.6（G4）：等照片上傳時可以「取消送出」：回到可編輯狀態，照片繼續在背景上傳，內容保留
        const cancelled = await new Promise(function (resolve) {
          cancelSend = function () { resolve(true); };
          waitUploads().then(function () { resolve(false); });
          U.$('#btn-cancel-send').hidden = false;
        });
        cancelSend = null;
        U.$('#btn-cancel-send').hidden = true;
        if (mySession !== session) return; // finally 會解除 busy
        if (cancelled) { U.toast('已取消送出。照片會繼續在背景上傳，內容都還在；準備好再按「送出」。', 'info'); return; }
      }
      // 2. 防呆：每一張新照片都要上傳成功（有原圖與縮圖 ID）才寫紀錄；有任何一張沒完成就不送出
      const notReady = photos.filter(function (p) {
        return !(p.photo && p.photo.id && p.photo.thumbId) || (p.kind === 'pending' && p.up !== 'done');
      });
      if (notReady.length) {
        const e = new Error('有 ' + notReady.length + ' 張照片上傳失敗，請按照片上的「重試」，或把它移除後再送出。');
        e.code = 'UPLOAD_INCOMPLETE';
        throw e;
      }
      // 3. 寫紀錄
      setBusy(true, '儲存紀錄…');
      data.photos = photos.map(function (p) { return withMeta(p.photo, p.meta); });
      saved = (await WC.api.saveRecord(data, current ? current.updatedAt : '')).record;
      if (mySession === session) {
        // 存檔成功：新照片的縮圖直接用本機預覽（不必再向後端下載），改成「已存」以免關閉視窗時被釋放
        photos.forEach(function (p) {
          if (p.kind !== 'pending') return;
          WC.photos.prime(p.photo.thumbId, p.previewUrl);
          p.kind = 'saved'; p.b64 = null; p.thumbB64 = null;
        });
      }
    } catch (err) {
      if (mySession === session && err && err.code === 'UNIT_CHANGED') {
        // v2.6（G1）：重新讀設定、重畫單元選項（清掉選取，請老師重新選）；其他已填內容保留
        try { await WC.app.refreshConfig(); } catch (e) { /* 讀不到就用舊清單，老師仍需重選 */ }
        if (mySession === session) {
          renderUnits('', false);
          updateTitlePlaceholder();
          if (STEP_MQ.matches) goStep(3);
        }
      }
      if (mySession === session) U.toast('儲存失敗：' + saveErrorMessage(err), 'error');
    } finally {
      setBusy(false);
      if (mySession === session && U.$('#unit-options input') && !unitValue() && STEP_MQ && document.activeElement === document.body) {
        const first = U.$('#unit-options input'); if (first) first.focus();
      }
    }
    if (saved && mySession === session) {
      U.clearToasts('error');   // 先前的「儲存失敗」已解決，收掉
      const verb = saved.status === '草稿' ? '已存成草稿' : saved.status === '已確認' && (!current || current.status === '草稿') ? '已送出' : '已儲存';
      U.toast(verb + '「' + saved.title + '」' + (noUnit ? '（未選單元，先放在「' + saved.unit + '」）' : ''), 'ok');
      // v2.1：要給家長看的文字有待補充或隱私字眼時，存檔後提醒（不擋；列印前確認框也會再列出）
      const issues = WC.printcheck.checkRecord(saved);
      if (issues.length) U.toast('提醒：這筆的家訊內容有 ' + issues.length + ' 處要處理後才適合印給家長——' + WC.printcheck.summary(issues), 'error');
      close(true);
      await WC.app.afterSave(saved);
    }
  }

  async function remove() {
    if (!current || busy) return;
    // 回測 Q3：改用頁內確認視窗（沿用設定頁的確認元件），不用原生 confirm()
    const okDel = await WC.settings.confirm({
      title: '刪除紀錄',
      html: '<p>確定要刪除「<b>' + U.esc(current.title) + '</b>」嗎？</p><p>照片也會一併移到雲端硬碟的垃圾桶（30 天內可由管理者救回）。</p>',
      okText: '刪除', danger: true, opener: U.$('#btn-delete')
    });
    if (!okDel || !current || busy) return;
    let ok = false;
    setBusy(true, '刪除中…');
    try {
      await WC.api.deleteRecord(current.id);
      ok = true;
    } catch (err) {
      U.toast('刪除失敗：' + U.errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
    if (ok) {
      U.toast('已刪除', 'ok');
      const id = current.id;
      close(true);
      await WC.app.afterDelete(id);
    }
  }

  function bind() {
    U.bindCharLimits(form());   // v2.1：標題、原始紀錄、摘要、文案、圖說、備註都以字元數限制
    U.$('#photo-meta').addEventListener('input', onMetaInput);
    form().addEventListener('submit', function (e) { e.preventDefault(); save('send'); });
    form().addEventListener('input', function (e) {
      if (e.target.type === 'file') return; // 照片實際加入時才算修改（被拒收的 HEIC 不算）
      dirty = true;
      const n = e.target.name;
      if (n === 'date') { updateFooter(); updateTitlePlaceholder(); }
      if (n === 'rawText') { updateTitlePlaceholder(); if (!layoutManual) renderLayouts(); if (WC.ai) WC.ai.refresh(); }
      if (n === 'summary' || n === 'newsletter') updateAdvPreview();
      if (LIMITS[n]) updateCounters();
    });
    form().addEventListener('change', function (e) {
      const n = e.target.name;
      if (n === 'date') { updateFooter(); updateTitlePlaceholder(); }
      if (n === 'unit') { dirty = true; updateTitlePlaceholder(); }
      if (n === 'layoutPick') { dirty = true; layoutManual = e.target.value; renderLayouts(); }
      if (n === 'status') { dirty = true; statusTouched = true; }
    });
    form().addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      // Ctrl／⌘＋Enter：任何欄位都可直接送出
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); if (!U.$('#btn-save').hidden) save('send'); return; }
      // 單行輸入框按 Enter 不送出表單（避免打字選字時誤存）
      if (e.target.tagName === 'INPUT' && e.target.type !== 'radio' && e.target.type !== 'file') e.preventDefault();
      if (e.target.type === 'radio') e.preventDefault();
    });
    U.$('#btn-cancel').addEventListener('click', function () { requestClose(); });
    U.$('#editor-close').addEventListener('click', function () { requestClose(); });
    U.$('#btn-draft').addEventListener('click', function () { save('draft'); });
    U.$('#btn-cancel-send').addEventListener('click', function () {
      if (!cancelSend) return;
      cancelSend();
      setTimeout(function () { const b = U.$('#btn-save'); if (b && !b.disabled) b.focus(); }, 0);
    });
    U.$('#btn-prev').addEventListener('click', function () { goStep(step - 1); });
    U.$('#btn-next').addEventListener('click', function () { goStep(step + 1); });
    U.$('.stepper').addEventListener('click', function (e) {
      const d = e.target.closest('[data-go]');
      if (d) goStep(Number(d.getAttribute('data-go')));
    });
    U.$('#leave-save').addEventListener('click', function () { save(current && current.status !== '草稿' ? 'keep' : 'draft'); });
    U.$('#leave-discard').addEventListener('click', function () { close(true); });
    U.$('#leave-back').addEventListener('click', hideLeaveAsk);
    U.$('#btn-delete').addEventListener('click', remove);
    U.$('#btn-speech').addEventListener('click', toggleSpeech);
    U.$('#photo-undo').addEventListener('click', undoRemove);
    U.$('#photo-input').addEventListener('change', function (e) {
      onFilesPicked(e.target.files);
      e.target.value = '';
    });
    U.$('#photo-grid').addEventListener('click', onPhotoTool);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !U.$('#editor').hidden && !WC.viewer.isOpen() && U.$('#set-confirm').hidden) { e.preventDefault(); requestClose(); }
    });
    // 旋轉平板或縮放視窗時，在逐步／並排間切換
    const onMq = function () { if (!U.$('#editor').hidden) applyStepMode(); };
    if (STEP_MQ.addEventListener) STEP_MQ.addEventListener('change', onMq); else STEP_MQ.addListener(onMq);
    bindDrop();
  }

  // ---------- 給 AI 模組（js/ai.js）用的介面（第 2 階段） ----------

  /** AI 需要的欄位（不含照片本身，只有張數與老師備註） */
  function aiInput() {
    return {
      title: field('title').value.trim(), date: field('date').value, unit: unitValue() || '',
      layout: layoutValue(), rawText: field('rawText').value,
      photoCount: photos.length,
      photoNotes: photos.map(function (p) { return String((p.meta && p.meta.note) || ''); })
    };
  }

  /** 目前摘要、文案、圖說是否已有內容（決定是否詢問覆蓋） */
  function aiHasContent() {
    return !!(field('summary').value.trim() || field('newsletter').value.trim() ||
      photos.some(function (p) { return p.meta && String(p.meta.caption || '').trim(); }));
  }

  /** 填入 AI 結果；onlyEmpty 時只填空白欄位。圖說依目前照片順序填入。不會直接存檔 */
  function aiApply(data, onlyEmpty) {
    const put = function (name, v) {
      if (v == null) return;
      if (onlyEmpty && field(name).value.trim()) return;
      field(name).value = String(v);
    };
    put('summary', data.summary);
    put('newsletter', data.newsletter);
    if (Array.isArray(data.captions)) {
      photos.forEach(function (p, i) {
        if (data.captions[i] == null) return;
        p.meta = p.meta || {};
        if (onlyEmpty && String(p.meta.caption || '').trim()) return;
        p.meta.caption = Array.from(String(data.captions[i])).slice(0, META_LIMITS.caption).join('');
      });
    }
    if (data.layoutUsed && !layoutManual && WC.state.config.layouts.indexOf(data.layoutUsed) >= 0) layoutManual = data.layoutUsed;
    dirty = true;
    U.$('#advanced').open = true;
    if (STEP_MQ.matches && step !== 3) goStep(3); // 手機逐步模式：進階區在第 3 步，跳過去讓老師看到結果
    renderPhotoMeta();
    renderLayouts();
    updateCounters();
    updateAdvPreview();
  }

  function aiCanUse() { return !readOnly && !busy && compressing === 0 && !!field('rawText').value.trim(); }

  /** 回測用：目前視窗內照片的上傳狀態（不含照片內容） */
  function _uploadState() {
    return { uploading: uploading, busy: busy, photos: photos.map(function (p) { return { kind: p.kind, up: p.up || '', id: p.photo ? p.photo.id : '' }; }) };
  }

  return { _uploadState: _uploadState, open: open, close: close, bind: bind, aiInput: aiInput, aiHasContent: aiHasContent, aiApply: aiApply, aiCanUse: aiCanUse };
})();
