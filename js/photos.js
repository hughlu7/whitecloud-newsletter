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
      try { result = (await WC.api.getPhotos(batch)).photos || {}; } catch (e) { console.warn('照片讀取失敗', e); }
      batch.forEach(function (id) {
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

  return { get: get, prime: prime, hydrate: hydrate };
})();
