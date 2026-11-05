/**
 * 口述轉文字：使用瀏覽器內建 Web Speech API（Chrome／Edge 支援）。
 * 注意：Chrome 會把語音送到 Google 伺服器辨識；本系統不保存錄音，只把辨識出的文字插入文字框。
 * 不支援的瀏覽器（例如 Firefox）會隱藏按鈕並顯示說明。
 */
WC.speech = (function () {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let active = false;
  let target = null;
  let onState = function () {};

  function supported() { return !!Rec; }

  /** 在游標位置插入文字 */
  function insertText(textarea, text) {
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start), after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const pos = start + text.length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 開始口述。textarea：要寫入的框；stateCb(state, detail)：state 為 'listening' | 'interim' | 'stopped' | 'error'
   */
  function start(textarea, stateCb) {
    if (!Rec || active) return;
    target = textarea;
    onState = stateCb || function () {};
    rec = new Rec();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = function (ev) {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) insertText(target, r[0].transcript);
        else interim += r[0].transcript;
      }
      onState('interim', interim);
    };
    rec.onerror = function (ev) {
      const map = {
        'not-allowed': '麥克風權限被拒絕，請在網址列左側允許使用麥克風。',
        'no-speech': '沒有聽到聲音，請再試一次。',
        'network': '語音辨識需要網路連線。',
        'audio-capture': '找不到麥克風。'
      };
      onState('error', map[ev.error] || ('語音辨識錯誤：' + ev.error));
    };
    rec.onend = function () { active = false; onState('stopped'); };
    rec.start();
    active = true;
    onState('listening');
  }

  function stop() { if (rec && active) rec.stop(); }
  function isActive() { return active; }

  return { supported: supported, start: start, stop: stop, isActive: isActive };
})();
