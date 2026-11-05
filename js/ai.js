/**
 * 「AI 幫我整理」（第 2 階段，v2.0）。
 *
 * 流程：說一說有內容才能按 → WC.api.aiDraft(record) →
 *   - NEED_CONFIRM：顯示去名化疑點（例如「安安」可能是兩位孩子），老師選「照樣送出」（confirm:true 再送一次）或回去修改
 *   - 成功：摘要、文案、圖說已有內容時先詢問「覆蓋／只填空白／不要」，再填進欄位（不直接存檔），並顯示 AI 警告
 *   - 失敗：顯示錯誤，不改任何欄位
 * 送到後端的只有文字欄位與照片張數、老師備註；學生名單與去名化都在伺服器端（GAS），前端拿不到名單。
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
    const ready = WC.state.ai.rosterReady !== false;   // v2.1 H1：名單沒有啟用學生時停用
    const can = ready && !running && WC.editor.aiCanUse();
    btn.disabled = !can;
    btn.title = !ready ? '請先在試算表填寫學生名單' : can ? '' : '先在上面寫下或口述原始紀錄';
    btn.textContent = running ? '✨ 整理中…' : '✨ AI 幫我整理';
    const note = U.$('#ai-roster-note');
    note.hidden = ready;
    note.textContent = ready ? '' : (WC.state.ai.duplicateCodes ? '學生名單有重複的代號，請管理者修正後才能使用 AI 整理。' : '請先在試算表的「學生名單」分頁填寫學生名單，才能使用 AI 整理（送出前要把孩子的名字換成代號）。');
  }

  function reset() {
    seq += 1;
    running = false;
    pending = null;
    setStatus('');
    U.$('#ai-confirm').hidden = true;
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
    ROSTER_EMPTY: '請先在試算表的「學生名單」分頁填寫學生名單，才能使用 AI 整理。',
    ROSTER_DUPLICATE: '學生名單有重複的代號，請管理者修正後再使用。',
    AI_LIMIT: null, AI_BUSY: null, AI_ERROR: null, AI_DISABLED: null
  };

  async function run(confirm) {
    if (running || !WC.editor.aiCanUse()) return;
    const my = ++seq;
    running = true;
    U.$('#ai-confirm').hidden = true;
    showWarnings([]);
    setStatus('AI 整理中，大約 5–15 秒…');
    refresh();
    try {
      const data = await WC.api.aiDraft(WC.editor.aiInput(), confirm);
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
      if (e.code === 'NEED_CONFIRM') {
        showConfirm(e.warnings || [], e.candidates || []);
        setStatus('');
      } else {
        setStatus('AI 整理失敗：' + ((MESSAGES[e.code]) || U.errMsg(e)) + '（欄位沒有被改動）');
      }
    } finally {
      if (my === seq) { running = false; refresh(); }
    }
  }

  /**
   * NEED_CONFIRM：列出提醒；稱呼對到多位學生時，列出候選姓名按鈕（v2.1）。
   * 點選後在原始紀錄把那個稱呼換成 [[姓名]] 標記（只換第一個還沒標記的），全部選完自動再送一次。
   * 候選姓名只有「與這個稱呼相符」的學生（伺服器只回這些），不會拿到整份名單。
   */
  function showConfirm(warnings, candidates) {
    const ul = U.$('#ai-confirm-list');
    ul.innerHTML = '';
    warnings.forEach(function (w) { const li = document.createElement('li'); li.textContent = w; ul.appendChild(li); });
    const pick = U.$('#ai-candidates');
    pick.innerHTML = '';
    candidates.forEach(function (c) {
      const row = document.createElement('div');
      row.className = 'ai-cand';
      const lab = document.createElement('span');
      lab.textContent = '「' + c.text + '」是：';
      row.appendChild(lab);
      (c.names || []).forEach(function (n) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-sm ai-cand-btn';
        b.textContent = n;
        b.addEventListener('click', function () {
          if (WC.editor.aiMarkName(c.text, n)) {
            row.classList.add('done');
            Array.prototype.forEach.call(row.querySelectorAll('button'), function (x) { x.disabled = true; x.classList.toggle('on', x === b); });
            if (!pick.querySelector('.ai-cand:not(.done)')) run(false);   // 全部選完：用新的標記再送一次（仍會經過伺服器檢查）
          } else {
            setStatus('原始紀錄裡找不到「' + c.text + '」，請直接修改後再按 AI。');
          }
        });
        row.appendChild(b);
      });
      pick.appendChild(row);
    });
    pick.hidden = !candidates.length;
    U.$('#ai-confirm').hidden = false;
    const first = pick.querySelector('button') || U.$('#ai-confirm-go');
    first.focus();
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
    U.$('#btn-ai').addEventListener('click', function () { run(false); });
    U.$('#ai-confirm-go').addEventListener('click', function () { run(true); });
    U.$('#ai-confirm-back').addEventListener('click', function () {
      U.$('#ai-confirm').hidden = true;
      const t = document.querySelector('#editor-form [name=rawText]');
      if (t) t.focus();
    });
    U.$('#ai-overwrite-yes').addEventListener('click', function () { if (pending) apply(pending, false); });
    U.$('#ai-overwrite-empty').addEventListener('click', function () { if (pending) apply(pending, true); });
    U.$('#ai-overwrite-no').addEventListener('click', function () {
      pending = null; U.$('#ai-overwrite').hidden = true; setStatus('沒有改動欄位。');
    });
  }

  return { bind: bind, refresh: refresh, reset: reset, enabled: enabled };
})();
