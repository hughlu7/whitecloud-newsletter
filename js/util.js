/**
 * 共用小工具：命名空間、HTML 跳脫、日期月份、提示訊息。
 * 其他檔案都掛在 window.WC 底下，不使用 ES module（方便直接雙擊 index.html 開示範模式）。
 */
window.WC = window.WC || {};

WC.util = (function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /** 把任何文字變成可安全放進 innerHTML 的字串 */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 今天（本地時區）YYYY-MM-DD */
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function currentMonth() { return todayStr().slice(0, 7); }

  /** 'YYYY-MM' 加減月數 */
  function shiftMonth(month, delta) {
    const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1 + delta;
    const d = new Date(y, m, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /** '2026-11' → '2026年11月' */
  function monthLabel(month) {
    return month.slice(0, 4) + '年' + Number(month.slice(5, 7)) + '月';
  }

  /** '2026-11-05' → '11/5（四）' */
  function dateLabel(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || '';
    const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + '日一二三四五六'[d.getDay()] + '）';
  }

  function fmtBytes(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return Math.round(n / 1024) + 'KB';
  }

  /** 畫面右下角短暫提示；type 可為 'ok' | 'error' | 'info' */
  function toast(msg, type) {
    const box = $('#toast');
    const item = document.createElement('div');
    item.className = 'toast-item toast-' + (type || 'info');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = msg;
    item.appendChild(text);
    item.title = msg;
    box.appendChild(item);
    // 手機上長訊息會縮成兩行；點一下展開全文並停留較久
    let life = type === 'error' ? 5000 : 2500;
    let timers = [];
    const schedule = function () {
      timers.forEach(clearTimeout);
      timers = [setTimeout(function () { item.classList.add('hide'); }, life),
        setTimeout(function () { item.remove(); }, life + 600)];
    };
    item.addEventListener('click', function () { item.classList.add('expand'); life = 8000; schedule(); });
    schedule();
  }

  /** 把任意錯誤轉成使用者看得懂的一句話 */
  function errMsg(err) {
    if (!err) return '發生未知錯誤';
    if (err.message) return err.message;
    return String(err);
  }

  return {
    esc: esc, $: $, $all: $all, todayStr: todayStr, currentMonth: currentMonth, shiftMonth: shiftMonth,
    monthLabel: monthLabel, dateLabel: dateLabel, fmtBytes: fmtBytes, toast: toast, errMsg: errMsg
  };
})();
