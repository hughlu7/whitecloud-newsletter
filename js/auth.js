/**
 * 登入：Google Identity Services（GIS）官方登入按鈕 → 取得 id_token（JWT）→ 交給後端驗證。
 * id_token 只放在記憶體，不存 localStorage；約 1 小時後失效，後端回 BAD_TOKEN 時會要求重新登入。
 * 示範模式不載入 GIS。
 */
WC.auth = (function () {
  const cfg = window.WC_CONFIG || {};
  let onSignedIn = function () {};
  let gisReady = null;

  function loadGis() {
    if (gisReady) return gisReady;
    gisReady = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('無法載入 Google 登入元件，請檢查網路。')); };
      document.head.appendChild(s);
    });
    return gisReady;
  }

  /** 從 JWT 取出 email（只用來顯示；真正驗證在後端） */
  function decodeEmail(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(json).email || '';
    } catch (e) { return ''; }
  }

  async function init(cb) {
    onSignedIn = cb;
    await loadGis();
    google.accounts.id.initialize({
      client_id: cfg.CLIENT_ID,
      callback: function (resp) {
        WC.api.setToken(resp.credential);
        hideLogin();
        onSignedIn(decodeEmail(resp.credential));
      },
      auto_select: true,
      cancel_on_tap_outside: false
    });
    showLogin('');
  }

  function showLogin(message) {
    const box = WC.util.$('#login');
    box.hidden = false;
    WC.util.$('#login-msg').textContent = message || '';
    const btn = WC.util.$('#login-btn');
    btn.innerHTML = '';
    google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW', shape: 'pill' });
    google.accounts.id.prompt();
  }

  function hideLogin() { WC.util.$('#login').hidden = true; }

  /** api.js 收到 BAD_TOKEN／NO_TOKEN 時呼叫 */
  function onTokenInvalid() {
    WC.api.setToken('');
    if (window.google && google.accounts) showLogin('登入已過期，請重新登入（尚未儲存的內容仍保留在視窗中）。');
  }

  function signOut() {
    WC.api.setToken('');
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    location.reload();
  }

  return { init: init, onTokenInvalid: onTokenInvalid, signOut: signOut, showLogin: showLogin };
})();
