/**
 * 「新增／編輯活動紀錄」視窗。
 *
 * 照片流程：選檔 → 立即在瀏覽器壓縮並顯示預覽（尚未上傳）→ 按「儲存」時才逐張上傳，
 * 全部上傳成功後才寫入紀錄。好處：按取消不會在 Drive 留下孤兒檔；照片會放進「最終活動日期」的月份資料夾。
 *
 * 開啟序號 session：每次 open／close 都遞增。非同步工作（壓縮、上傳）每做完一步都比對序號，
 * 不同代表視窗已關閉或換了另一筆紀錄，結果直接丟棄，不會跑進別筆紀錄。
 */
WC.editor = (function () {
  const U = WC.util;
  const LIMITS = { title: 60, rawText: 5000, summary: 500, newsletter: 2000 };
  let current = null;     // 編輯中的原始紀錄（新增時為 null）
  let photos = [];        // [{ key, kind:'saved'|'pending', photo?, previewUrl, b64?, thumbB64?, w, h, note }]
  let readOnly = false;
  let dirty = false;
  let busy = false;       // 儲存／刪除進行中
  let compressing = 0;    // 壓縮中的張數
  let session = 0;
  let keySeq = 0;
  let lastRemoved = null; // { item, index }：供「復原」用

  function form() { return U.$('#editor-form'); }
  function field(name) { return form().elements[name]; }

  /** items 中沒有 value 時，補一個「（舊值）」選項，避免舊紀錄的值被默默換掉 */
  function fillSelect(sel, items, value) {
    const list = items.slice();
    const legacy = value && list.indexOf(value) < 0;
    if (legacy) list.push(value);
    sel.innerHTML = list.map(function (v) {
      const label = legacy && v === value ? v + '（舊值）' : v;
      return '<option value="' + U.esc(v) + '"' + (v === value ? ' selected' : '') + '>' + U.esc(label) + '</option>';
    }).join('');
  }

  /** 開啟視窗；rec 省略＝新增 */
  function open(rec) {
    const cfg = WC.state.config;
    session += 1;
    compressing = 0;
    current = rec || null;
    // 照片資料損壞的紀錄一律唯讀：後端會拒絕存檔，避免把照片清單覆蓋成空的
    readOnly = !!(rec && (!rec.canEdit || rec.photosBroken));
    dirty = false;
    lastRemoved = null;

    U.$('#editor-title').textContent = !rec ? '新增活動紀錄' : readOnly ? '檢視活動紀錄' : '編輯活動紀錄';
    field('title').value = rec ? rec.title : '';
    field('date').value = rec ? rec.date : defaultDate();
    fillSelect(field('unit'), cfg.units, rec ? rec.unit : (WC.state.filterUnit || cfg.units[0]));
    field('rawText').value = rec ? rec.rawText : '';
    field('summary').value = rec ? rec.summary : '';
    field('newsletter').value = rec ? rec.newsletter : '';
    fillSelect(field('layout'), [''].concat(cfg.layouts), rec ? rec.layout : '');
    field('layout').options[0].textContent = '（尚未決定）';
    fillSelect(field('status'), ['草稿', '已確認', '已採用', '不採用'], rec ? rec.status : '草稿');

    photos = (rec ? rec.photos : []).map(function (p) {
      return { key: 'k' + (++keySeq), kind: 'saved', photo: p, w: p.w, h: p.h, note: '' };
    });

    U.$all('input, textarea, select', form()).forEach(function (el) { el.disabled = readOnly; });
    applyStatusRules();
    U.$('#btn-save').hidden = readOnly;
    U.$('#btn-delete').hidden = !rec || readOnly;
    U.$('#photo-pick').hidden = readOnly;
    const author = U.$('#editor-author');
    author.textContent = rec ? '投稿：' + rec.authorName + '（' + rec.authorEmail + '）' : '';
    author.hidden = !rec;
    const broken = !!(rec && rec.photosBroken);
    U.$('#editor-broken-note').hidden = !broken;
    U.$('#editor-readonly-note').hidden = !readOnly || broken;
    U.$('#photo-undo').hidden = true;

    setupSpeechUi();
    renderPhotos();
    updateCounters();
    updateFooter();
    updateAiButton();
    updateSaveState();
    U.$('#editor').hidden = false;
    document.body.classList.add('modal-open');
    field('title').focus();
  }

  /** 新增時的預設日期：今天若在目前月份就用今天，否則用該月 1 日 */
  function defaultDate() {
    const t = U.todayStr();
    return t.slice(0, 7) === WC.state.month ? t : WC.state.month + '-01';
  }

  function close(force) {
    if (busy) return;
    if (!force && (dirty || compressing) && !confirm('有尚未儲存的修改，確定要關閉嗎？')) return;
    session += 1;        // 讓進行中的壓縮結果作廢
    compressing = 0;
    WC.speech.stop();
    photos.forEach(revokePreview);
    if (lastRemoved) revokePreview(lastRemoved.item);
    photos = [];
    lastRemoved = null;
    U.$('#photo-status').textContent = '';
    U.$('#editor').hidden = true;
    document.body.classList.remove('modal-open');
  }

  function revokePreview(p) { if (p && p.kind === 'pending' && p.previewUrl) URL.revokeObjectURL(p.previewUrl); }

  // ---------- 照片 ----------

  function renderPhotos() {
    const max = WC.state.config.maxPhotos;
    const box = U.$('#photo-grid');
    box.innerHTML = photos.map(function (p, i) {
      const img = p.kind === 'saved'
        ? '<img data-photo-id="' + U.esc(p.photo.thumbId) + '" alt="活動照片 ' + (i + 1) + '">'
        : '<img src="' + U.esc(p.previewUrl) + '" alt="新照片 ' + (i + 1) + '">';
      return '<figure class="ph" data-key="' + p.key + '">' + img +
        '<figcaption>' + (p.kind === 'pending' ? '<span class="badge-new">待上傳</span> ' : '') + U.esc(p.note) + '</figcaption>' +
        (readOnly ? '' : '<div class="ph-tools">' +
          '<button type="button" data-ph="left" title="往前移" aria-label="往前移"' + (i === 0 ? ' disabled' : '') + '>◀</button>' +
          '<button type="button" data-ph="right" title="往後移" aria-label="往後移"' + (i === photos.length - 1 ? ' disabled' : '') + '>▶</button>' +
          '<button type="button" data-ph="remove" class="ph-remove" title="移除" aria-label="移除這張照片">✕</button></div>') +
        '</figure>';
    }).join('');
    U.$('#photo-count').textContent = (photos.length + compressing) + ' / ' + max + ' 張';
    U.$('#photo-input').disabled = readOnly || photos.length + compressing >= max;
    WC.photos.hydrate(box);
  }

  async function onFilesPicked(fileList) {
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
    updateSaveState();
    renderPhotos();
    for (let i = 0; i < take.length; i++) {
      if (mySession !== session) return; // 視窗已關閉或換紀錄：中止
      status.textContent = '照片壓縮中… ' + (i + 1) + ' / ' + take.length + '（完成前無法儲存）';
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
          w: c.w, h: c.h, note: U.fmtBytes(c.originalBytes) + ' → ' + U.fmtBytes(c.compressedBytes) + '（' + c.w + '×' + c.h + '）'
        });
        dirty = true;
      }
      renderPhotos();
      updateFooter();
      updateSaveState();
    }
    status.textContent = '';
  }

  function onPhotoTool(e) {
    const b = e.target.closest('[data-ph]');
    if (!b) return;
    const key = b.closest('.ph').getAttribute('data-key');
    const i = photos.findIndex(function (p) { return p.key === key; });
    if (i < 0) return;
    const act = b.getAttribute('data-ph');
    if (act === 'remove') {
      if (lastRemoved) revokePreview(lastRemoved.item);
      lastRemoved = { item: photos.splice(i, 1)[0], index: i };
      U.$('#photo-undo').hidden = false;
    } else {
      const j = act === 'left' ? i - 1 : i + 1;
      if (j < 0 || j >= photos.length) return;
      const t = photos[i]; photos[i] = photos[j]; photos[j] = t;
    }
    dirty = true;
    renderPhotos();
    updateFooter();
  }

  function undoRemove() {
    if (!lastRemoved) return;
    if (photos.length + compressing >= WC.state.config.maxPhotos) { U.toast('照片已達上限，無法復原', 'error'); return; }
    photos.splice(Math.min(lastRemoved.index, photos.length), 0, lastRemoved.item);
    lastRemoved = null;
    U.$('#photo-undo').hidden = true;
    renderPhotos();
    updateFooter();
  }

  // ---------- 口述 ----------

  function setupSpeechUi() {
    const btn = U.$('#btn-speech');
    const note = U.$('#speech-note');
    if (!WC.speech.supported()) {
      btn.hidden = true;
      note.textContent = '這個瀏覽器不支援口述，請改用電腦版 Chrome 或 Edge。';
      return;
    }
    btn.hidden = readOnly;
    btn.textContent = '🎙 開始口述';
    btn.classList.remove('rec-on');
    note.textContent = '口述會由 Google 語音服務辨識（語音會送到 Google 伺服器），本系統不保存錄音。';
  }

  function toggleSpeech() {
    const btn = U.$('#btn-speech');
    const live = U.$('#speech-live');
    if (WC.speech.isActive()) { WC.speech.stop(); return; }
    WC.speech.start(field('rawText'), function (state, detail) {
      if (state === 'listening') { btn.textContent = '■ 停止口述'; btn.classList.add('rec-on'); live.textContent = '聆聽中…'; }
      if (state === 'interim') live.textContent = detail ? '…' + detail : '聆聽中…';
      if (state === 'error') U.toast(detail, 'error');
      if (state === 'stopped') { btn.textContent = '🎙 開始口述'; btn.classList.remove('rec-on'); live.textContent = ''; }
    });
  }

  // ---------- AI（第 2 階段） ----------

  function updateAiButton() {
    const btn = U.$('#btn-ai');
    btn.disabled = true; // 第 1 階段一律不可按
    btn.title = field('rawText').value.trim()
      ? 'AI 整理將在第 2 階段開放'
      : '請先填寫原始紀錄（AI 整理將在第 2 階段開放）';
  }

  // ---------- 字數、頁尾、儲存鈕狀態 ----------

  /** 每個有 data-count-for 的計數元素顯示「目前／上限」，達 90% 變色提醒 */
  function updateCounters() {
    U.$all('[data-count-for]', form()).forEach(function (el) {
      const name = el.getAttribute('data-count-for');
      const len = field(name).value.length, max = LIMITS[name];
      el.textContent = len + ' / ' + max;
      el.classList.toggle('near', len >= max * 0.9);
    });
  }

  function updateFooter() {
    const d = field('date').value;
    const m = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 7) : '—';
    U.$('#editor-footer-info').textContent = '儲存至 ' + m + ' · ' + photos.length + ' 張照片' +
      (compressing ? '（另有 ' + compressing + ' 張壓縮中）' : '');
  }

  function updateSaveState() {
    const btn = U.$('#btn-save');
    btn.disabled = busy || compressing > 0;
    if (!busy) btn.textContent = compressing > 0 ? '照片壓縮中…' : '儲存';
  }

  /**
   * 儲存／刪除進行中：停用整個表單（欄位、選照片、照片工具、口述、復原），避免途中被修改。
   * 結束時依唯讀與角色規則恢復。
   */
  function setBusy(on, label) {
    busy = on;
    U.$('#btn-delete').disabled = on;
    U.$('#btn-cancel').disabled = on;
    U.$('#editor-close').disabled = on;
    U.$('#btn-save').textContent = on ? (label || '儲存中…') : '儲存';
    U.$all('input, textarea, select', form()).forEach(function (el) { el.disabled = on || readOnly; });
    U.$all('#photo-grid button, #photo-undo, #btn-speech', U.$('#editor')).forEach(function (el) { el.disabled = on; });
    U.$('#photo-pick').classList.toggle('is-disabled', on);
    if (!on) {
      applyStatusRules();
      renderPhotos(); // 重畫時會依張數恢復選照片按鈕與 ◀ ▶ 的停用狀態
    }
    updateSaveState();
  }

  /** 老師不能設「已採用／不採用」（主編定案用） */
  function applyStatusRules() {
    if (readOnly) return;
    const me = WC.state.me;
    Array.prototype.forEach.call(field('status').options, function (o) {
      o.disabled = me.role !== '主編' && (o.value === '已採用' || o.value === '不採用');
    });
  }

  /** 依後端錯誤代碼產生給使用者的訊息（不比對文字） */
  function saveErrorMessage(err) {
    const code = err && err.code;
    if (code === 'PHOTO_EXPIRED') return '有照片已過期，請把顯示灰色的照片移除後重新加入。';
    if (code === 'PHOTO_TAKEN') return '有照片已屬於其他紀錄，請移除後重新加入。';
    if (code === 'PHOTOS_BROKEN') return '照片資料損壞，請聯絡管理者。';
    if (code === 'PHOTO_NOT_YOURS') return '有照片是其他老師上傳、尚未存檔的，不能加入您的紀錄；請把它移除後，改用自己上傳的照片。';
    if (code === 'PHOTO_MISMATCH') return '有照片的原圖與縮圖不相符，請把它移除後重新加入。';
    if (code === 'CONFLICT') return '這筆紀錄已被其他人修改過，請關閉視窗、重新整理後再編輯。';
    return U.errMsg(err);
  }

  function collect() {
    return {
      id: current ? current.id : '',
      title: field('title').value.trim(),
      date: field('date').value,
      unit: field('unit').value,
      rawText: field('rawText').value,
      summary: field('summary').value,
      newsletter: field('newsletter').value,
      layout: field('layout').value,
      status: field('status').value
    };
  }

  // ---------- 儲存／刪除 ----------

  async function save(e) {
    e.preventDefault();
    if (busy || readOnly) return;
    if (compressing > 0) { U.toast('照片還在壓縮，請稍候再儲存。', 'info'); return; }
    if (!form().reportValidity()) return;
    WC.speech.stop();
    const mySession = session;
    const data = collect();
    const month = data.date.slice(0, 7);
    let saved = null;
    setBusy(true);
    try {
      // 1. 逐張上傳待上傳照片（失敗就停；已上傳的改成 saved，重按儲存不會重傳）
      const pending = photos.filter(function (p) { return p.kind === 'pending' && p.b64; });
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        setBusy(true, '上傳照片 ' + (i + 1) + ' / ' + pending.length + '…');
        const res = await WC.api.uploadPhoto(month, p.b64, p.thumbB64, p.w, p.h);
        if (mySession !== session) return; // finally 會解除 busy
        WC.photos.prime(res.photo.thumbId, p.previewUrl);
        p.kind = 'saved'; p.photo = res.photo; p.b64 = null; p.thumbB64 = null;
      }
      // 2. 寫紀錄（防呆：只送已有檔案 ID 的照片）
      setBusy(true, '儲存紀錄…');
      data.photos = photos.filter(function (p) { return p.photo && p.photo.id; }).map(function (p) { return p.photo; });
      saved = (await WC.api.saveRecord(data, current ? current.updatedAt : '')).record;
    } catch (err) {
      if (mySession === session) U.toast('儲存失敗：' + saveErrorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
    if (saved && mySession === session) {
      U.toast('已儲存「' + saved.title + '」', 'ok');
      close(true);
      await WC.app.afterSave(saved);
    }
  }

  async function remove() {
    if (!current || busy) return;
    if (!confirm('確定要刪除「' + current.title + '」嗎？照片也會一併移到 Drive 垃圾桶（30 天內可由管理者救回）。')) return;
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
      close(true);
      await WC.app.reload();
    }
  }

  function bind() {
    form().addEventListener('submit', save);
    form().addEventListener('input', function (e) {
      dirty = true;
      if (e.target.name === 'date') updateFooter();
      if (e.target.name === 'rawText') updateAiButton();
      if (LIMITS[e.target.name]) updateCounters();
    });
    form().addEventListener('change', function (e) { if (e.target.name === 'date') updateFooter(); });
    // 單行輸入框按 Enter 不送出表單（避免打字選字時誤存）
    form().addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
    });
    U.$('#btn-cancel').addEventListener('click', function () { close(false); });
    U.$('#editor-close').addEventListener('click', function () { close(false); });
    U.$('#btn-delete').addEventListener('click', remove);
    U.$('#btn-speech').addEventListener('click', toggleSpeech);
    U.$('#photo-undo').addEventListener('click', undoRemove);
    U.$('#photo-input').addEventListener('change', function (e) {
      onFilesPicked(e.target.files);
      e.target.value = '';
    });
    U.$('#photo-grid').addEventListener('click', onPhotoTool);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !U.$('#editor').hidden) close(false);
    });
  }

  return { open: open, close: close, bind: bind };
})();
