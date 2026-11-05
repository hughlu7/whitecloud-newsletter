/**
 * 全域狀態：目前月份、使用者、設定、該月紀錄、篩選條件。
 * 畫面程式讀寫這裡，改完呼叫 WC.app.render() 重畫。
 */
WC.state = {
  month: '',          // 'YYYY-MM'
  me: null,           // { email, name, role }
  config: null,       // { className, newsletterName, footer, units[], layouts[], maxPhotos }
  records: [],        // 該月紀錄（後端回傳，含 canEdit）
  filterUnit: '',     // '' = 全部
  filterStatus: '',   // '' = 全部
  tab: 'library'      // 'library' | 'pages'（版型手冊分頁已移除，說明改在新增視窗的版型卡片與六頁編排的「?」）
};
