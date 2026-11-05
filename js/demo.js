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
    maxPhotos: 20
  };
  const TEACHER_STATUSES = ['草稿', '已確認'];
  // 示範用學生名單：模擬「只在伺服器端」的資料，不經 bootstrap 回傳；示範 AI（demo-ai）在這個閉包內使用
  const DEMO_ROSTER = [
    { code: 'S1', name: '王小明', nicknames: ['阿明'], disabledAuto: [], active: true },
    { code: 'S2', name: '陳安', nicknames: ['安安'], disabledAuto: [], active: true },
    { code: 'S3', name: '林心如', nicknames: [], disabledAuto: [], active: true },
    { code: 'S4', name: '李安安', nicknames: ['安安'], disabledAuto: [], active: true }
  ];
  let demoResponseLimit = 6 * 1024 * 1024; // 模擬 getPhotos 回應上限；回測可用 WC.demo.setResponseLimit() 調小
  const STATUSES = ['草稿', '已確認', '已採用', '不採用'];

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
    if (CONFIG.units.indexOf(r.unit) < 0 && !(old && old.unit === r.unit)) fail('BAD_REQUEST', '家訊單元不在設定表的單元清單內');
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
      id: r.id || '', month: r.date.slice(0, 7), date: r.date, unit: r.unit, title: title,
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
          fail('PHOTO_TAKEN', '照片已屬於其他紀錄，請移除後重新加入。');
        }
        // 與 GAS 相同：無主照片（未標記或所屬紀錄已刪除）只有上傳者本人或主編能用
        if (!mine && m && (!m.recordId || !ownerExists) && currentUser.role !== '主編' && m.uploader !== currentUser.email) {
          fail('PHOTO_NOT_YOURS', '有照片是其他老師剛上傳、尚未存檔的，不能加入您的紀錄。');
        }
        records.forEach(function (r) {
          if (old && r.id === old.id) return;
          r.photos.forEach(function (x) { if (x.id === fid || x.thumbId === fid) fail('PHOTO_TAKEN', '照片已屬於其他紀錄，請移除後重新加入。'); });
        });
      });
    });
  }

  // ---------- 示範 AI（第 2 階段）：模擬 GAS 去名化 → AI → 還原，不連網 ----------
  // 真正的去名化演算法在 gas/Deidentify.gs（node 測試涵蓋 24 個案例）；這裡只做示範用的簡化版。
  let demoAiCalls = 0;
  let demoRosterOff = false;   // 回測用：模擬名單空白
  let demoInvalidRows = [];    // 回測用：模擬名單代號有誤的列號（v2.2 N1）
  function demoRosterActive() { return !demoRosterOff && DEMO_ROSTER.some(function (r) { return r.active; }); }
  let demoAiNext = null; // 回測用：指定下一次的假回應（例如 { error: 'AI_BUSY' }）
  const DEMO_LAYOUT_BY_UNIT = { '體能活動': '相簿版', '白雲大小事': '相簿版', '學習區 A': '探索版', '學習區 B': '探索版', '生活與探索': '探索版', '主題課程': '故事版' };

  function demoDeid(text) {
    let s = String(text || '');
    const warnings = [], candidates = [];
    // 與 GAS 相同（v2.1 M3）：老師手打的代號不被信任，一律換成 [S?]
    s = s.replace(/\[\[\s*S\d+\s*\]\]|\[S\d+\]/g, function () { warnings.push('原始紀錄中手打的代號不會被當成特定學生（已換成 [S?]）；要指定是誰，請寫 [[姓名]]'); return '[S?]'; });
    s = s.replace(/\[\[([^\]]+)\]\]/g, function (m, n) {
      const hit = DEMO_ROSTER.filter(function (r) { return r.name === n || r.name.slice(1) === n; });
      return hit.length === 1 ? '[' + hit[0].code + ']' : '[S?]';
    });
    const vars = [];
    DEMO_ROSTER.forEach(function (r) {
      vars.push({ v: r.name, codes: [r.code] });
      if (r.name.length >= 3) vars.push({ v: r.name.slice(1), codes: [r.code] });
      r.nicknames.forEach(function (n) { vars.push({ v: n, codes: [r.code] }); });
    });
    const merged = {};
    vars.forEach(function (x) { (merged[x.v] = merged[x.v] || []); x.codes.forEach(function (c) { if (merged[x.v].indexOf(c) < 0) merged[x.v].push(c); }); });
    Object.keys(merged).sort(function (a, b) { return b.length - a.length; }).forEach(function (v) {
      if (s.indexOf(v) < 0) return;
      const cs = merged[v];
      if (cs.length > 1) {
        warnings.push('「' + v + '」對到不只一位學生，已換成 [S?]；請點選是哪一位');
        candidates.push({ text: v, names: cs.map(function (c) { return DEMO_ROSTER.find(function (r) { return r.code === c; }).name; }) });
      }
      s = s.split(v).join(cs.length > 1 ? '[S?]' : '[' + cs[0] + ']');
    });
    // 簡化版（v2.3.1 M1）：兩字名字中間夾一個標點 → 換成 [S?] 並另列提醒（真正的演算法在 Deidentify.gs）
    const splits = [];
    DEMO_ROSTER.forEach(function (r) {
      const g = r.name.length >= 3 ? r.name.slice(1) : r.name;
      if (g.length !== 2) return;
      s = s.replace(new RegExp(g.charAt(0) + '[，。、！？／/｜|・.\\-~～「」【】《》（）()]+' + g.charAt(1), 'g'), function (m) {
        splits.push('「' + m + '」這段可能是名字，已用 [S?] 代替；AI 寫完後請自行補上');
        return '[S?]';
      });
    });
    return { text: s, warnings: warnings, candidates: candidates, splits: splits };
  }

  function demoRestore(s) {
    return String(s).replace(/\[(S\d+)\]/g, function (m, c) {
      const r = DEMO_ROSTER.find(function (x) { return x.code === c; });
      return r ? (r.name.length >= 3 ? r.name.slice(1) : r.name) : m;
    });
  }

  function demoAiDraft(p) {
    if (demoInvalidRows.length) fail('ROSTER_INVALID', '學生名單第 ' + demoInvalidRows.join('、') + ' 列的代號有誤（應寫成 S1、S2…），請管理者修正後再使用 AI 整理。');
    if (!demoRosterActive()) fail('ROSTER_EMPTY', '請先在試算表的「學生名單」分頁填寫學生名單，才能使用 AI 整理（保護孩子的名字）。');
    const rec = p.record || {};
    const raw = String(rec.rawText || '');
    if (!raw.trim()) fail('BAD_REQUEST', '請先在「說一說」寫下或口述原始紀錄。');
    const d = demoDeid(raw);
    // 與 GAS 相同（v2.2 N4）：用原文去掉標記與空白後的長度
    if (raw.replace(/\[\[|\]\]/g, '').replace(/\[\s*S\s*(\d+|\?)\s*\]/gi, '').replace(/\s/g, '').length < 4) fail('TOO_SHORT', '原始紀錄太短，AI 沒有東西可以整理；請多寫幾句再試。');
    if ((d.warnings.length || d.splits.length) && !p.confirm) { const e = new Error('送出前請確認以下幾點：'); e.code = 'NEED_CONFIRM'; e.warnings = d.warnings; e.splitWarnings = d.splits; e.candidates = d.candidates; throw e; }
    if (demoAiNext && demoAiNext.error) { const code = demoAiNext.error; demoAiNext = null; fail(code, code === 'AI_LIMIT' ? '今天的 AI 整理次數已用完' : 'AI 服務忙碌中，請稍後再試。'); }
    demoAiCalls += 1;
    const n = Math.max(0, Math.min(20, Number(rec.photoCount) || 0));
    let layout = ['故事版', '相簿版', '探索版'].indexOf(rec.layout) >= 0 ? rec.layout : (DEMO_LAYOUT_BY_UNIT[rec.unit] || '故事版');
    if (layout === '相簿版' && !n) layout = '故事版';
    const first = d.text.split(/[。！？\n]/).filter(Boolean)[0] || d.text;
    // 假的 AI 回應（代號版）：只重組原始紀錄的句子，不新增事實
    let newsletter = '（示範 AI）' + d.text.slice(0, 120);
    if (layout === '探索版') newsletter = '嘗試：' + first + '。\n發現：【待老師補充：孩子注意到什麼】\n調整：【待老師補充：孩子後來怎麼改】';
    const out = { summary: '（示範 AI）' + first + '。', newsletter: newsletter };
    const warnings = d.text.indexOf('[S?]') >= 0 ? ['文案中的 [S?] 是無法確定是哪位孩子的地方，請自行填上名字或刪掉'] : [];
    if (layout === '相簿版') {
      out.captions = [];
      for (let i = 0; i < n; i++) out.captions.push('第 ' + (i + 1) + ' 張：' + (((rec.photoNotes || [])[i]) ? demoDeid(rec.photoNotes[i]).text : first).slice(0, 20));
    }
    const data = { summary: demoRestore(out.summary), newsletter: demoRestore(out.newsletter), layoutUsed: layout, warnings: warnings };
    if (out.captions) data.captions = out.captions.map(demoRestore);
    return data;
  }

  const handlers = {
    aiDraft: function (p) { return demoAiDraft(p); },
    bootstrap: function () {
      // 與 GAS 相同：只有主編會收到照片資料損壞的列
      const brokenRows = currentUser.role === '主編'
        ? records.map(function (r, i) { return { r: r, row: i + 2 }; })
          .filter(function (x) { return x.r.photosBroken; })
          .map(function (x) { return { row: x.row, title: x.r.title }; })
        : [];
      // 與 GAS 相同：名單只回筆數與是否有重複綽號，不回任何姓名
      return { me: clone(currentUser), config: clone(CONFIG), version: 'demo', brokenRows: brokenRows,
        roster: { count: DEMO_ROSTER.filter(function (s) { return s.active; }).length, total: DEMO_ROSTER.length, hasDuplicateNicknames: true },
        ai: { enabled: true, demo: true, rosterReady: demoRosterActive() && !demoInvalidRows.length, invalidRows: demoInvalidRows.slice(), duplicateRows: [] } };
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

  /** 給 api.js 呼叫；模擬網路延遲，讓「儲存中…」等狀態看得到 */
  async function handle(action, params) {
    await delay(action === 'uploadPhoto' ? 250 : 150);
    const h = handlers[action];
    if (!h) fail('BAD_ACTION', '不支援的動作：' + action);
    return h(clone(params));
  }

  function setUser(key) { if (USERS[key]) currentUser = USERS[key]; }
  function getUserKey() { return currentUser === USERS.editor ? 'editor' : 'teacher'; }

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
  /** 回測用：模擬名單空白（true）或恢復（false）；之後切換一次示範身分重新載入 */
  function rosterEmpty(on) { demoRosterOff = !!on; }
  /** 回測用：模擬名單有代號錯誤的列（例如 [3, 5]）；之後切換一次示範身分重新載入 */
  function rosterInvalid(rows) { demoInvalidRows = Array.isArray(rows) ? rows.slice() : []; }

  /** 回測用：調整模擬的 getPhotos 回應上限（測試 deferred 分批） */
  function setResponseLimit(n) { demoResponseLimit = Number(n) > 0 ? Number(n) : 6 * 1024 * 1024; }

  /** 回測用：查看某張照片的模擬標記 */
  function photoTag(fileId) { return photoMeta[fileId] ? clone(photoMeta[fileId]) : null; }

  return { handle: handle, setUser: setUser, getUserKey: getUserKey, setConfig: setConfig, markBroken: markBroken, repair: repair, photoTag: photoTag, fakeUpload: fakeUpload, setResponseLimit: setResponseLimit, aiCalls: aiCalls, aiFailNext: aiFailNext, rosterEmpty: rosterEmpty, rosterInvalid: rosterInvalid };
})();
