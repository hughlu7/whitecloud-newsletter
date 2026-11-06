/**
 * 全域狀態：目前月份、使用者、設定、該月紀錄、篩選條件。
 * 畫面程式讀寫這裡，改完呼叫 WC.app.render() 重畫。
 */
/** 前端版本（v2.4 起顯示在頁面最下方；和後端 Code.gs 的 VERSION 一起改） */
WC.VERSION = '2.6.0';

WC.state = {
  month: '',          // 'YYYY-MM'
  me: null,           // { email, name, role }
  config: null,       // { className, newsletterName, footer, units[], layouts[], maxPhotos, emptyText }
  configVersion: '',  // v2.5：設定版本（bootstrap／getSettings／saveSettings 回傳），用來判斷別人是否改過設定
  ai: null,           // { enabled }：後端是否已設定 AI（第 2 階段）
  records: [],        // 該月紀錄（後端回傳，含 canEdit）
  filterUnit: '',     // '' = 全部
  filterStatus: '',   // '' = 全部
  tab: 'library'      // 'library' | 'pages' | 'settings'（v2.5，只有主編）
};
