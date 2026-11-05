/**
 * 印給家長前的內容檢查（v2.1）：列印前（printview.js）與存檔時（editor.js）共用。
 *
 * 檢查要給家長看的文字：家訊文案；沒有家訊文案時改印的活動摘要；每張照片的圖說。找出：
 *   - [S?]、[S數字] 這類代號（AI 沒還原或老師沒填名字）
 *   - 【待老師補充…】
 *   - 隱私字眼（ai/prompt/banned.md 的 privacy 等級，由 build_prompt.py 產生 js/privacy-terms.js）
 * 回傳問題清單 [{ field:'家訊文案'|'活動摘要'|'第 N 張圖說', kind:'code'|'pending'|'privacy', text }]。
 * 只提醒、不擋：列印時紅框＋確認框列出；存檔時提示。
 */
WC.printcheck = (function () {
  // v2.2 L1：與 Deidentify.gs 的 DEID_TYPED_CODE_RE 同步：[]［］【】〔〕⟦⟧()（）、不完整的 [[S3]、沒有括號的 S3（前後不是英數字）
  const CODE_RE = /[\[［【〔⟦(（]{1,2}\s*[SＳｓs]\s*(?:[0-9０-９]+|[?？])\s*[\]］】〕⟧)）]{0,2}|(?<![A-Za-z0-9Ａ-Ｚａ-ｚ０-９])[SＳ][0-9０-９]+(?![A-Za-z0-9Ａ-Ｚａ-ｚ０-９])/g;
  const PENDING_RE = /【待老師補充[^】]*】/g;
  let compiled = null;

  function terms() {
    if (compiled) return compiled;
    compiled = (window.WC_PRIVACY_TERMS || []).filter(function (t) { return t.type !== 'except'; }).map(function (t) {
      return t.type === 'regex' ? { re: new RegExp(t.text, 'i'), label: t.note || t.text, soft: !!t.soft } : { text: t.text, label: t.text, soft: !!t.soft };
    });
    return compiled;
  }

  function scanText(field, s, out) {
    s = String(s || '');
    if (!s) return;
    const codes = s.match(CODE_RE);
    if (codes) out.push({ field: field, kind: 'code', text: '有代號 ' + uniq(codes).join('、') + '，請改成名字或刪掉' });
    const pend = s.match(PENDING_RE);
    if (pend) out.push({ field: field, kind: 'pending', text: '有「' + pend[0] + '」，請補上內容' });
    const masked = maskExceptions(s);   // v2.2 N3：例外詞（哭笑不得、搶答…）先遮掉
    const found = terms().filter(function (t) { return t.re ? t.re.test(masked) : masked.indexOf(t.text) >= 0; });
    const hit = found.filter(function (t) { return !t.soft; }).map(function (t) { return t.label; });
    const soft = found.filter(function (t) { return t.soft; }).map(function (t) { return t.label; });
    if (hit.length) out.push({ field: field, kind: 'privacy', text: '可能不宜給家長看的字眼：' + uniq(hit).join('、') });
    // v2.3：提醒等級（例如「尖叫」，「開心地尖叫」很常見）
    if (soft.length) out.push({ field: field, kind: 'privacysoft', text: '請確認語意：' + uniq(soft).join('、') });
  }

  function maskExceptions(s) {
    const exc = (window.WC_PRIVACY_EXCEPTIONS || []).slice().sort(function (a, b) { return b.length - a.length; });
    exc.forEach(function (e) { if (e) s = s.split(e).join(new Array(e.length + 1).join('〓')); });
    return s;
  }

  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

  /** rec：{ newsletter, summary, photos:[{caption}] }；photos 可傳實際會印出的那幾張 */
  function checkRecord(rec, photos) {
    const out = [];
    const nl = String(rec.newsletter || '').trim();
    if (nl) scanText('家訊文案', nl, out);
    else scanText('活動摘要（沒有家訊文案時會印摘要）', rec.summary, out);
    (photos || rec.photos || []).forEach(function (p, i) { scanText('第 ' + (i + 1) + ' 張圖說', p && p.caption, out); });
    return out;
  }

  function summary(list) {
    return list.map(function (x) { return x.field + '：' + x.text; }).join('；');
  }

  return { checkRecord: checkRecord, summary: summary };
})();
