/**
 * 白雲家訊 — A4 六頁列印版型（由 whitecloud-design/print/print.js 整合，v2.0）
 * 整合時的修改：沒有家訊文案時改用活動摘要並提示（plan、chooseLayout），其餘與設計原型相同。
 *
 * 三個步驟，彼此獨立，方便開發代理人整合：
 *   1. WCPrint.plan(records, config, options)   純函式：已採用紀錄 → 六頁配置物件（不碰 DOM）
 *   2. WCPrint.render(container, plan, photoUrl) 依配置產生 .sheet DOM
 *   3. WCPrint.fit(container)                    量測：照片格線、自動縮字、標記超量；回傳問題清單
 *   另有 WCPrint.audit(container) 給回測用：檢查切字、單字孤行、照片變形、頁數。
 *
 * 不用 ES module、不需建置；所有使用者文字都先跳脫再放進 innerHTML（同 WC.util.esc）。
 */
window.WCPrint = (function () {
  'use strict';

  const MM = 96 / 25.4; // 1mm 的 CSS px

  /* ====================== 規則常數（規則.md 第 2–4 節） ====================== */
  const MAX_PER_PAGE = 3;
  const SIZE_BY_COUNT = { 1: 'full', 2: 'half', 3: 'third' };

  /** 每種版型在各尺寸最多「顯示」幾張照片；超過的不顯示，並提示主編 */
  const PHOTO_CAP = {
    '故事版': { full: 5, half: 2, third: 1 },
    '相簿版': { full: 20, half: 8, third: 4 },
    '探索版': { full: 3, half: 2, third: 1 }
  };
  /** 內文字級（pt）：起始值 → 下限；行高起始值 → 下限 */
  const FONT = {
    full: { fs: 12, min: 10, lh: 1.75, lhMin: 1.55 },
    half: { fs: 11.5, min: 10, lh: 1.7, lhMin: 1.5 },
    third: { fs: 11, min: 10, lh: 1.65, lhMin: 1.5 }
  };
  /** 版面容量：起始字級下放得下的字數（test/calibrate.py 實測值打九折取整；照片數取典型值：故事 1、相簿 6、探索 2） */
  const CAPACITY = {
    '故事版': { full: 690, half: 320, third: 260 },
    '相簿版': { full: 330, half: 230, third: 130 },
    '探索版': { full: 550, half: 200, third: 190 }
  };
  /** 編輯建議字數（家長讀得完的長度，沿用原型：故事 150–220、相簿引言 60–100、探索三段各約 100） */
  const EDITORIAL = { '故事版': 220, '相簿版': 100, '探索版': 300 };
  const CHAR_HINT = {};
  Object.keys(CAPACITY).forEach(function (k) {
    CHAR_HINT[k] = {};
    Object.keys(CAPACITY[k]).forEach(function (sz) { CHAR_HINT[k][sz] = Math.min(EDITORIAL[k], CAPACITY[k][sz]); });
  });
  const EXPLORE_KEYS = [['try', '嘗試'], ['find', '發現'], ['fix', '調整']];

  /* ====================== 小工具 ====================== */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateLabel(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) return '';
    const wd = '日一二三四五六'[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return (+m[2]) + '/' + (+m[3]) + '（' + wd + '）';
  }
  /** 把段落最後 3 個字（含標點）綁成不換行，避免最後一行只剩一個字或一個問號 */
  function tailLock(text) {
    const a = Array.from(String(text));
    if (a.length <= 6) return esc(text);
    return esc(a.slice(0, -3).join('')) + '<span class="nw">' + esc(a.slice(-3).join('')) + '</span>';
  }
  /** 短句（例如空單元標語）：以標點為界包成不可拆的片段，換行只會落在逗號、句號之後 */
  function phrases(text) {
    return String(text || '').split(/(?<=[，。！？；、])/).map(function (s) {
      return '<span class="phr">' + esc(s) + '</span>';
    }).join('');
  }
  function paras(text) {
    return String(text || '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean)
      .map(function (p) { return '<p>' + tailLock(p) + '</p>'; }).join('');
  }
  function charCount(s) { return Array.from(String(s || '').replace(/\s+/g, '')).length; }

  /** 探索版：從文案拆出「嘗試／發現／調整」三段（行首關鍵字＋冒號）；缺任何一段回 null */
  function parseExplore(text) {
    const out = { intro: '', try: '', find: '', fix: '' };
    let cur = 'intro';
    String(text || '').split(/\n+/).forEach(function (line) {
      const t = line.trim();
      if (!t) return;
      const hit = EXPLORE_KEYS.find(function (k) { return new RegExp('^[【\\[（(]?' + k[1] + '[】\\]）)]?\\s*[：:]').test(t); });
      if (hit) { cur = hit[0]; out[cur] += t.replace(/^[^：:]*[：:]\s*/, ''); }
      else out[cur] += (out[cur] ? '\n' : '') + t;
    });
    return out.try && out.find && out.fix ? out : null;
  }

  /* ====================== 1. 選版（純函式） ====================== */
  /**
   * 決定一筆紀錄實際使用的版型。
   * 順序：主編指定（偏好版型）優先，但不符條件時退回並附提示；未指定則依照片數與文案自動判斷。
   */
  function chooseLayout(r) {
    const n = (r.photos || []).length;
    const ex = parseExplore(r.newsletter || r.summary);
    const notes = [];
    let lay = r.layout;
    if (lay === '探索版' && !ex) { notes.push('探索版需要「嘗試：」「發現：」「調整：」三段，已改用故事版'); lay = '故事版'; }
    if (lay === '相簿版' && n < 2) { notes.push('相簿版至少要 2 張照片，已改用故事版'); lay = '故事版'; }
    if (!PHOTO_CAP[lay]) lay = ex ? '探索版' : n >= 4 ? '相簿版' : '故事版';
    return { layout: lay, explore: lay === '探索版' ? ex : null, notes: notes };
  }

  /** 版面權重：同頁 2–3 筆時，照片多的相簿版分到較高的列 */
  function weight(item) {
    if (item.layout === '相簿版') return 1 + Math.min(item.photos.length, 8) * 0.05;
    if (item.layout === '探索版') return 1.1;
    return 1;
  }

  /**
   * 輸入：當月已採用紀錄、設定、選項；輸出：頁面配置物件（見規則.md 第 6 節）。
   * options.emptyMode: 'keep'（預設，空單元印一頁溫和留白）| 'hide'（略過空單元，總頁數變少）
   * options.order: { 單元名: [紀錄ID…] } 主編指定同頁順序；未指定的依日期排序
   */
  function plan(records, config, options) {
    options = options || {};
    const emptyMode = options.emptyMode === 'hide' ? 'hide' : 'keep';
    const used = (records || []).filter(function (r) { return r.status === '已採用'; });
    const units = config.units || [];
    const orphanRecords = used.filter(function (r) { return units.indexOf(r.unit) < 0; });

    let pages = units.map(function (unit) {
      let list = used.filter(function (r) { return r.unit === unit; });
      const ord = options.order && options.order[unit];
      list.sort(function (a, b) {
        if (ord) {
          const ia = ord.indexOf(a.id), ib = ord.indexOf(b.id);
          if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        }
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
      const placed = list.slice(0, MAX_PER_PAGE);
      const overflow = list.slice(MAX_PER_PAGE);
      const size = SIZE_BY_COUNT[placed.length] || null;
      const items = placed.map(function (r, i) {
        const ch = chooseLayout(r);
        const all = r.photos || [];
        const cap = PHOTO_CAP[ch.layout][size];
        const notes = ch.notes.slice();
        // 整合（v2.0）：沒有家訊文案時提醒主編（文字會改用活動摘要；兩者都空時只印標題與照片）
        if (!String(r.newsletter || '').trim()) notes.push(String(r.summary || '').trim() ? '還沒有家訊文案，暫用活動摘要' : '還沒有家訊文案，這一格只會印標題與照片');
        if (all.length > cap) {
          notes.push('照片 ' + all.length + ' 張，這個版位只放得下 ' + cap + ' 張（其餘不印）' +
            (ch.layout === '相簿版' ? '，建議精選或拆成兩筆' : '，建議改相簿版或精選'));
        }
        const chars = charCount(ch.explore ? [ch.explore.intro, ch.explore.try, ch.explore.find, ch.explore.fix].join('') : (r.newsletter || r.summary));
        const hint = CHAR_HINT[ch.layout][size];
        if (chars > hint) notes.push('文案 ' + chars + ' 字，建議 ' + hint + ' 字以內' + (chars > CAPACITY[ch.layout][size] ? '（超過版面容量，會自動縮字）' : '（家長較容易讀完）'));
        return {
          id: r.id, title: r.title, date: r.date, text: r.newsletter || r.summary || '', layout: ch.layout, explore: ch.explore,
          size: size, flip: i % 2 === 1, photos: all.slice(0, cap), hiddenPhotos: all.length - Math.min(all.length, cap),
          chars: chars, charHint: hint, notes: notes
        };
      });
      const pageNotes = [];
      if (overflow.length) {
        pageNotes.push('本單元已採用 ' + list.length + ' 筆，一頁最多 ' + MAX_PER_PAGE + ' 筆；未排入：' +
          overflow.map(function (r) { return '「' + r.title + '」'; }).join('、') + '。建議改到其他單元或下個月');
      }
      return { unit: unit, empty: !items.length, size: size, items: items,
        weights: items.map(weight), overflowRecords: overflow.map(function (r) { return { id: r.id, title: r.title }; }),
        notes: pageNotes };
    });
    if (emptyMode === 'hide') pages = pages.filter(function (p) { return !p.empty; });
    pages.forEach(function (p, i) { p.index = i + 1; p.total = pages.length; });
    return {
      month: options.month || (used[0] && used[0].month) || '',
      config: { className: config.className, newsletterName: config.newsletterName, footer: config.footer,
        emptyText: config.emptyText || '本月這個單元休息一下，下個月再和大家分享孩子們的新發現！' },
      emptyMode: emptyMode, pages: pages,
      orphanRecords: orphanRecords.map(function (r) { return { id: r.id, title: r.title, unit: r.unit }; })
    };
  }

  /* ====================== 2. 產生 DOM ====================== */
  function photoHtml(p, i, url, opts) {
    opts = opts || {};
    const num01 = function (v, d) { const n = Number(v); return v == null || v === '' || !isFinite(n) ? d : Math.max(0, Math.min(1, n)); };
    const fx = num01(p.fx, 0.5), fy = num01(p.fy, 0.35);
    const cap = p.caption ? esc(p.caption) : '';
    // v2.1 L1：w、h 一律以數字輸出（避免手改資料把字串注入屬性）
    const w = Number(p.w) > 0 ? Number(p.w) : 4, h = Number(p.h) > 0 ? Number(p.h) : 3;
    return '<figure class="ph' + (opts.cls ? ' ' + opts.cls : '') + '" data-w="' + w + '" data-h="' + h + '">' +
      '<div class="img"><img alt="" src="' + esc(url(p.id)) + '" style="object-position:' + (fx * 100).toFixed(0) + '% ' + (fy * 100).toFixed(0) + '%"></div>' +
      (opts.caption ? '<figcaption><span class="n">' + (i + 1) + '</span>' + cap + '</figcaption>' : '') + '</figure>';
  }
  function isPortrait(p) { return !!p && Number(p.h) > Number(p.w) * 1.05; }

  function itemHead(it) {
    return '<div class="it-head"><h2 class="it-title">' + tailLock(it.title) + '</h2>' +
      (it.date ? '<span class="it-date">' + esc(dateLabel(it.date)) + '</span>' : '') + '</div>';
  }

  function storyHtml(it, url) {
    const ph = it.photos;
    if (!ph.length) return '<div class="story nophoto"><div class="txt">' + paras(it.text) + '</div></div>';
    if (it.size === 'full' && ph.length === 2) {
      return '<div class="story duo"><div class="main">' + photoHtml(ph[0], 0, url) + photoHtml(ph[1], 1, url) + '</div>' +
        '<div class="txt">' + paras(it.text) + '</div></div>';
    }
    if (it.size === 'full') {
      const rest = ph.slice(1).map(function (p, i) { return photoHtml(p, i + 1, url); }).join('');
      const strip = rest ? '<div class="strip">' + rest + '</div>' : '';
      if (isPortrait(ph[0])) {
        return '<div class="story portrait"><div class="top"><div class="main">' + photoHtml(ph[0], 0, url) + '</div>' +
          '<div class="txt">' + paras(it.text) + '</div></div>' + strip + '</div>';
      }
      return '<div class="story"><div class="main">' + photoHtml(ph[0], 0, url) + '</div>' +
        '<div class="txt">' + paras(it.text) + '</div>' + strip + '</div>';
    }
    const pics = ph.map(function (p, i) { return photoHtml(p, i, url); }).join('');
    return '<div class="side"><div class="pics' + (ph.length > 1 ? ' two' : '') + (isPortrait(ph[0]) ? ' portrait' : '') + '">' + pics + '</div>' +
      '<div class="body"><div class="txt">' + paras(it.text) + '</div></div></div>';
  }

  function albumHtml(it, url) {
    const hasCap = it.photos.some(function (p) { return p.caption; });
    const grid = '<div class="grid' + (hasCap ? ' has-cap' : '') + '" data-n="' + it.photos.length + '">' +
      it.photos.map(function (p, i) { return photoHtml(p, i, url, { caption: hasCap }); }).join('') + '</div>';
    const lead = it.text ? '<div class="lead txt">' + paras(it.text) + '</div>' : '';
    return '<div class="album' + (it.size === 'third' ? ' row' : '') + '">' + lead + grid + '</div>';
  }

  function exploreHtml(it, url) {
    const ex = it.explore;
    const steps = EXPLORE_KEYS.map(function (k, i) {
      const sub = { try: '動手試試看', find: '我們注意到', fix: '再做一次' }[k[0]];
      return '<section class="step ' + k[0] + '"><h3><span class="num">' + (i + 1) + '</span>' + k[1] + '<small>' + sub + '</small></h3>' +
        '<div class="txt">' + paras(ex[k[0]]) + '</div></section>';
    }).join('');
    const intro = ex.intro ? '<div class="intro txt">' + paras(ex.intro) + '</div>' : '';
    const pics = it.photos.map(function (p, i) { return photoHtml(p, i, url); }).join('');
    if (it.size === 'full') {
      return '<div class="explore">' + intro + (pics ? '<div class="photos">' + pics + '</div>' : '') + '<div class="steps">' + steps + '</div></div>';
    }
    if (!pics) return '<div class="explore">' + intro + '<div class="steps' + (it.size === 'third' ? ' cols' : '') + '">' + steps + '</div></div>';
    return '<div class="explore side-x"><div class="photos">' + pics + '</div><div class="col">' + intro +
      '<div class="steps' + (it.size === 'third' ? ' cols' : '') + '">' + steps + '</div></div></div>';
  }

  function slotHtml(it, url) {
    const body = it.layout === '相簿版' ? albumHtml(it, url) : it.layout === '探索版' ? exploreHtml(it, url) : storyHtml(it, url);
    return '<article class="slot s-' + it.size + (it.flip ? ' flip' : '') + '" data-id="' + esc(it.id) + '" data-layout="' + esc(it.layout) + '">' +
      itemHead(it) + body + '</article>';
  }

  function sheetHtml(pg, P, url) {
    const c = P.config;
    const head = '<header class="pg-head"><div class="pg-meta"><span><b>' + esc(c.newsletterName) + '</b> ' + esc(P.month) +
      ' <span class="pg-no">' + pad2(pg.index) + '/' + pad2(pg.total) + '</span></span><span>' + esc(c.className) + '</span></div>' +
      '<div class="pg-title"><span class="pg-badge">' + pg.index + '</span><h1>' + esc(pg.unit) + '</h1>' +
      (pg.items.length ? '<span class="pg-count">本頁 ' + pg.items.length + ' 則活動</span>' : '') + '</div></header>';
    const body = pg.empty
      ? '<div class="pg-body n1"><div class="empty-unit"><div class="cloud"><i></i><i></i><i></i><b>休息中</b></div>' +
        '<p>' + phrases(c.emptyText) + '</p><p class="note">' + phrases('歡迎家長分享孩子在家的小故事，我們下個月一起放進家訊。') + '</p></div></div>'
      : '<div class="pg-body n' + pg.items.length + '" style="grid-template-rows:' +
        pg.weights.map(function (w) { return w.toFixed(2) + 'fr'; }).join(' ') + '">' +
        pg.items.map(function (it) { return slotHtml(it, url); }).join('') + '</div>';
    const foot = '<footer class="pg-foot"><span class="slogan">' + esc(c.footer) + '</span><span>' + pad2(pg.index) + ' / ' + pad2(pg.total) + '</span></footer>';
    return '<section class="sheet" data-page="' + pg.index + '" data-unit="' + esc(pg.unit) + '">' + head + body + foot + '</section>';
  }

  function render(container, P, photoUrl) {
    container.innerHTML = P.pages.map(function (pg) { return sheetHtml(pg, P, photoUrl); }).join('');
    container._plan = P;
    return container;
  }

  /* ====================== 3. 量測與自動調整 ====================== */
  function over(el) { return el.scrollHeight - el.clientHeight > 1; }

  /** 依格線實際大小選欄數：讓每格接近照片平均長寬比、空格最少 */
  function layoutGrid(g) {
    const figs = Array.prototype.slice.call(g.children);
    const n = figs.length;
    if (!n) return;
    const W = g.clientWidth, H = g.clientHeight;
    const gap = parseFloat(getComputedStyle(g).columnGap) || 0;
    let ar = 0;
    figs.forEach(function (f) { ar += Math.log((+f.dataset.w || 4) / (+f.dataset.h || 3)); });
    ar = Math.exp(ar / n);
    const capH = g.classList.contains('has-cap') ? 5.2 * MM : 0;
    let best = null;
    for (let c = 1; c <= Math.min(n, 6); c++) {
      const r = Math.ceil(n / c);
      const cw = (W - gap * (c - 1)) / c, ch = (H - gap * (r - 1)) / r - capH;
      if (ch <= 0) continue;
      const empty = c * r - n;
      const score = Math.abs(Math.log((cw / ch) / ar)) + empty * 0.3 + (cw < 22 * MM ? 2 : 0);
      if (!best || score < best.score) best = { c: c, r: r, score: score, ch: ch, empty: empty };
    }
    if (!best) best = { c: Math.min(n, 5), r: Math.ceil(n / Math.min(n, 5)), ch: 0, empty: 0 };
    g.style.gridTemplateColumns = 'repeat(' + best.c + ', minmax(0, 1fr))';
    g.style.gridTemplateRows = 'repeat(' + best.r + ', minmax(0, 1fr))';
    figs.forEach(function (f) { f.style.gridColumn = ''; });
    // 只差一格時，讓第一張橫跨兩欄當主照片，不留空格
    if (best.empty === 1 && best.c >= 2) figs[0].style.gridColumn = 'span 2';
    // 格子太矮就收起圖說（圖說改由文字稿提供），格子很多改緊密格線
    g.classList.toggle('cap', g.classList.contains('has-cap') && best.ch >= 26 * MM && n <= 12);
    g.classList.toggle('dense', n > 9);
  }

  function setFont(slot, fs, lh) {
    slot.style.setProperty('--fs', fs + 'pt');
    slot.style.setProperty('--lh', String(lh));
  }

  function slotOverflow(slot) {
    if (over(slot)) return slot.scrollHeight - slot.clientHeight;
    let worst = 0;
    slot.querySelectorAll('.step, .lead, .story.nophoto .txt').forEach(function (el) {
      if (over(el)) worst = Math.max(worst, el.scrollHeight - el.clientHeight);
    });
    return worst;
  }

  function relayout(slot) { slot.querySelectorAll('.grid').forEach(layoutGrid); }

  /** 故事版整頁、直照片：照片高度跟著上排可用高度縮（最高 3:4），文字仍放不下時才縮字 */
  function sizeStory(slot) {
    const st = slot.querySelector('.story.portrait');
    if (!st) return;
    const main = st.querySelector('.main'), top = st.querySelector('.top');
    main.style.height = '';
    const avail = top.clientHeight;
    const want = 133 * MM;
    if (avail < want) {
      const h = Math.max(70 * MM, avail);
      main.style.height = h + 'px';
      main.style.flexBasis = (h * 0.75) + 'px';
    } else main.style.flexBasis = '';
  }

  /**
   * 縮到下限仍放不下：把最高的文字區塊依「整行」截斷（line-clamp，結尾顯示…），
   * 避免列印時最後一行被裁掉一半。每次少一行，直到版位放得下。回傳被截掉的行數。
   */
  function clampToFit(slot) {
    let cut = 0;
    for (let guard = 0; guard < 80 && slotOverflow(slot) > 0; guard++) {
      const txts = Array.prototype.slice.call(slot.querySelectorAll('.txt'));
      if (!txts.length) break;
      let t = txts[0];
      txts.forEach(function (x) { if (x.scrollHeight > t.scrollHeight) t = x; });
      const lhPx = parseFloat(getComputedStyle(t.querySelector('p') || t).lineHeight) || 20;
      const cur = +t.dataset.clamp || Math.floor(t.scrollHeight / lhPx);
      if (cur <= 2) break;
      t.dataset.clamp = cur - 1;
      t.classList.add('clamped');
      t.style.webkitLineClamp = String(cur - 1);
      t.style.lineClamp = String(cur - 1);
      cut++;
    }
    return cut;
  }

  /**
   * 每個版位：先排格線 → 量是否超出 → 逐步縮小字級（每次 0.5pt）與行高，直到放得下或到下限。
   * 到下限仍放不下：標紅（is-over）＋列入問題清單；列印時超出的部分被版位裁掉，不會長出第七頁。
   */
  function fit(container) {
    const issues = [];
    const P = container._plan || { pages: [] };
    const byId = {};
    P.pages.forEach(function (pg) { pg.items.forEach(function (it) { byId[it.id] = { it: it, pg: pg }; }); });

    container.querySelectorAll('.slot').forEach(function (slot) {
      const size = slot.classList.contains('s-full') ? 'full' : slot.classList.contains('s-half') ? 'half' : 'third';
      const F = FONT[size];
      let fs = F.fs, lh = F.lh;
      slot.classList.remove('is-over', 'is-warn');
      slot.querySelectorAll('.txt.clamped').forEach(function (t) {
        t.classList.remove('clamped'); delete t.dataset.clamp; t.style.webkitLineClamp = ''; t.style.lineClamp = '';
      });
      slot.querySelectorAll('.flag').forEach(function (f) { f.remove(); });
      setFont(slot, fs, lh);
      sizeStory(slot); relayout(slot);
      let ov = slotOverflow(slot);
      while (ov > 0 && (fs > F.min || lh > F.lhMin)) {
        if (fs > F.min) fs = Math.round((fs - 0.5) * 10) / 10;
        else lh = Math.round((lh - 0.05) * 100) / 100;
        setFont(slot, fs, lh); sizeStory(slot); relayout(slot);
        ov = slotOverflow(slot);
      }
      const ref = byId[slot.dataset.id] || { it: { notes: [], title: '', chars: 0, charHint: 0 }, pg: {} };
      const msgs = ref.it.notes.slice();
      let level = msgs.length ? 'yellow' : '';
      if (fs < F.fs) msgs.unshift('已自動縮小字級為 ' + fs + 'pt');
      if (ov > 0) {
        const lines = clampToFit(slot);
        msgs.unshift('內容放不下，已截掉最後約 ' + Math.max(lines, 1) + ' 行（以…結尾），建議拆分或精簡');
        level = 'red';
      } else if (fs < F.fs && !level) level = 'yellow';
      slot.dataset.fs = fs; slot.dataset.lh = lh;
      if (level) {
        slot.classList.add(level === 'red' ? 'is-over' : 'is-warn');
        const flag = document.createElement('div');
        flag.className = 'flag ' + level;
        flag.textContent = (level === 'red' ? '⚠ ' : '△ ') + msgs.join('；');
        flag.title = msgs.join('\n');
        slot.appendChild(flag);
        issues.push({ level: level, page: ref.pg.index, unit: ref.pg.unit, id: slot.dataset.id, title: ref.it.title, messages: msgs });
      }
    });

    P.pages.forEach(function (pg) {
      if (!pg.notes.length) return;
      const sh = container.querySelector('.sheet[data-page="' + pg.index + '"]');
      if (!sh) return;
      sh.querySelectorAll('.sheet-flag').forEach(function (f) { f.remove(); });
      const f = document.createElement('div');
      f.className = 'sheet-flag';
      f.textContent = '⚠ ' + pg.notes.join('；');
      sh.appendChild(f);
      issues.push({ level: 'red', page: pg.index, unit: pg.unit, id: '', title: '', messages: pg.notes });
    });
    (P.orphanRecords || []).forEach(function (r) {
      issues.push({ level: 'red', page: 0, unit: r.unit, id: r.id, title: r.title, messages: ['單元「' + r.unit + '」不在設定表清單內，不會排進家訊'] });
    });
    container._issues = issues;
    return issues;
  }

  /* ====================== 回測：自我檢查 ====================== */
  /** 找出每段最後一行只有 1 個字（或只剩標點）的段落 */
  function lastLineChars(p) {
    const range = document.createRange();
    const chars = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0) chars.push({ ch: node.data[i], top: Math.round(r.top) });
      }
    }
    if (!chars.length) return '';
    const lastTop = chars[chars.length - 1].top;
    return chars.filter(function (c) { return Math.abs(c.top - lastTop) < 3; }).map(function (c) { return c.ch; }).join('');
  }

  function audit(container) {
    const out = { sheets: container.querySelectorAll('.sheet').length, overflowSlots: [], clampedSlots: [], orphanLines: [], distorted: [], clippedTitles: [], sheetOverflow: [] };
    container.querySelectorAll('.sheet').forEach(function (sh) {
      const body = sh.querySelector('.pg-body');
      if (body && body.scrollHeight - body.clientHeight > 1) out.sheetOverflow.push(sh.dataset.page);
    });
    container.querySelectorAll('.slot').forEach(function (s) {
      if (slotOverflow(s) > 0) out.overflowSlots.push(s.closest('.sheet').dataset.page + ':' + s.dataset.id);
      if (s.querySelector('.txt.clamped')) out.clampedSlots.push(s.closest('.sheet').dataset.page + ':' + s.dataset.id);
    });
    container.querySelectorAll('.txt p, .empty-unit p, .it-title').forEach(function (p) {
      const t = lastLineChars(p).replace(/\s/g, '');
      const lines = p.getClientRects().length;
      if (t.length <= 1 && p.textContent.trim().length > 1) {
        // 只有一行的短段落不算
        const h = p.getBoundingClientRect().height, lhpx = parseFloat(getComputedStyle(p).lineHeight) || 20;
        if (h > lhpx * 1.5) out.orphanLines.push((p.closest('.sheet') || {}).dataset.page + ':「' + p.textContent.slice(-8) + '」');
      }
      void lines;
    });
    container.querySelectorAll('.ph img').forEach(function (img) {
      const cs = getComputedStyle(img);
      if (cs.objectFit !== 'cover' && cs.objectFit !== 'contain') out.distorted.push(img.src.slice(0, 40));
    });
    container.querySelectorAll('.it-title').forEach(function (t) {
      if (t.scrollWidth - t.clientWidth > 1) out.clippedTitles.push(t.textContent);
    });
    return out;
  }

  /* ====================== 文字稿（第 3 階段「下載編排文字稿」） ====================== */
  function toMarkdown(P) {
    const c = P.config;
    const lines = ['# ' + c.newsletterName + ' ' + P.month, ''];
    P.pages.forEach(function (pg) {
      lines.push('## ' + pad2(pg.index) + '/' + pad2(pg.total) + ' ' + pg.unit, '');
      if (pg.empty) lines.push(c.emptyText, '');
      pg.items.forEach(function (it) {
        lines.push('### ' + it.title + '（' + dateLabel(it.date) + '，' + it.layout + '）', '', it.text, '');
        it.photos.forEach(function (p, i) { if (p.caption) lines.push((i + 1) + '. ' + p.caption); });
        lines.push('');
      });
    });
    lines.push('---', c.footer);
    return lines.join('\n');
  }

  return {
    plan: plan, render: render, fit: fit, audit: audit, toMarkdown: toMarkdown,
    chooseLayout: chooseLayout, parseExplore: parseExplore,
    rules: { MAX_PER_PAGE: MAX_PER_PAGE, PHOTO_CAP: PHOTO_CAP, FONT: FONT, CAPACITY: CAPACITY, EDITORIAL: EDITORIAL, CHAR_HINT: CHAR_HINT }
  };
})();
