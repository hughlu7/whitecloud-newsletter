/**
 * 照片顯示：Drive 資料夾不公開，照片一律經 GAS 的 getPhotos 取回 data URL 再顯示。
 * 這裡負責：記憶體快取、合併請求（同一時間要的 ID 一起送，每批最多 20 張）。
 * 用法：<img data-photo-id="檔案ID">，再呼叫 WC.photos.hydrate(容器)。
 */
WC.photos = (function () {
  const cache = {};     // fileId → data URL（或 null 代表取不到）
  const waiting = {};   // fileId → [resolve...]
  let queue = [];
  let timer = null;
  const BATCH = 20;

  function get(id) {
    if (id in cache) return Promise.resolve(cache[id]);
    return new Promise(function (resolve) {
      if (!waiting[id]) { waiting[id] = []; queue.push(id); }
      waiting[id].push(resolve);
      if (!timer) timer = setTimeout(flush, 30);
    });
  }

  async function flush() {
    timer = null;
    const ids = queue; queue = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      let result = null;
      let deferred = [];
      try {
        const res = await WC.api.getPhotos(batch);
        result = res.photos || {};
        deferred = res.deferred || []; // 後端因回應上限延後的 ID：放回佇列，下一輪再要
      } catch (e) { console.warn('照片讀取失敗', e); }
      if (deferred.length) {
        deferred.forEach(function (id) { if (queue.indexOf(id) < 0) queue.push(id); });
        if (!timer) timer = setTimeout(flush, 30);
      }
      batch.forEach(function (id) {
        if (deferred.indexOf(id) >= 0) return;
        // 只有後端明確回應時才快取（含明確的 null）；網路或登入錯誤不快取，之後重畫會再試
        const url = result ? (result[id] || null) : null;
        if (result) cache[id] = url;
        (waiting[id] || []).forEach(function (r) { r(url); });
        delete waiting[id];
      });
    }
  }

  /** 剛上傳的照片：直接把本地預覽放進快取，不必再下載 */
  function prime(id, url) { cache[id] = url; }

  /** 把容器內所有 img[data-photo-id] 填上圖片 */
  function hydrate(root) {
    WC.util.$all('img[data-photo-id]', root).forEach(function (img) {
      const id = img.getAttribute('data-photo-id');
      if (img.getAttribute('data-loaded') === id) return;
      get(id).then(function (url) {
        if (img.getAttribute('data-photo-id') !== id) return;
        if (id in cache) img.setAttribute('data-loaded', id); // 沒快取（暫時失敗）就不標記，下次重畫再試
        if (url) { img.src = url; img.classList.remove('img-missing'); } else { img.classList.add('img-missing'); img.alt = '照片無法讀取'; }
      });
    });
  }

  /** 已快取的縮圖（沒有就回 null，不發請求）；列印預覽先用縮圖排版時使用 */
  function cached(id) { return cache[id] || null; }

  return { get: get, prime: prime, hydrate: hydrate, cached: cached };
})();
