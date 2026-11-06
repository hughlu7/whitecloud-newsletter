# 白雲家訊

班級活動紀錄與每月家訊（預設六頁，一個單元一頁，主編可增刪單元）的編排網頁。老師平常記錄活動、附上照片，月底由主編挑選素材編成家訊。

- 前端：純 HTML／CSS／原生 JavaScript，放在 GitHub Pages
- 後端：Google Apps Script＋Google 試算表＋Google 雲端硬碟（不在這個儲存庫）

## 設定

只需要修改 `js/config.js`：

- `GAS_URL`：Apps Script 部署為網頁應用程式後的網址（結尾是 `/exec`）
- `CLIENT_ID`：Google OAuth 用戶端 ID

兩個都沒填時，網頁會以示範模式運作，使用假資料，不會連到任何後端。

目前版本：v2.6.0（主編可在網頁「⚙ 設定」管理家訊單元與班級設定，以及新增、改名、改角色、停用／啟用成員）
