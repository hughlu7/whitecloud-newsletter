/**
 * 「AI 幫我整理」（第 2 階段；v2.4 起不使用學生名單與去名化）。
 *
 * 流程：說一說有內容才能按 → WC.api.aiDraft(record) →
 *   - 成功：摘要、文案、圖說已有內容時先詢問「覆蓋／只填空白／不要」，再填進欄位（不直接存檔），並顯示 AI 警告
 *   - 失敗：顯示錯誤，不改任何欄位
 * 送到後端的只有文字欄位（原文，含孩子的名字）與照片張數、老師備註；按鈕旁固定提示會送到 Anthropic 處理。
 * 所有文字一律用 textContent。
 */
WC.ai = (function () {
  const U = WC.util;
  let running = false;
  let pending = null;  // 等待老師決定覆蓋與否的 AI 結果
  let seq = 0;

  function enabled() {
    return !!(WC.state.ai && WC.state.ai.enabled);
  }

  function setStatus(t) { U.$('#ai-status').textContent = t || ''; }

  function refresh() {
    const box = U.$('#ai-box');
    box.hidden = !enabled();
    if (!enabled()) return;
    const btn = U.$('#btn-ai');
    const can = !running && WC.editor.aiCanUse();
    btn.disabled = !can;
    btn.title = can ? '' : '先在上面寫下或口述原始紀錄';
    btn.textContent = running ? '✨ 整理中…' : '✨ AI 幫我整理';
  }

  function reset() {
    seq += 1;
    running = false;
    pending = null;
    setStatus('');
    U.$('#ai-overwrite').hidden = true;
    showWarnings([]);
    refresh();
  }

  function showWarnings(list) {
    const ul = U.$('#ai-warnings');
    ul.innerHTML = '';
    (list || []).forEach(function (w) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    });
    ul.hidden = !(list && list.length);
  }

  const MESSAGES = {
    TOO_SHORT: '原始紀錄太短，AI 沒有東西可以整理；請多寫幾句再試。',
    AI_LIMIT: null, AI_BUSY: null, AI_ERROR: null, AI_DISABLED: null
  };

  async function run() {
    if (running || !WC.editor.aiCanUse()) return;
    const my = ++seq;
    running = true;
    showWarnings([]);
    setStatus('AI 整理中，大約 5–15 秒…');
    refresh();
    try {
      const data = await WC.api.aiDraft(WC.editor.aiInput());
      if (my !== seq) return;
      if (WC.editor.aiHasContent()) {
        pending = data;
        U.$('#ai-overwrite').hidden = false;
        U.$('#ai-overwrite-yes').focus();
        setStatus('AI 已整理好。');
      } else {
        apply(data, false);
      }
    } catch (e) {
      if (my !== seq) return;
      setStatus('AI 整理失敗：' + ((MESSAGES[e.code]) || U.errMsg(e)) + '（欄位沒有被改動）');
    } finally {
      if (my === seq) { running = false; refresh(); }
    }
  }

  function apply(data, onlyEmpty) {
    WC.editor.aiApply(data, onlyEmpty);
    pending = null;
    U.$('#ai-overwrite').hidden = true;
    const warn = (data.warnings || []).slice();
    showWarnings(warn);
    setStatus('已填入「進階」的摘要、家訊文案' + (data.captions ? '與照片圖說' : '') + '，請檢查後再送出。');
    const adv = U.$('#advanced');
    if (adv && adv.scrollIntoView) adv.scrollIntoView({ block: 'nearest' });
  }

  function bind() {
    U.$('#btn-ai').addEventListener('click', function () { run(); });
    U.$('#ai-overwrite-yes').addEventListener('click', function () { if (pending) apply(pending, false); });
    U.$('#ai-overwrite-empty').addEventListener('click', function () { if (pending) apply(pending, true); });
    U.$('#ai-overwrite-no').addEventListener('click', function () {
      pending = null; U.$('#ai-overwrite').hidden = true; setStatus('沒有改動欄位。');
    });
  }

  return { bind: bind, refresh: refresh, reset: reset, enabled: enabled };
})();
