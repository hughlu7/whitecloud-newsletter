/**
 * 登入：Google Identity Services（GIS）官方登入按鈕 → 取得 id_token（JWT）→ 交給後端驗證。
 * 示範模式不載入 GIS。
 *
 * v2.4 F3：重新整理免重登。
 *   1. 先看 sessionStorage 有沒有本分頁之前登入的 id_token；aud 是本系統、而且離到期還有 5 分鐘以上，就直接用，
 *      不等 GIS 載入（省下 GIS 載入與 One Tap 的時間）。後端仍會完整驗證（tokeninfo＋成員表）。
 *   2. 沒有（或已接近到期）→ 載入 GIS，auto_select＋prompt() 讓 Google 自動重新取得 id_token；
 *      Google 不自動登入（例如 FedCM 自動登入的冷卻時間、使用者關過 One Tap）時，才需要按登入鈕。
 *   安全取捨（詳見規格書 v2.4、進度.md 決策）：
 *   - 只用 sessionStorage（只在這個分頁、關閉分頁就清掉），不用 localStorage；登出、token 失效、不在成員表時立刻清除。
 *   - 存的時間只到 exp 前 5 分鐘（id_token 本身約 1 小時到期）；過期的 token 讀到就刪。
 *   - XSS 能讀 sessionStorage，但同樣能讀記憶體中的 token（掛勾 fetch）；本站 CSP 只允許自己的腳本與 GIS、
 *     connect-src／img-src 只到 Google 與本站，降低被偷送出去的管道。id_token 只能用來呼叫本系統（aud 檢查），不能存取 Google 帳號。
 */
WC.auth = (function () {
  const cfg = window.WC_CONFIG || {};
  const STORE_KEY = 'wc_id_token';
  const MARGIN_MS = 5 * 60 * 1000;   // 到期前 5 分鐘就不再沿用
  let onSignedIn = function () {};
  let gisReady = null;
  let gisInited = false;
  let expiryTimer = null;

  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { gisReady = null; reject(new Error('無法載入 Google 登入元件，請檢查網路。')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }

  /** 解出 JWT payload（只用來顯示 email 與判斷到期；真正驗證在後端） */
  function payload(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(json) || {};
    } catch (e) { return {}; }
  }
  function decodeEmail(token) { return payload(token).email || ''; }

  /** 這個 token 還能沿用多久（毫秒）；不屬於本系統、格式不對或快到期回 0 */
  function usableMs(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return 0;
    const p = payload(token);
    if (p.aud !== cfg.CLIENT_ID) return 0;
    if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') return 0;
    const left = Number(p.exp) * 1000 - MARGIN_MS - Date.now();
    return left > 0 ? left : 0;
  }

  function store(token) {
    const left = usableMs(token);
    try {
      if (left > 0) sessionStorage.setItem(STORE_KEY, token); else sessionStorage.removeItem(STORE_KEY);
    } catch (e) { /* 無痕或封鎖儲存：只是重新整理時要再登入 */ }
    clearTimeout(expiryTimer);
    // 到了「exp 前 5 分鐘」就從 sessionStorage 移除（記憶體中的 token 照用，到期時後端回 BAD_TOKEN 會請使用者重新登入）
    if (left > 0) expiryTimer = setTimeout(forget, Math.min(left, 2147483000));
  }

  function readStored() {
    let t = '';
    try { t = sessionStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
    if (t && usableMs(t) > 0) return t;
    forget();
    return '';
  }

  /** 清除暫存的 token（登出、token 失效、不在成員表） */
  function forget() {
    clearTimeout(expiryTimer);
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* 略過 */ }
  }

  function initGis() {
    if (gisInited) return;
    gisInited = true;
    google.accounts.id.initialize({
      client_id: cfg.CLIENT_ID,
      callback: function (resp) {
        WC.api.setToken(resp.credential);
        store(resp.credential);
        hideLogin();
        onSignedIn(decodeEmail(resp.credential));
      },
      auto_select: true,
      cancel_on_tap_outside: false
    });
  }

  async function init(cb) {
    onSignedIn = cb;
    const saved = readStored();
    if (saved) {
      WC.api.setToken(saved);
      store(saved);   // 重新排定到期移除
      // GIS 仍在背景載入，token 失效時才能立刻顯示登入鈕；載入失敗不影響目前的登入
      loadGis().then(initGis).catch(function () {});
      onSignedIn(decodeEmail(saved));
      return;
    }
    await loadGis();
    initGis();
    showLogin('');
  }

  function showLogin(message) {
    const box = WC.util.$('#login');
    box.hidden = false;
    WC.util.$('#login-msg').textContent = message || '';
    const btn = WC.util.$('#login-btn');
    btn.innerHTML = '';
    google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', shape: 'pill' });
    google.accounts.id.prompt();   // auto_select：可以的話 Google 會直接回呼 callback，不必按按鈕
  }

  function hideLogin() { WC.util.$('#login').hidden = true; }

  /** api.js 收到 BAD_TOKEN／NO_TOKEN 時呼叫 */
  function onTokenInvalid() {
    WC.api.setToken('');
    forget();
    const msg = '登入已過期，請重新登入（尚未儲存的內容仍保留在視窗中）。';
    loadGis().then(function () { initGis(); showLogin(msg); }).catch(function (e) {
      WC.util.$('#login').hidden = false;
      WC.util.$('#login-msg').textContent = msg + ' ' + WC.util.errMsg(e);
    });
  }

  function signOut() {
    WC.api.setToken('');
    forget();
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    location.reload();
  }

  return { init: init, onTokenInvalid: onTokenInvalid, signOut: signOut, showLogin: showLogin, forget: forget };
})();
