/**
 * 示範模式：在瀏覽器記憶體裡模擬 GAS 後端（含權限規則），方便不接後端先看畫面與回測。
 * 資料重新整理頁面就清空；照片存在記憶體（data URL），不會上傳到任何地方。
 *
 * 權限規則與 gas/Code.gs 一致：
 *   - 主編可改、可刪全部紀錄，可設任何狀態
 *   - 老師只能改、刪自己投稿且狀態為「草稿／已確認」的紀錄，只能設「草稿／已確認」
 * 頁首有「示範身分」切換，可測兩種角色。
 */
WC.demo = (function () {
  const USERS = {
    editor: { email: 'editor@demo.tw', name: '王老師', role: '主編' },
    teacher: { email: 'teacher@demo.tw', name: '林老師', role: '老師' }
  };
  const CONFIG = {
    className: '白雲班',
    newsletterName: '白雲家訊',
    footer: '白雲班的每一天，都值得記錄。',
    units: ['主題課程', '生活與探索', '學習區 A', '學習區 B', '體能活動', '白雲大小事'],
    layouts: ['故事版', '相簿版', '探索版'],
    maxPhotos: 20,
    emptyText: ''
  };
  // v2.5：與 GAS 相同的設定上限、單元別名（舊名 → 新名，改名或刪除搬移時記下）
  const LIMIT_MAX_PHOTOS = 20;
  const SETTINGS_LIMITS = { unitName: 12, unitsMin: 1, unitsMax: 12, className: 20, newsletterName: 20, footer: 60, emptyText: 100 };
  const unitAliases = Object.create(null);
  let unitChanges = [];   // v2.6（G1；複核 R2）：7 天內每次設定修改的改名對照 [{ names, at }]（最多 20 次）
  function unitChangeNames() {
    const now = Date.now();
    unitChanges = unitChanges.filter(function (c) { return now - c.at < 7 * 24 * 3600 * 1000; });
    const out = [];
    unitChanges.forEach(function (c) { c.names.forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); });
    return out;
  }
  // 與 GAS 相同的字元規則（C0、DEL、C1、雙向控制、行／段分隔；單元名稱另擋填充字）
  const CTRL_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
  const UNIT_BAD_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800\u180E]/;
  const UNIT_HAS_LETTER_RE = /[\p{L}\p{N}]/u;   // v2.6（G3）
  const UNIT_RESERVED = ['__proto__', 'constructor', 'prototype'];
  const TEACHER_STATUSES = ['草稿', '已確認'];
  let demoResponseLimit = 6 * 1024 * 1024; // 模擬 getPhotos 回應上限；回測可用 WC.demo.setResponseLimit() 調小
  const STATUSES = ['草稿', '已確認', '已採用', '不採用'];

  // v2.6：模擬成員表（規則與 gas/Code.gs 的 readMembers_、planMember_、actionSaveMember_ 相同）。
  // 每個請求都依「目前示範身分的 Email」重新查成員表決定姓名與角色，所以停用、降級後下一個請求就生效。
  const members = [
    { email: USERS.editor.email, name: USERS.editor.name, role: '主編', active: true },
    { email: USERS.teacher.email, name: USERS.teacher.name, role: '老師', active: true },
    { email: 'editor2@demo.tw', name: '陳老師', role: '主編', active: true }
  ];
  let currentEmail = USERS.editor.email;
  let currentUser = USERS.editor;
  const records = [];
  const photoStore = {}; // fileId → data URL
  // 模擬 Drive 檔案的反向標記（說明欄）：fileId → { recordId, kind:'full'|'thumb', base, created, w, h }
  const photoMeta = {};
  let seq = 0;

  function newId(prefix) { seq += 1; return prefix + '-' + Date.now().toString(36) + '-' + seq; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** 用 SVG 畫一張色塊假照片（不需要網路） */
  function fakePhoto(label, color) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="400" height="300" fill="' + color + '"/>' +
      '<circle cx="320" cy="70" r="36" fill="#fff8e1" opacity=".9"/>' +
      '<path d="M0 240 Q100 180 200 230 T400 220 V300 H0Z" fill="#ffffff" opacity=".55"/>' +
      '<text x="200" y="165" font-size="30" text-anchor="middle" fill="#37474f" font-family="sans-serif">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function addFakePhotos(labels) {
    const colors = ['#bbdefb', '#ffe0b2', '#fff59d', '#c8e6c9', '#f8bbd0', '#d1c4e9'];
    return labels.map(function (label, i) {
      const id = newId('demo-photo'), thumbId = newId('demo-thumb');
      const url = fakePhoto(label, colors[i % colors.length]);
      photoStore[id] = url;
      photoStore[thumbId] = url;
      registerPhoto(id, thumbId, 400, 300);
      return { id: id, thumbId: thumbId, w: 400, h: 300 };
    });
  }

  function seed() {
    const m = WC.util.currentMonth();
    const now = new Date().toISOString();
    const base = [
      ['主題課程', m + '-03', '秋天的落葉拼貼', '今天帶孩子到校園撿落葉，回教室分類顏色和形狀，做成拼貼畫。', '已採用', '故事版', ['落葉 1'], 'editor'],
      ['生活與探索', m + '-04', '自己的餐具自己洗', '午餐後練習洗碗，大家輪流排隊。', '已確認', '相簿版', ['洗碗 1', '洗碗 2', '洗碗 3'], 'teacher'],
      ['學習區 A', m + '-05', '積木高塔挑戰', '嘗試蓋到一公尺高，倒了三次後發現底座要寬。', '草稿', '探索版', ['積木 1', '積木 2'], 'teacher'],
      ['體能活動', m + '-06', '跳繩小達人', '今天練習雙腳跳。', '已採用', '相簿版', ['跳繩 1', '跳繩 2', '跳繩 3', '跳繩 4'], 'editor'],
      ['白雲大小事', m + '-07', '小天的生日會', '一起唱生日歌、分享蛋糕。', '不採用', '故事版', [], 'editor']
    ];
    base.forEach(function (b) {
      const u = USERS[b[7]];
      records.push({
        id: newId('demo-rec'), month: m, date: b[1], unit: b[0], title: b[2], rawText: b[3],
        summary: '', newsletter: b[4] === '已採用' ? b[3] + '孩子們都很投入，回家可以問問他們今天的發現喔！' : '',
        layout: b[5], status: b[4], photos: addFakePhotos(b[6]),
        authorEmail: u.email, authorName: u.name, createdAt: now, updatedAt: now
      });
      tagPhotos(records[records.length - 1]);
    });
  }

  /** 回測用：把某筆紀錄標成「照片資料損壞」（模擬有人手改試算表的照片JSON 欄） */
  let createdSeq = 0;
  /** 模擬上傳：原圖與縮圖共用檔名 base，標記尚未屬於任何紀錄 */
  function registerPhoto(id, thumbId, w, h) {
    const base = 'demo_' + (++createdSeq);
    const uploader = currentUser.email;
    photoMeta[id] = { recordId: '', kind: 'full', base: base, created: createdSeq, w: w, h: h, uploader: uploader };
    photoMeta[thumbId] = { recordId: '', kind: 'thumb', base: base, created: createdSeq, w: w, h: h, uploader: uploader };
  }

  /** 與 GAS tagPhotosForRecord_ 相同：存檔後替照片寫上紀錄 ID */
  function tagPhotos(rec) {
    rec.photos.forEach(function (ph) {
      [ph.id, ph.thumbId].forEach(function (fid) { if (photoMeta[fid]) photoMeta[fid].recordId = rec.id; });
    });
  }

  /** 與 GAS 相同：照片從紀錄移除或紀錄刪除時，清除標記並從「Drive」移除 */
  function untagAndTrash(fileIds, recordId) {
    fileIds.forEach(function (fid) {
      const m = photoMeta[fid];
      if (!m) return;
      const owner = m.recordId && records.some(function (r) { return r.id === m.recordId; });
      if (m.recordId && m.recordId !== recordId && owner) return; // 屬於別筆仍存在的紀錄，不丟
      delete photoMeta[fid];
      delete photoStore[fid];
    });
  }

  /** 回測用：把某筆紀錄標成「照片資料損壞」（模擬有人清空或改壞試算表的照片JSON 欄）；照片檔與標記仍在 */
  function markBroken(title) {
    const r = records.find(function (x) { return x.title.indexOf(title) >= 0; });
    if (r) { r.photosBroken = true; r.photos = []; } // 與 GAS 相同：損壞時照片清單讀不出來
    return !!r;
  }

  /**
   * 回測用：模擬 repairBrokenPhotosApply()。依反向標記重建損壞紀錄的照片清單
   * （原圖配對縮圖、依建立順序、最多 maxPhotos 張）。回傳 [{ title, photos }]；重建後請切換一次示範身分重新載入。
   */
  function repair() {
    const out = [];
    records.forEach(function (r) {
      if (!r.photosBroken) return;
      const fulls = {}, thumbs = {};
      Object.keys(photoMeta).forEach(function (fid) {
        const m = photoMeta[fid];
        if (m.recordId !== r.id) return;
        (m.kind === 'full' ? fulls : thumbs)[m.base] = { id: fid, m: m };
      });
      const bases = Object.keys(fulls).filter(function (b) { return thumbs[b]; })
        .sort(function (a, b) { return fulls[a].m.created - fulls[b].m.created; })
        .slice(0, CONFIG.maxPhotos);
      r.photos = bases.map(function (b) { return { id: fulls[b].id, thumbId: thumbs[b].id, w: fulls[b].m.w, h: fulls[b].m.h }; });
      r.photosBroken = false;
      r.updatedAt = new Date(Date.parse(r.updatedAt) + 1).toISOString();
      out.push({ title: r.title, photos: r.photos.length });
    });
    return out;
  }

  function canEdit(rec) {
    if (currentUser.role === '主編') return true;
    return rec.authorEmail === currentUser.email && TEACHER_STATUSES.indexOf(rec.status) >= 0;
  }
  function decorate(rec) { const r = clone(rec); r.canEdit = canEdit(rec); r.photosBroken = !!rec.photosBroken; return r; }

  /** 與 GAS isRealDate_ 相同 */
  function isRealDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return false;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }

  /** 與 GAS 相同：同一筆紀錄內重複的照片只保留第一次 */
  function dedupePhotos(list) {
    const seen = {};
    return list.filter(function (p) {
      if (seen[p.id] || seen[p.thumbId]) return false;
      seen[p.id] = true; seen[p.thumbId] = true;
      return true;
    }).map(function (p, i) { return photoExtras(p, { id: p.id, thumbId: p.thumbId, w: p.w, h: p.h }, i + 1); });
  }

  /** 與 GAS sanitizePhotoExtras_ 相同：caption ≤40、note ≤100（超過回 BAD_REQUEST）、fx／fy 0–1 */
  function photoExtras(ph, out, no) {
    const text = function (v, max, label) {
      const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
      if (Array.from(s).length > max) fail('BAD_REQUEST', (no ? '第 ' + no + ' 張' : '') + label + '最多 ' + max + ' 字');
      return s;
    };
    const cap = text(ph.caption, 40, '照片圖說'), note = text(ph.note, 100, '照片備註');
    if (cap) out.caption = cap;
    if (note) out.note = note;
    ['fx', 'fy'].forEach(function (k) {
      const v = ph[k];
      if (v == null || v === '') return;
      const n = Number(v);
      if (isFinite(n) && n >= 0 && n <= 1) out[k] = Math.round(n * 1000) / 1000;
    });
    return out;
  }

  function validate(r) {
    const title = String(r.title || '').trim();
    if (!title) fail('BAD_REQUEST', '請填寫標題');
    if (Array.from(title).length > 60) fail('BAD_REQUEST', '標題最多 60 字');
    if (!isRealDate(r.date)) fail('BAD_REQUEST', '活動日期不正確（格式應為 YYYY-MM-DD，且必須是存在的日期）');
    const old = r.id ? records.find(function (x) { return x.id === r.id; }) : null;
    // 與 GAS keepServerUnit_ 相同：沒改單元、但這筆已被主編改名／互換／搬移 → 保留目前的單元
    const sent = String(r.unit || '');
    const atOpen = typeof r.unitAtOpen === 'string' ? r.unitAtOpen : null;
    // v2.6（G1）：與 GAS unitChangedSinceOpen_ 相同
    if (typeof r.configVersion === 'string' && r.configVersion && r.configVersion !== configVersion() &&
        unitChangeNames().indexOf(sent) >= 0 && CONFIG.units.indexOf(sent) >= 0 && (!old || sent !== atOpen)) {   // 複核 R2、R3
      fail('UNIT_CHANGED', '單元名稱剛被主編調整過，請重新選擇單元後再送出（已填的內容都還在）。');
    }
    const unit = resolveRecordUnit(old && atOpen !== null && sent === atOpen && old.unit !== atOpen ? old.unit : sent, old);
    if (r.layout && CONFIG.layouts.indexOf(r.layout) < 0 && !(old && old.layout === r.layout)) fail('BAD_REQUEST', '偏好版型不在設定表的版型清單內');
    if (STATUSES.indexOf(r.status) < 0) fail('BAD_REQUEST', '處理狀態不正確');
    if (Array.from(String(r.rawText || '')).length > 5000) fail('BAD_REQUEST', '原始紀錄最多 5000 字');
    if (Array.from(String(r.summary || '')).length > 500) fail('BAD_REQUEST', '活動摘要最多 500 字');
    if (Array.from(String(r.newsletter || '')).length > 2000) fail('BAD_REQUEST', '家訊文案最多 2000 字');
    if ((r.photos || []).length > CONFIG.maxPhotos) fail('BAD_REQUEST', '每筆紀錄最多 ' + CONFIG.maxPhotos + ' 張照片');
    if (currentUser.role !== '主編' && TEACHER_STATUSES.indexOf(r.status) < 0) {
      fail('FORBIDDEN', '「' + r.status + '」狀態只有主編可以設定。');
    }
    return {
      id: r.id || '', month: r.date.slice(0, 7), date: r.date, unit: unit, title: title,
      rawText: String(r.rawText || '').trim(), summary: String(r.summary || '').trim(),
      newsletter: String(r.newsletter || '').trim(), layout: r.layout || '', status: r.status,
      photos: dedupePhotos(r.photos || []),
      unitConfirmed: r.status !== '草稿' ? true   // 與 GAS 相同（v2.2 L2：沒帶欄位保留舊值）
        : r.unitConfirmed === undefined ? !(r.id && records.some(function (x) { return x.id === r.id && x.unitConfirmed === false; }))
        : r.unitConfirmed !== false
    };
  }

  /** 與 GAS 相同：照片必須存在，且不能屬於別筆紀錄 */
  function checkPhotoOwnership(clean, old) {
    clean.photos.forEach(function (ph) {
      [ph.id, ph.thumbId].forEach(function (fid) {
        if (!photoStore[fid]) fail('PHOTO_EXPIRED', '照片已過期或不在白雲家訊照片資料夾內，請移除後重新加入。');
        // 與 GAS 相同：照片標記指向另一筆仍存在的紀錄（即使那筆照片JSON 損壞）就不能挪用
        const m = photoMeta[fid];
        const mine = old && old.photos.some(function (x) { return x.id === fid || x.thumbId === fid; });
        const ownerExists = m && m.recordId && records.some(function (r) { return r.id === m.recordId; });
        if (!mine && m && m.recordId && m.recordId !== (old ? old.id : '') && ownerExists) {
          fail('PHOTO_TAKEN', '照片已屬於其他紀錄，請移除後重新加入。如果剛剛按過送出（網路慢或逾時），請先重新整理，看看是否已經存好。');
        }
        // 與 GAS 相同：無主照片（未標記或所屬紀錄已刪除）只有上傳者本人或主編能用
        if (!mine && m && (!m.recordId || !ownerExists) && currentUser.role !== '主編' && m.uploader !== currentUser.email) {
          fail('PHOTO_NOT_YOURS', '有照片是其他老師剛上傳、尚未存檔的，不能加入您的紀錄。');
        }
        records.forEach(function (r) {
          if (old && r.id === old.id) return;
          r.photos.forEach(function (x) { if (x.id === fid || x.thumbId === fid) fail('PHOTO_TAKEN', '照片已屬於其他紀錄，請移除後重新加入。如果剛剛按過送出（網路慢或逾時），請先重新整理，看看是否已經存好。'); });
        });
      });
    });
  }

  // ---------- 示範 AI（第 2 階段；v2.4 起不使用名單、不去名化）：不連網，只重組原文的句子 ----------
  let demoAiCalls = 0;
  let demoAiNext = null; // 回測用：指定下一次的假回應（例如 { error: 'AI_BUSY' }）
  let demoAiLast = null; // 回測用：最後一次「送給 AI」的內容（確認原文名字原樣送出）
  const DEMO_LAYOUT_BY_UNIT = { '體能活動': '相簿版', '白雲大小事': '相簿版', '學習區 A': '探索版', '學習區 B': '探索版', '生活與探索': '探索版', '主題課程': '故事版' };

  function demoAiDraft(p) {
    const rec = p.record || {};
    const clean = function (t) { return String(t || '').replace(/\[\[\s*([^\[\]]+?)\s*\]\]/g, '$1'); };   // 與 GAS 相同：舊的 [[姓名]] 只拿掉括號
    const raw = clean(rec.rawText);
    if (!raw.trim()) fail('BAD_REQUEST', '請先在「說一說」寫下或口述原始紀錄。');
    const notes = (rec.photoNotes || []).map(clean);
    if ((raw + clean(rec.title) + notes.join('')).replace(/\s/g, '').length < 4) fail('TOO_SHORT', '原始紀錄太短，AI 沒有東西可以整理；請多寫幾句再試。');
    if (demoAiNext && demoAiNext.error) { const code = demoAiNext.error; demoAiNext = null; fail(code, code === 'AI_LIMIT' ? '今天的 AI 整理次數已用完' : 'AI 服務忙碌中，請稍後再試。'); }
    demoAiCalls += 1;
    demoAiLast = { title: clean(rec.title), rawText: raw, photoNotes: notes };
    const n = Math.max(0, Math.min(20, Number(rec.photoCount) || 0));
    let layout = ['故事版', '相簿版', '探索版'].indexOf(rec.layout) >= 0 ? rec.layout : (DEMO_LAYOUT_BY_UNIT[rec.unit] || '故事版');
    if (layout === '相簿版' && !n) layout = '故事版';
    const first = raw.split(/[。！？\n]/).filter(Boolean)[0] || raw;
    // 假的 AI 回應：只重組原始紀錄的句子，不新增事實；名字原樣保留
    let newsletter = '（示範 AI）' + raw.slice(0, 120);
    if (layout === '探索版') newsletter = '嘗試：' + first + '。\n發現：【待老師補充：孩子注意到什麼】\n調整：【待老師補充：孩子後來怎麼改】';
    const data = { summary: '（示範 AI）' + first + '。', newsletter: newsletter, layoutUsed: layout, warnings: [] };
    if (layout === '相簿版') {
      data.captions = [];
      for (let i = 0; i < n; i++) data.captions.push('第 ' + (i + 1) + ' 張：' + (notes[i] || first).slice(0, 20));
    }
    return data;
  }

  // ---------- v2.5 設定（規則與 gas/Code.gs 的 planSettings_、actionSaveSettings_ 相同） ----------
  /** 設定內容的版本：GAS 用 SHA-256；示範模式用簡單雜湊，同樣是「內容一樣 → 版本一樣」 */
  function configVersion() {
    const s = JSON.stringify(CONFIG);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'demo' + h.toString(36);
  }
  function resolveUnitAlias(unit) {
    let u = unit;
    for (let i = 0; i < 20; i++) {
      const a = unitAliases[u];
      if (!a) return '';
      u = a.to;
      if (CONFIG.units.indexOf(u) >= 0) return u;
    }
    return '';
  }
  function resolveRecordUnit(unit, old) {
    if (CONFIG.units.indexOf(unit) >= 0) return unit;
    if (old && old.unit === unit) return unit;
    const mapped = resolveUnitAlias(unit);
    if (mapped) return mapped;
    fail('BAD_REQUEST', '家訊單元「' + unit + '」不在設定表的單元清單內（主編可能剛改過單元，請重新選擇單元）');
  }
  function cleanUnitName(v, label) {
    const s = String(v == null ? '' : v).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
    if (!s) fail('BAD_REQUEST', label + '不可空白');
    if (/[,，、]/.test(s)) fail('BAD_REQUEST', label + '「' + s + '」不能有逗號或頓號');
    if (UNIT_BAD_CHARS_RE.test(s)) fail('BAD_REQUEST', label + '不可換行，也不可含控制字元或看不見的特殊字元');
    if (!UNIT_HAS_LETTER_RE.test(s)) fail('BAD_REQUEST', label + '至少要有一個中文字、英文字母或數字');
    if (UNIT_RESERVED.indexOf(s) >= 0) fail('BAD_REQUEST', label + '「' + s + '」是系統保留字，請換一個名稱');
    if (Array.from(s).length > SETTINGS_LIMITS.unitName) fail('BAD_REQUEST', label + '「' + s + '」最多 ' + SETTINGS_LIMITS.unitName + ' 字');
    return s;
  }
  function planSettings(p, orphans) {
    orphans = orphans || Object.create(null);
    const s = p.settings || {};
    const text = function (v, max, label, required) {
      const t = String(v == null ? '' : v).replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim();
      if (CTRL_BIDI_RE.test(t)) fail('BAD_REQUEST', label + '不可含控制字元或文字方向控制字元');
      if (required && !t) fail('BAD_REQUEST', '請填寫' + label);
      if (Array.from(t).length > max) fail('BAD_REQUEST', label + '最多 ' + max + ' 字');
      return t;
    };
    const settings = {
      className: text(s.className, SETTINGS_LIMITS.className, '班級名稱', true),
      newsletterName: text(s.newsletterName, SETTINGS_LIMITS.newsletterName, '家訊名稱', true),
      footer: text(s.footer, SETTINGS_LIMITS.footer, '頁尾標語', false),
      emptyText: text(s.emptyText, SETTINGS_LIMITS.emptyText, '空單元文字', false)
    };
    const mp = Number(s.maxPhotos);
    if (!(isFinite(mp) && Math.floor(mp) === mp && mp >= 1 && mp <= LIMIT_MAX_PHOTOS)) fail('BAD_REQUEST', '每筆照片上限必須是 1–' + LIMIT_MAX_PHOTOS + ' 的整數');
    settings.maxPhotos = mp;
    if (!Array.isArray(p.units)) fail('BAD_REQUEST', '缺少單元清單');
    if (p.units.length < SETTINGS_LIMITS.unitsMin || p.units.length > SETTINGS_LIMITS.unitsMax) fail('BAD_REQUEST', '單元數量必須是 1–12 個（單元數＝家訊頁數）');
    const names = [];
    const seen = Object.create(null), fromSeen = Object.create(null), map = Object.create(null), removed = Object.create(null);
    p.units.forEach(function (u, i) {
      const name = cleanUnitName(u && u.name, '第 ' + (i + 1) + ' 個單元名稱');
      if (seen[name]) fail('BAD_REQUEST', '單元名稱「' + name + '」重複');
      seen[name] = true;
      names.push(name);
      const from = u && u.from != null ? String(u.from) : '';
      if (!from) return;
      if (CONFIG.units.indexOf(from) < 0) fail('BAD_REQUEST', '原單元「' + from + '」不在目前的清單內，請重新整理後再改');
      if (fromSeen[from]) fail('BAD_REQUEST', '原單元「' + from + '」出現兩次');
      fromSeen[from] = true;
      if (from !== name) map[from] = name;
    });
    (Array.isArray(p.removed) ? p.removed : []).forEach(function (r) {
      const name = String(r && r.name || '');
      const isOrphan = CONFIG.units.indexOf(name) < 0 && Object.prototype.hasOwnProperty.call(orphans, name);
      if (CONFIG.units.indexOf(name) < 0 && !isOrphan) fail('BAD_REQUEST', '要刪除的單元「' + name + '」不在目前的清單內，請重新整理後再改');
      if (fromSeen[name] || name in removed) fail('BAD_REQUEST', '單元「' + name + '」不能同時保留又刪除');
      const moveTo = r && r.moveTo ? String(r.moveTo) : '';
      if (isOrphan && !moveTo) fail('BAD_REQUEST', '不在清單內的單元「' + name + '」要選擇搬到哪個單元');
      if (moveTo && !seen[moveTo]) fail('BAD_REQUEST', '「' + name + '」的紀錄要移到的單元「' + moveTo + '」不在新清單內');
      removed[name] = moveTo;
      if (moveTo) map[name] = moveTo;
    });
    CONFIG.units.forEach(function (u) {
      if (!fromSeen[u] && !(u in removed)) fail('BAD_REQUEST', '單元「' + u + '」沒有說明要保留還是刪除，請重新整理後再改');
    });
    return { settings: settings, units: names, map: map, removed: removed };
  }
  function unitUsage() {
    const counts = Object.create(null);
    let maxPhotosUsed = 0;
    records.forEach(function (r) { counts[r.unit] = (counts[r.unit] || 0) + 1; maxPhotosUsed = Math.max(maxPhotosUsed, r.photos.length); });
    return { unitCounts: counts, maxPhotosUsed: maxPhotosUsed };
  }
  /** v2.6（G2）：與 GAS orphanUnits_ 相同 */
  function orphanUnits(counts) {
    return Object.keys(counts).filter(function (u) { return u && CONFIG.units.indexOf(u) < 0; })
      .map(function (u) { return { name: u, count: counts[u] }; })
      .sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : 1); });
  }
  function settingsResult(extra) {
    return Object.assign({ config: clone(CONFIG), configVersion: configVersion(), limits: Object.assign({ maxPhotos: LIMIT_MAX_PHOTOS }, SETTINGS_LIMITS) },
      clone(unitUsage()), { orphans: orphanUnits(unitUsage().unitCounts) }, extra || {});
  }
  function requireEditor() { if (currentUser.role !== '主編') fail('FORBIDDEN', '只有主編可以查看或修改設定。'); }
  function saveSettings(p) {
    requireEditor();
    if (typeof p.expectedVersion !== 'string' || !p.expectedVersion) fail('BAD_REQUEST', '缺少設定版本（請重新整理後再改）。');
    if (p.expectedVersion !== configVersion()) fail('CONFLICT', '設定剛被其他主編（或有人在試算表）改過，請重新整理後再改。');
    const usage = unitUsage();
    const orphanSet = Object.create(null);
    orphanUnits(usage.unitCounts).forEach(function (x) { orphanSet[x.name] = x.count; });
    const plan = planSettings(p, orphanSet);
    Object.keys(plan.removed).forEach(function (name) {
      const n = usage.unitCounts[name] || 0;
      if (n && !plan.removed[name]) { const e = new Error('單元「' + name + '」還有 ' + n + ' 筆紀錄，請先選擇要移到哪個單元。'); e.code = 'UNIT_HAS_RECORDS'; e.unit = name; e.count = n; throw e; }
    });
    let moved = 0;
    const names = [];
    Object.keys(plan.map).forEach(function (f) { [f, plan.map[f]].forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); }); });
    if (names.length) { unitChangeNames(); unitChanges = unitChanges.concat([{ names: names, at: Date.now() }]).slice(-20); }
    records.forEach(function (r) {   // 與 GAS 相同：只改單元，不改 updatedAt
      if (r.unit in plan.map && plan.map[r.unit] !== r.unit) { r.unit = plan.map[r.unit]; moved++; }
    });
    CONFIG.className = plan.settings.className;
    CONFIG.newsletterName = plan.settings.newsletterName;
    CONFIG.footer = plan.settings.footer || '白雲班的每一天，都值得記錄。';   // 與 readConfig_ 相同：空白用預設
    CONFIG.maxPhotos = plan.settings.maxPhotos;
    CONFIG.emptyText = plan.settings.emptyText;
    CONFIG.units = plan.units.slice();
    const now = Date.now();
    Object.keys(plan.map).forEach(function (from) { unitAliases[from] = { to: plan.map[from], at: now }; });
    plan.units.forEach(function (u) { delete unitAliases[u]; });
    lastSettingsWrite = { moved: moved, units: plan.units.slice() };
    return settingsResult({ moved: moved });
  }
  let lastSettingsWrite = null;

  // ---------- v2.6 成員（規則與 gas/Code.gs 相同） ----------
  const MEMBER_LIMITS = { name: 20, email: 254 };
  const EMAIL_RE = /^[A-Za-z0-9._%+'\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
  function membersVersion() {
    const s = JSON.stringify(members);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return 'mem' + h.toString(36);
  }
  function memberOf(email) { return members.find(function (m) { return m.email === email; }) || null; }
  function activeEditors() { return members.filter(function (m) { return m.active && m.role === '主編'; }).length; }
  function membersResult(extra) {
    return Object.assign({
      members: members.map(function (m) { return { email: m.email, name: m.name, role: m.role, active: m.active, dup: false, isMe: m.email === currentEmail }; }),
      membersVersion: membersVersion(), activeEditors: activeEditors(), limits: clone(MEMBER_LIMITS)
    }, extra || {});
  }
  function cleanMemberEmail(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) fail('BAD_REQUEST', '請填寫 Email');
    if (s.length > MEMBER_LIMITS.email || !EMAIL_RE.test(s) || /\.\./.test(s)) fail('BAD_REQUEST', 'Email「' + s.slice(0, 80) + '」格式不正確（例如 teacher@gmail.com）');
    return s;
  }
  function cleanMemberName(v) {
    const t = String(v == null ? '' : v).replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
    if (CTRL_BIDI_RE.test(t)) fail('BAD_REQUEST', '姓名不可含控制字元或文字方向控制字元');
    if (!t) fail('BAD_REQUEST', '請填寫姓名');
    if (Array.from(t).length > MEMBER_LIMITS.name) fail('BAD_REQUEST', '姓名最多 ' + MEMBER_LIMITS.name + ' 字');
    return t;
  }
  function cleanMemberRole(v) { if (v === '主編' || v === '老師') return v; fail('BAD_REQUEST', '角色只能是「老師」或「主編」'); }
  function saveMember(p) {
    requireEditor();
    if (typeof p.expectedVersion !== 'string' || !p.expectedVersion) fail('BAD_REQUEST', '缺少成員名單版本（請重新載入成員名單後再改）。');
    if (p.expectedVersion !== membersVersion()) fail('CONFLICT', '成員名單剛被其他主編（或有人在試算表）改過，請重新載入後再操作一次。');
    const m = p.member || {};
    if (p.op !== 'add' && p.op !== 'update') fail('BAD_REQUEST', '不支援的成員操作');
    const email = cleanMemberEmail(m.email);
    const target = memberOf(email);
    if (p.op === 'add') {
      if (target) {
        const e = new Error(target.active ? '「' + email + '」已經是成員（' + (target.name || email) + '），不必再新增。'
          : '「' + email + '」已在成員名單內但目前停用，請在清單中按「啟用」，不必再新增。');
        e.code = 'DUPLICATE_MEMBER'; e.email = email; e.inactive = !target.active; throw e;
      }
      members.push({ email: email, name: cleanMemberName(m.name), role: cleanMemberRole(m.role === undefined ? '老師' : m.role), active: true });
      return membersResult({ saved: email });
    }
    if (!target) fail('NOT_FOUND', '成員名單裡找不到「' + email + '」，請重新載入成員名單。');
    if (Object.prototype.hasOwnProperty.call(m, 'newEmail')) fail('BAD_REQUEST', 'Email 建立後不能修改；要換帳號請新增一筆、再停用舊的。');
    const next = { name: target.name, role: target.role, active: target.active };
    if (m.name !== undefined) next.name = cleanMemberName(m.name);
    if (m.role !== undefined) next.role = cleanMemberRole(m.role);
    if (m.active !== undefined) { if (typeof m.active !== 'boolean') fail('BAD_REQUEST', '啟用只能是 true 或 false'); next.active = m.active; }
    if (email === currentEmail && ((target.active && !next.active) || (target.role !== next.role && next.role !== '主編'))) {
      fail('SELF_LOCKOUT', '不能停用自己或把自己改成老師（以免把自己鎖在外面）；需要的話，請另一位主編操作。');
    }
    if (target.active && target.role === '主編' && !(next.active && next.role === '主編') && activeEditors() <= 1) {
      fail('LAST_EDITOR', '「' + (target.name || email) + '」是目前唯一啟用中的主編，不能停用或改成老師；請先把另一位成員改成主編。');
    }
    Object.assign(target, next);
    return membersResult({ saved: email });
  }

  const handlers = {
    listMembers: function () { requireEditor(); return membersResult(); },
    saveMember: function (p) { return saveMember(p); },
    getSettings: function () { requireEditor(); return settingsResult(); },
    saveSettings: function (p) { return saveSettings(p); },
    aiDraft: function (p) { return demoAiDraft(p); },
    bootstrap: function () {
      // 與 GAS 相同：只有主編會收到照片資料損壞的列
      const brokenRows = currentUser.role === '主編'
        ? records.map(function (r, i) { return { r: r, row: i + 2 }; })
          .filter(function (x) { return x.r.photosBroken; })
          .map(function (x) { return { row: x.row, title: x.r.title }; })
        : [];
      return { me: clone(currentUser), config: clone(CONFIG), configVersion: configVersion(), version: 'demo', brokenRows: brokenRows,
        ai: { enabled: true, demo: true } };
    },

    listRecords: function (p) {
      const list = records.filter(function (r) { return r.month === p.month; })
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
        .map(decorate);
      return { month: p.month, records: list };
    },

    saveRecord: function (p) {
      const clean = validate(p.record || {});
      const now = new Date().toISOString();
      if (!clean.id) {
        checkPhotoOwnership(clean, null);
        const rec = Object.assign(clean, {
          id: newId('demo-rec'), authorEmail: currentUser.email, authorName: currentUser.name, createdAt: now, updatedAt: now
        });
        records.push(rec);
        tagPhotos(rec);
        return { record: decorate(rec) };
      }
      if (!p.expectedUpdatedAt) fail('BAD_REQUEST', '更新紀錄時必須附上 expectedUpdatedAt（請重新整理後再編輯）。');
      const idx = records.findIndex(function (r) { return r.id === clean.id; });
      if (idx < 0) fail('NOT_FOUND', '找不到這筆紀錄，可能已被刪除。');
      const old = records[idx];
      if (!canEdit(old)) fail('FORBIDDEN', '您沒有修改這筆紀錄的權限。');
      if (old.photosBroken) fail('PHOTOS_BROKEN', '這筆紀錄的照片資料損壞，請聯絡管理者修正試算表後再編輯。');
      if (p.expectedUpdatedAt !== old.updatedAt) fail('CONFLICT', '這筆紀錄已被其他人修改過，請重新整理後再編輯。');
      checkPhotoOwnership(clean, old);
      const stamp = now === old.updatedAt ? new Date(Date.parse(now) + 1).toISOString() : now;
      const rec = Object.assign({}, old, clean, { updatedAt: stamp });
      records[idx] = rec;
      tagPhotos(rec);
      const keep = {};
      rec.photos.forEach(function (ph) { keep[ph.id] = true; keep[ph.thumbId] = true; });
      const removed = [];
      old.photos.forEach(function (ph) { [ph.id, ph.thumbId].forEach(function (f) { if (!keep[f]) removed.push(f); }); });
      untagAndTrash(removed, rec.id);
      return { record: decorate(rec) };
    },

    deleteRecord: function (p) {
      const idx = records.findIndex(function (r) { return r.id === p.id; });
      if (idx < 0) fail('NOT_FOUND', '找不到這筆紀錄，可能已被刪除。');
      if (!canEdit(records[idx])) fail('FORBIDDEN', '您沒有刪除這筆紀錄的權限。');
      if (records[idx].photosBroken) fail('PHOTOS_BROKEN', '這筆紀錄的照片資料損壞，請聯絡管理者修正試算表後再刪除。');
      const gone = records.splice(idx, 1)[0];
      const ids = [];
      gone.photos.forEach(function (ph) { ids.push(ph.id, ph.thumbId); });
      untagAndTrash(ids, gone.id);
      return { id: p.id };
    },

    uploadPhoto: function (p) {
      if (!p.full || !p.thumb) fail('BAD_REQUEST', '缺少照片資料');
      if (p.full.length > 1100000) fail('TOO_LARGE', '照片太大，請重新選擇照片');
      const id = newId('demo-photo'), thumbId = newId('demo-thumb');
      photoStore[id] = 'data:image/jpeg;base64,' + p.full;
      photoStore[thumbId] = 'data:image/jpeg;base64,' + p.thumb;
      registerPhoto(id, thumbId, p.w, p.h);
      return { photo: { id: id, thumbId: thumbId, w: p.w, h: p.h } };
    },

    getPhotos: function (p) {
      // 與 GAS 相同：總量超過回應上限時，其餘 ID 放進 deferred；第一張一定回傳
      const out = {};
      const deferred = [];
      let total = 0;
      (p.ids || []).forEach(function (id) {
        if (deferred.length) { deferred.push(id); return; }
        const url = photoStore[id] || null;
        const size = url ? url.length : 0;
        if (total > 0 && total + size > demoResponseLimit) { deferred.push(id); return; }
        total += size;
        out[id] = url;
      });
      return { photos: out, deferred: deferred };
    }
  };

  // 回測用（v2.4）：各動作呼叫次數、同時上傳數、上傳延遲與指定失敗
  const callCount = {};
  let uploadDelay = 250, uploadFailNext = 0, uploadsActive = 0, uploadsMax = 0;

  /** 給 api.js 呼叫；模擬網路延遲，讓「儲存中…」等狀態看得到 */
  async function handle(action, params) {
    callCount[action] = (callCount[action] || 0) + 1;
    if (action === 'uploadPhoto') {
      resolveMe();
      uploadsActive += 1; uploadsMax = Math.max(uploadsMax, uploadsActive);
      try {
        await delay(uploadDelay);
        if (uploadFailNext > 0) { uploadFailNext -= 1; fail('NETWORK', '連不上伺服器，請檢查網路連線。'); }
        return handlers.uploadPhoto(clone(params));
      } finally { uploadsActive -= 1; }
    }
    await delay(150);
    resolveMe();
    const h = handlers[action];
    if (!h) fail('BAD_ACTION', '不支援的動作：' + action);
    return h(clone(params));
  }

  function stats() { return { calls: clone(callCount), uploadsMax: uploadsMax, uploadsActive: uploadsActive }; }
  function resetStats() { Object.keys(callCount).forEach(function (k) { delete callCount[k]; }); uploadsMax = 0; }
  function setUploadDelay(ms) { uploadDelay = Number(ms) >= 0 ? Number(ms) : 250; }
  function failUploads(n) { uploadFailNext = Math.max(0, Number(n) || 0); }
  /** 回測用：某筆紀錄是否存在、照片 ID（確認沒有半途的照片被存進紀錄） */
  function recordPhotos(id) { const r = records.find(function (x) { return x.id === id; }); return r ? clone(r.photos) : null; }
  function allRecordPhotoIds() { const out = []; records.forEach(function (r) { r.photos.forEach(function (ph) { out.push(ph.id, ph.thumbId); }); }); return out; }

  /** v2.6：與 GAS doPost 相同，每個請求都重查成員表；不在名單或已停用 → NOT_MEMBER */
  function resolveMe() {
    const m = memberOf(currentEmail);
    if (!m || !m.active) fail('NOT_MEMBER', '您的帳號（' + currentEmail + '）不在成員名單內，或已被停用。');
    currentUser = { email: m.email, name: m.name || m.email, role: m.role === '主編' ? '主編' : '老師' };
  }
  /** 示範身分：'editor'、'teacher' 或成員的 Email */
  function setUser(key) {
    const email = USERS[key] ? USERS[key].email : String(key || '');
    if (memberOf(email)) currentEmail = email;
    const m = memberOf(currentEmail);
    if (m && m.active) currentUser = { email: m.email, name: m.name, role: m.role };
  }
  function getUserKey() { return currentEmail === USERS.editor.email ? 'editor' : currentEmail === USERS.teacher.email ? 'teacher' : currentEmail; }
  /** v2.6：示範身分選單（成員表的每一位，含停用者） */
  function identities() {
    return members.map(function (m) {
      const key = m.email === USERS.editor.email ? 'editor' : m.email === USERS.teacher.email ? 'teacher' : m.email;
      return { key: key, label: m.name + '（' + m.role + (m.active ? '' : '，已停用') + '）' };
    });
  }
  /** 回測用：模擬有人在試算表手改成員表（版本會變） */
  function editMemberSheet(email, patch) { const m = memberOf(email); if (m) Object.assign(m, patch || {}); return !!m; }
  function membersNow() { return clone(members); }

  seed();
  /** 回測用：模擬設定表改名（例如把某單元移除），測試「（舊值）」選項 */
  function setConfig(patch) { Object.assign(CONFIG, patch || {}); }

  /** 回測用：模擬「目前身分」上傳一組照片（不存檔），回傳 { id, thumbId, w, h } */
  function fakeUpload(label) {
    return addFakePhotos([label || '測試'])[0];
  }

  /** 回測用：示範 AI 的呼叫次數、指定下一次失敗 */
  function aiCalls() { return demoAiCalls; }
  function aiFailNext(code) { demoAiNext = { error: code }; }

  /** 回測用：調整模擬的 getPhotos 回應上限（測試 deferred 分批） */
  function setResponseLimit(n) { demoResponseLimit = Number(n) > 0 ? Number(n) : 6 * 1024 * 1024; }

  /** 回測用：查看某張照片的模擬標記 */
  function photoTag(fileId) { return photoMeta[fileId] ? clone(photoMeta[fileId]) : null; }

  /** 回測用（v2.5）：所有紀錄的單元與 updatedAt（確認改名搬移不改 updatedAt）、目前設定、單元別名 */
  function recordUnits() { return records.map(function (r) { return { id: r.id, title: r.title, unit: r.unit, updatedAt: r.updatedAt }; }); }
  function configNow() { return clone(CONFIG); }
  /** 回測用（v2.6 G2）：模擬「紀錄表有、單元清單沒有」的孤兒單元（例如手改設定表或中途失敗） */
  function setRecordUnit(title, unit) { const r = records.find(function (x) { return x.title === title; }); if (r) r.unit = unit; return !!r; }
  function aliases() { const o = {}; Object.keys(unitAliases).forEach(function (k) { o[k] = unitAliases[k].to; }); return o; }

  return { stats: stats, resetStats: resetStats, setUploadDelay: setUploadDelay, failUploads: failUploads, recordPhotos: recordPhotos, allRecordPhotoIds: allRecordPhotoIds,
    handle: handle, setUser: setUser, getUserKey: getUserKey, identities: identities, editMemberSheet: editMemberSheet, membersNow: membersNow, membersVersion: membersVersion, setConfig: setConfig, markBroken: markBroken, repair: repair, photoTag: photoTag, recordUnits: recordUnits, configNow: configNow, setRecordUnit: setRecordUnit, aliases: aliases, configVersion: configVersion, fakeUpload: fakeUpload, setResponseLimit: setResponseLimit, aiCalls: aiCalls, aiFailNext: aiFailNext, aiLast: function () { return demoAiLast ? clone(demoAiLast) : null; } };
})();
