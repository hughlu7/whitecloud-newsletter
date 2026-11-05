/**
 * 白雲家訊 前端設定 — 部署前只需要改這個檔案。
 *
 * GAS_URL：Apps Script 部署為網頁應用程式後得到的網址（結尾是 /exec）
 * CLIENT_ID：Google Cloud 建立的 OAuth 用戶端 ID（要和 gas/Code.gs 的 CLIENT_ID 相同）
 *
 * 兩個都沒填時，頁面會自動進入「示範模式」（假資料，只存在瀏覽器記憶體，重新整理就清空）。
 * 已填好時，也可以在網址後面加 ?demo=1 強制進入示範模式。
 */
window.WC_CONFIG = {
  GAS_URL: '',
  CLIENT_ID: ''
};
