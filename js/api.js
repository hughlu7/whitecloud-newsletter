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
  const REQUEST_TIMEOUT_MS = 120000;
  function setToken(t) { idToken = t || ''; }

  // v2.6：只限主編的動作。收到 FORBIDDEN 代表「自己剛被改成老師」→ 重新讀一次身分，讓「⚙ 設定」分頁消失
  const EDITOR_ONLY = { getSettings: 1, saveSettings: 1, listMembers: 1, saveMember: 1 };

  /**
   * 送一個 action 到 GAS；失敗時丟出 Error（帶 code）。
   * v2.6：任何請求收到 NOT_MEMBER（被停用或移出成員名單）→ 清掉 token、顯示「無法使用」畫面（WC.app.onNotMember）；
   *       主編限定動作收到 FORBIDDEN → WC.app.refreshRole() 重新讀身分。示範模式走同樣的處理。
   */
  async function call(action, params) {
    try {
      return await rawCall(action, params);
    } catch (e) {
      if (e && e.code === 'NOT_MEMBER' && action !== 'bootstrap' && WC.app && WC.app.onNotMember) WC.app.onNotMember(e.message);
      // 複核 R5：目前畫面上是主編時，任何 FORBIDDEN 都重讀身分（可能剛被改成老師）；老師的一般權限錯誤不必
      const shownEditor = WC.state && WC.state.me && WC.state.me.role === '主編';
      if (e && e.code === 'FORBIDDEN' && (EDITOR_ONLY[action] || shownEditor) && action !== 'bootstrap' && WC.app && WC.app.refreshRole) WC.app.refreshRole();
      throw e;
    }
  }

  async function rawCall(action, params) {
    if (isDemo) return WC.demo.handle(action, params || {});
    const sent = idToken;   // 這個請求用的 token（回來時若已換新 token，不要因舊 token 失效而登出）
    let res;
    // v2.4.0：網路卡住時不要讓「送出」永遠等下去（GAS 冷啟動加上傳最慢約 30–60 秒，給 120 秒）
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    try {
      res = await fetch(cfg.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, params: params || {}, idToken: sent }),
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') throw makeError('TIMEOUT', '伺服器太久沒有回應，請稍後再試。');
      throw makeError('NETWORK', '連不上伺服器，請檢查網路連線。');
    }
    if (timer) clearTimeout(timer);
    let body;
    try { body = await res.json(); } catch (e) {
      throw makeError('BAD_RESPONSE', '伺服器回應格式錯誤（HTTP ' + res.status + '），請確認 GAS 已部署且存取權為「任何人」。');
    }
    if (!body.ok) {
      const err = makeError(body.error && body.error.code, body.error && body.error.message);
      // v2.6：錯誤附帶的欄位（例如 DUPLICATE_MEMBER 的 email、inactive；UNIT_HAS_RECORDS 的 unit、count）一併帶給畫面
      Object.keys(body.error || {}).forEach(function (k) { if (k !== 'code' && k !== 'message' && k !== 'stack') err[k] = body.error[k]; });
      // v2.4：同時有好幾個請求（bootstrap＋listRecords、照片並行）都回 BAD_TOKEN 時，只處理一次
      if ((err.code === 'BAD_TOKEN' || err.code === 'NO_TOKEN') && sent === idToken) WC.auth.onTokenInvalid();
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
    /** 第 2 階段：AI 整理。record 只含 title、date、unit、layout、rawText、photoCount、photoNotes（不含照片本身；v2.4 起原文直接送出） */
    aiDraft: function (record) { return call('aiDraft', { record: record }); },
    /** v2.5 主編設定：讀（含 configVersion、各單元紀錄數）與存（payload 見 settings.js） */
    getSettings: function () { return call('getSettings'); },
    saveSettings: function (payload) { return call('saveSettings', payload); },
    /** v2.6 主編管理成員：讀清單（含 membersVersion）與逐筆存（{ expectedVersion, op:'add'|'update', member }） */
    listMembers: function () { return call('listMembers'); },
    saveMember: function (payload) { return call('saveMember', payload); }
  };
})();
