/**
 * 照片前處理：在瀏覽器用 canvas 壓縮，產生「原圖」（長邊 1600px、約 300KB）與「縮圖」（長邊 400px）。
 * 上傳到後端的只有壓縮後的 JPEG，原始大檔不會離開瀏覽器。
 * 重新繪製到 canvas 也會順便去掉照片內的 EXIF（含 GPS 位置）。
 */
WC.image = (function () {
  const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_INPUT_BYTES = 10 * 1024 * 1024;
  const FULL_EDGE = 1600, FULL_TARGET = 300 * 1024;
  const THUMB_EDGE = 400, THUMB_QUALITY = 0.7;

  /** 檢查檔案；不合格回傳錯誤訊息字串，合格回傳 '' */
  function checkFile(file) {
    if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
      return file.name + '：不支援 iPhone 的 HEIC 格式。請從「照片」相簿直接選取（會自動轉成 JPG），或到 iPhone「設定 → 相機 → 格式」改成「最相容」。';
    }
    if (ACCEPT.indexOf(file.type) < 0) return file.name + '：只接受 JPG、PNG、WebP';
    if (file.size > MAX_INPUT_BYTES) return file.name + '：超過 10MB';
    return '';
  }

  /** 讀成可繪製的影像；createImageBitmap 會依 EXIF 轉正方向（不支援時退回 <img>） */
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* 改用 img */ }
    }
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(file.name + '：無法讀取這張圖片')); };
      img.src = url;
    });
  }

  function drawScaled(src, maxEdge) {
    const sw = src.width, sh = src.height;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // PNG 透明背景轉 JPEG 時填白
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return canvas;
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('壓縮失敗')); }, 'image/jpeg', quality);
    });
  }

  /** 逐步降低品質直到小於目標大小；最低 0.5 */
  async function encodeUnder(canvas, target) {
    let q = 0.85, blob = await toBlob(canvas, q);
    while (blob.size > target && q > 0.5) {
      q = Math.round((q - 0.1) * 100) / 100;
      blob = await toBlob(canvas, q);
    }
    return blob;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(new Error('讀取壓縮結果失敗')); };
      r.readAsDataURL(blob);
    });
  }

  /**
   * 壓縮一個檔案。
   * 回傳 { fullB64, thumbB64, previewUrl, w, h, originalBytes, compressedBytes }
   */
  async function compress(file) {
    const bmp = await loadBitmap(file);
    const fullCanvas = drawScaled(bmp, FULL_EDGE);
    const thumbCanvas = drawScaled(fullCanvas, THUMB_EDGE);
    if (bmp.close) bmp.close();
    const fullBlob = await encodeUnder(fullCanvas, FULL_TARGET);
    const thumbBlob = await toBlob(thumbCanvas, THUMB_QUALITY);
    return {
      fullB64: await blobToBase64(fullBlob),
      thumbB64: await blobToBase64(thumbBlob),
      previewUrl: URL.createObjectURL(thumbBlob),
      w: fullCanvas.width,
      h: fullCanvas.height,
      originalBytes: file.size,
      compressedBytes: fullBlob.size
    };
  }

  return { ACCEPT: ACCEPT, checkFile: checkFile, compress: compress };
})();
