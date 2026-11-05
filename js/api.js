/**
 * 後端呼叫層。畫面程式只呼叫 WC.api.xxx()，不管背後是 GAS 還是示範模式。
 *
 * 呼叫 GAS 的做法（避開 CORS preflight）：
 *   fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON })
 *   text/plain 屬於「簡單請求」，瀏覽器不會先送 OPTIONS；GAS 回應經 302 轉到 googleusercontent.com，
 *   該網域會帶 Access-Control-Allow-Origin: *，所以前端讀得到回應。
 */
WC.api = (function () {
  const cfg = window.WC_CONFIG || {};
  const forceDemo = /[?&]demo=1\b/.test(location.search);
  const isDemo = forceDemo || !cfg.GAS_URL || !cfg.CLIENT_ID;

  let idToken = '';
  function setToken(t) { idToken = t || ''; }

  /** 送一個 action 到 GAS；失敗時丟出 Error（帶 code） */
  async function call(action, params) {
    if (isDemo) return WC.demo.handle(action, params || {});
    let res;
    try {
      res = await fetch(cfg.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, params: params || {}, idToken: idToken }),
        redirect: 'follow'
      });
    } catch (e) {
      throw makeError('NETWORK', '連不上伺服器，請檢查網路連線。');
    }
    let body;
    try { body = await res.json(); } catch (e) {
      throw makeError('BAD_RESPONSE', '伺服器回應格式錯誤（HTTP ' + res.status + '），請確認 GAS 已部署且存取權為「任何人」。');
    }
    if (!body.ok) {
      const err = makeError(body.error && body.error.code, body.error && body.error.message);
      if (body.error && body.error.warnings) err.warnings = body.error.warnings; // NEED_CONFIRM 的提醒清單
      if (body.error && body.error.splitWarnings) err.splitWarnings = body.error.splitWarnings; // v2.3.1：可能是名字、已換成 [S?] 的段落
      if (body.error && body.error.candidates) err.candidates = body.error.candidates; // 稱呼對到多位學生時的候選姓名（只含相符者）
      if (err.code === 'BAD_TOKEN' || err.code === 'NO_TOKEN') WC.auth.onTokenInvalid();
      throw err;
    }
    return body.data;
  }

  function makeError(code, message) {
    const e = new Error(message || '發生錯誤');
    e.code = code || 'UNKNOWN';
    return e;
  }

  return {
    isDemo: isDemo,
    setToken: setToken,
    bootstrap: function () { return call('bootstrap'); },
    listRecords: function (month) { return call('listRecords', { month: month }); },
    saveRecord: function (record, expectedUpdatedAt) {
      return call('saveRecord', { record: record, expectedUpdatedAt: expectedUpdatedAt || '' });
    },
    deleteRecord: function (id) { return call('deleteRecord', { id: id }); },
    /** full/thumb 為不含 data: 前綴的 base64 JPEG */
    uploadPhoto: function (month, full, thumb, w, h) {
      return call('uploadPhoto', { month: month, full: full, thumb: thumb, w: w, h: h });
    },
    getPhotos: function (ids) { return call('getPhotos', { ids: ids }); },
    /** 第 2 階段：AI 整理。record 只含 title、date、unit、layout、rawText、photoCount、photoNotes（不含照片本身） */
    aiDraft: function (record, confirm) { return call('aiDraft', { record: record, confirm: !!confirm }); }
  };
})();
