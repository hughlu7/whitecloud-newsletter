/**
 * 照片檢視器：點縮圖放大看，同一筆紀錄的照片可左右切換。
 *
 * 用法：WC.viewer.open(items, index, opener, title)
 *   items：[{ thumbId?, fullId?, localUrl?, caption? }]
 *     - 已存照片：thumbId＝縮圖、fullId＝原圖（photo.id）
 *     - 待上傳照片：localUrl＝本機預覽圖（不抓原圖）
 *   opener：關閉後把焦點還給它；title：紀錄標題，用於 alt 文字
 *
 * 原圖讀取：
 *   - 不走 WC.photos 的合併佇列（那邊每批最多 20 張，原圖約 300KB／張，可能逼近 getPhotos 的回應上限），
 *     改成一次一張 getPhotos([id])，只抓目前這張與前後各一張。
 *   - 讀過的原圖存在 fullCache；讀取中的請求共用同一個 Promise，不重複抓。
 *   - 原圖載入前先顯示縮圖，並標示「載入原圖中…」。
 *
 * 縮放：雙擊（或雙指點兩下）在 1 倍／2.5 倍間切換，放大後可拖曳捲動；
 *       檢視器內設 touch-action: pinch-zoom，手機也可用瀏覽器原生雙指縮放（viewport 未鎖 user-scalable）。
 * 所有文字一律用 textContent／屬性 API 設定，不組 HTML 字串。
 *
 * 下載原圖（只有成員能登入本系統，所以登入的老師、主編都看得到；示範模式也顯示）：
 *   - 「下載原圖」：原圖 data URL → 自行解 base64 成 Blob（CSP 的 connect-src 不允許 fetch(data:)）→ <a download> → revokeObjectURL。
 *   - 「下載這筆全部照片」：逐張下載、間隔約 400ms，顯示「下載中 3 / 8」，可中止。
 *   - 檔名：民國 7 碼日期_紀錄標題_第N張.jpg；標題的 \ / : * ? " < > | 換成全形，截到 30 字。
 *   - 上傳時已用 canvas 重繪移除 EXIF（含 GPS），下載不再處理。
 *   - 示範模式的假照片是 SVG，下載前用 canvas 轉成 JPEG，副檔名與內容一致。
 */
WC.viewer = (function () {
  const U = WC.util;
  const fullCache = {};   // fullId → data URL 或 null
  const inflight = {};    // fullId → Promise
  let fetchCount = 0;     // 回測用：實際呼叫 getPhotos 抓原圖的次數
  let items = [];
  let idx = 0;
  let title = '';
  let opener = null;
  let zoomed = false;
  let token = 0;          // 換張時遞增，丟棄過期的原圖結果
  let built = false;
  let el = {};
  let meta = { title: '', date: '' };
  let dlRun = 0;          // 多張下載的執行序號；中止或關閉時遞增
  const DL_GAP_MS = 400;

  function build() {
    if (built) return;
    built = true;
    const root = document.createElement('div');
    root.id = 'viewer';
    root.className = 'viewer';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '照片檢視');
    root.innerHTML =
      '<div class="vw-top"><span class="vw-count" aria-live="polite"></span>' +
      '<span class="vw-loading" role="status"></span>' +
      '<button type="button" class="vw-close icon-btn" aria-label="關閉照片檢視">✕</button></div>' +
      '<div class="vw-stage"><img class="vw-img" alt="" draggable="false"></div>' +
      '<button type="button" class="vw-nav vw-prev" aria-label="上一張">‹</button>' +
      '<button type="button" class="vw-nav vw-next" aria-label="下一張">›</button>' +
      '<p class="vw-cap"></p>' +
      '<div class="vw-dl">' +
      '<button type="button" class="btn vw-dl-one">⬇ 下載原圖</button>' +
      '<button type="button" class="btn vw-dl-all"></button>' +
      '<span class="vw-dl-prog" role="status" aria-live="polite"></span>' +
      '<button type="button" class="btn vw-dl-stop" hidden>中止</button>' +
      '<p class="vw-dl-note">分享前請確認照片中的孩子家長都同意。原圖已移除拍攝位置等資訊。</p>' +
      '</div>' +
      '<p class="vw-hint">雙擊放大・左右滑動或方向鍵切換・Esc 關閉</p>';
    document.body.appendChild(root);
    el = {
      root: root, stage: root.querySelector('.vw-stage'), img: root.querySelector('.vw-img'),
      count: root.querySelector('.vw-count'), loading: root.querySelector('.vw-loading'),
      cap: root.querySelector('.vw-cap'), prev: root.querySelector('.vw-prev'),
      next: root.querySelector('.vw-next'), close: root.querySelector('.vw-close'),
      dlOne: root.querySelector('.vw-dl-one'), dlAll: root.querySelector('.vw-dl-all'),
      dlProg: root.querySelector('.vw-dl-prog'), dlStop: root.querySelector('.vw-dl-stop')
    };
    el.dlOne.addEventListener('click', downloadCurrent);
    el.dlAll.addEventListener('click', downloadAll);
    el.dlStop.addEventListener('click', stopAll);
    el.close.addEventListener('click', close);
    el.prev.addEventListener('click', function () { go(-1); });
    el.next.addEventListener('click', function () { go(1); });
    // 點背景（舞台空白處、外框）關閉；點到圖片本身不關
    root.addEventListener('click', function (e) {
      if (e.target === root || e.target === el.stage) close();
    });
    el.img.addEventListener('dblclick', function (e) { e.preventDefault(); toggleZoom(e); });
    bindSwipe();
    // 捕獲階段處理按鍵，避免底下編輯視窗的 Esc 同時觸發「關閉詢問」
    document.addEventListener('keydown', onKey, true);
  }

  function isOpen() { return built && !el.root.hidden; }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); return; }
    if (e.key === 'Tab') {
      // 焦點留在檢視器內
      const f = [el.close, el.prev, el.next, el.dlOne, el.dlAll, el.dlStop].filter(function (b) { return !b.hidden && !b.disabled; });
      const i = f.indexOf(document.activeElement);
      e.preventDefault(); e.stopPropagation();
      const n = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
      f[n].focus();
    }
  }

  function bindSwipe() {
    let sx = 0, sy = 0, tracking = false, lastTap = 0;
    el.stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; } // 雙指交給瀏覽器縮放
      tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    }, { passive: true });
    el.stage.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      const pageZoomed = window.visualViewport && window.visualViewport.scale > 1.05;
      if (!zoomed && !pageZoomed && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { go(dx < 0 ? 1 : -1); lastTap = 0; return; }
      // 點兩下放大（手機上 dblclick 不一定觸發）
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && e.target === el.img) {
        const now = Date.now();
        if (now - lastTap < 300) { e.preventDefault(); toggleZoom({ clientX: t.clientX, clientY: t.clientY }); lastTap = 0; } else lastTap = now;
      }
    });
  }

  function toggleZoom(e) {
    zoomed = !zoomed;
    el.root.classList.toggle('is-zoomed', zoomed);
    if (zoomed && e && e.clientX !== undefined) {
      // 以點擊位置為中心放大
      const r = el.stage.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      requestAnimationFrame(function () {
        el.stage.scrollLeft = fx * el.stage.scrollWidth - r.width / 2;
        el.stage.scrollTop = fy * el.stage.scrollHeight - r.height / 2;
      });
    }
  }

  /** 讀一張原圖（快取、共用進行中的請求） */
  function getFull(id) {
    if (id in fullCache) return Promise.resolve(fullCache[id]);
    if (inflight[id]) return inflight[id];
    fetchCount += 1;
    inflight[id] = WC.api.getPhotos([id]).then(function (res) {
      const url = (res && res.photos && res.photos[id]) || null;
      fullCache[id] = url;
      return url;
    }, function (e) {
      console.warn('原圖讀取失敗', e);
      return null; // 網路錯誤不快取，下次再試
    }).finally(function () { delete inflight[id]; });
    return inflight[id];
  }

  function prefetch() {
    [idx - 1, idx + 1].forEach(function (i) {
      const it = items[i];
      if (it && it.fullId) getFull(it.fullId);
    });
  }

  function altText(i) { return (title || '活動照片') + '，第 ' + (i + 1) + ' 張，共 ' + items.length + ' 張'; }

  // ---------- 下載 ----------

  /** 民國 7 碼日期：'2026-11-05' → '1151105'；格式不對時用今天 */
  function rocDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) d = U.todayStr();
    return String(Number(d.slice(0, 4)) - 1911).padStart(3, '0') + d.slice(5, 7) + d.slice(8, 10);
  }

  const FW = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
  /** 檔名用的標題：不能用的字元換全形、控制字元與空白換底線、截到 30 字 */
  function safeTitle(t) {
    let s = String(t || '活動照片').replace(/[\\/:*?"<>|]/g, function (c) { return FW[c]; })
      .replace(/[\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, '_').replace(/^[._]+|[._]+$/g, '');
    s = Array.from(s).slice(0, 30).join('');
    return s || '活動照片';
  }

  function fileName(i) { return rocDate(meta.date) + '_' + safeTitle(meta.title) + '_' + (i + 1) + '.jpg'; }

  function dataUrlToBlob(url) {
    const m = /^data:([^;,]+)(?:;[^;,=]+=[^;,]*)*(;base64)?,(.*)$/.exec(url || ''); // 允許 ;charset=utf-8 等參數
    if (!m) throw new Error('照片資料格式不正確');
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    return new Blob([u8], { type: m[1] });
  }

  /** 不是 JPEG（示範模式的 SVG）就用 canvas 轉成 JPEG */
  function toJpegBlob(url) {
    const blob = dataUrlToBlob(url);
    if (blob.type === 'image/jpeg') return Promise.resolve(blob);
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1600; c.height = img.naturalHeight || 1200;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('轉檔失敗')); }, 'image/jpeg', 0.9);
      };
      img.onerror = function () { reject(new Error('照片無法讀取')); };
      img.src = url;
    });
  }

  /** 取得第 i 張的原圖 Blob（已存：抓原圖；待上傳：用壓縮好的 base64） */
  async function blobOf(i) {
    const it = items[i];
    if (it.fullB64) return dataUrlToBlob('data:image/jpeg;base64,' + it.fullB64);
    if (it.fullId) {
      const u = await getFull(it.fullId);
      if (u) return toJpegBlob(u);
    }
    throw new Error('第 ' + (i + 1) + ' 張原圖無法讀取');
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000); // 給瀏覽器時間開始下載
  }

  async function downloadCurrent() {
    const i = idx;
    el.dlOne.disabled = true;
    try {
      saveBlob(await blobOf(i), fileName(i));
      U.toast('已下載 ' + fileName(i), 'ok');
    } catch (e) {
      U.toast('下載失敗：' + U.errMsg(e), 'error');
    } finally {
      el.dlOne.disabled = false;
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function downloadAll() {
    const my = ++dlRun;
    const n = items.length;
    el.dlAll.disabled = true; el.dlStop.hidden = false;
    let done = 0;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse && n > 1) U.toast('手機瀏覽器可能只會下載第一張；若沒收到全部，請改用電腦，或在檢視器逐張按「下載原圖」。', 'info');
    try {
      for (let i = 0; i < n; i++) {
        if (my !== dlRun) break;
        el.dlProg.textContent = '下載中 ' + (i + 1) + ' / ' + n;
        const b = await blobOf(i);
        if (my !== dlRun) break;
        saveBlob(b, fileName(i));
        done += 1;
        if (i < n - 1) await sleep(DL_GAP_MS);
      }
      if (my === dlRun) { el.dlProg.textContent = '已下載 ' + done + ' 張'; U.toast('已下載 ' + done + ' 張照片', 'ok'); }
      else el.dlProg.textContent = '已中止（下載了 ' + done + ' / ' + n + ' 張）';
    } catch (e) {
      el.dlProg.textContent = '下載中斷（已下載 ' + done + ' / ' + n + ' 張）';
      U.toast('下載失敗：' + U.errMsg(e), 'error');
    } finally {
      if (my === dlRun) dlRun += 1; // 結束本次
      el.dlAll.disabled = false; el.dlStop.hidden = true;
    }
  }

  function stopAll() { dlRun += 1; el.dlStop.hidden = true; }

  function show() {
    const it = items[idx];
    const my = ++token;
    zoomed = false;
    el.root.classList.remove('is-zoomed');
    el.stage.scrollTop = 0; el.stage.scrollLeft = 0;
    el.count.textContent = (idx + 1) + ' / ' + items.length;
    el.img.alt = altText(idx);
    const many = items.length > 1;
    el.prev.hidden = !many; el.next.hidden = !many;
    el.prev.disabled = idx === 0; el.next.disabled = idx === items.length - 1;
    const cap = it.caption ? String(it.caption) : '';
    el.cap.textContent = cap;
    el.cap.hidden = !cap;
    el.loading.textContent = '';
    el.img.classList.remove('img-missing');
    if (it.localUrl) {
      el.img.src = it.localUrl;
      el.loading.textContent = '待上傳（預覽圖）';
      prefetch();
      return;
    }
    // 先放縮圖
    el.img.removeAttribute('src');
    if (it.thumbId) {
      WC.photos.get(it.thumbId).then(function (u) { if (my === token && u && !el.img.getAttribute('data-full')) el.img.src = u; });
    }
    el.img.removeAttribute('data-full');
    if (!it.fullId) { prefetch(); return; }
    if (it.fullId in fullCache && fullCache[it.fullId]) {
      el.img.src = fullCache[it.fullId];
      el.img.setAttribute('data-full', '1');
    } else {
      el.loading.textContent = '載入原圖中…';
      getFull(it.fullId).then(function (u) {
        if (my !== token) return;
        el.loading.textContent = u ? '' : '原圖無法讀取，顯示縮圖';
        if (u) { el.img.src = u; el.img.setAttribute('data-full', '1'); }
      });
    }
    prefetch();
  }

  function go(d) {
    const n = idx + d;
    if (n < 0 || n >= items.length) return;
    idx = n;
    show();
  }

  /** info：紀錄標題字串，或 { title, date } */
  function open(list, index, from, info) {
    if (!list || !list.length) return;
    build();
    items = list.slice();
    idx = Math.max(0, Math.min(items.length - 1, index || 0));
    meta = typeof info === 'object' && info ? { title: info.title || '', date: info.date || '' } : { title: info || '', date: '' };
    title = meta.title;
    dlRun += 1;
    el.dlProg.textContent = '';
    el.dlStop.hidden = true;
    el.dlAll.disabled = false;
    el.dlAll.hidden = items.length < 2;
    el.dlAll.textContent = '⬇ 下載這筆全部照片（' + items.length + ' 張）';
    opener = from || document.activeElement;
    el.root.hidden = false;
    document.body.classList.add('viewer-open');
    show();
    el.close.focus();
  }

  function close() {
    if (!isOpen()) return;
    token += 1;
    dlRun += 1; // 關閉時中止多張下載
    el.root.hidden = true;
    el.img.removeAttribute('src');
    document.body.classList.remove('viewer-open');
    const back = opener;
    opener = null;
    if (back && document.contains(back)) back.focus();
  }

  /** 由紀錄的 photos 陣列（{id, thumbId, caption?, note?}）轉成 items */
  function fromPhotos(photos) {
    return (photos || []).map(function (p) {
      return { thumbId: p.thumbId, fullId: p.id, caption: p.caption || p.note || '' };
    });
  }

  return {
    open: open, close: close, isOpen: isOpen, fromPhotos: fromPhotos, fileName: fileName, safeTitle: safeTitle,
    fetchCount: function () { return fetchCount; }
  };
})();
