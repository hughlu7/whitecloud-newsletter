/**
 * v2.6「⚙ 設定 → 成員」區塊（只有主編看得到；後端 listMembers／saveMember 也只限主編，每個請求都重讀成員表判斷角色）。
 *
 * 和上面的單元設定不同：成員的每個操作按下就**立即儲存**（逐筆送 saveMember），不放進「儲存設定」的草稿。
 *   理由：成員異動是一筆一筆、彼此獨立的決定（加一位老師、停用一位），不像單元改名要和紀錄搬移一起完成；
 *   混在一次大儲存裡，萬一其中一項被擋（例如最後一位主編），整批都要重來，也不容易看出是哪一項。
 * - 樂觀鎖：每次送出都帶 membersVersion；別的主編（或有人手改成員表）先改了 → CONFLICT，自動重新載入清單，請使用者再操作一次。
 * - 不提供刪除（只能停用）、Email 建立後不能改：紀錄的投稿者以 Email 對應。
 * - 防呆（後端一定會擋，前端先把按鈕停用並說明）：不能停用自己或把自己改成老師；系統至少要有一位啟用中的主編。
 * 確認視窗沿用 settings.js 的頁內對話框（WC.settings.confirm）。
 */
WC.members = (function () {
  const U = WC.util;
  const DEFAULT_LIMITS = { name: 20, email: 254 };
  const CTRL_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
  const EMAIL_RE = /^[A-Za-z0-9._%+'\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
  let data = null;        // 最後一次 listMembers／saveMember 的結果
  let loading = false, busy = false;
  let editingEmail = '';
  let focusAfter = null;  // { email, act } 或 { sel }

  function isEditor() { return WC.state.me && WC.state.me.role === '主編'; }
  function lim() { return Object.assign({}, DEFAULT_LIMITS, data && data.limits); }
  function $m(sel) { return U.$('#set-members ' + sel); }
  function byEmail(email) { return data ? data.members.find(function (m) { return !m.dup && m.email === email; }) : null; }
  function activeEditors() { return data ? data.members.filter(function (m) { return !m.dup && m.active && m.role === '主編'; }).length : 0; }

  // ---------- 檢查（與後端 cleanMemberEmail_、cleanMemberName_ 相同；後端一定再驗一次） ----------
  function cleanEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function emailError(s) {
    if (!s) return '請填寫 Email（對方登入用的 Google 帳號）';
    if (s.length > lim().email || !EMAIL_RE.test(s) || /\.\./.test(s)) return 'Email 格式不正確，例如 teacher@gmail.com';
    return '';
  }
  function cleanName(v) { return String(v == null ? '' : v).replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim(); }
  function nameError(s) {
    if (CTRL_BIDI_RE.test(s)) return '姓名不可含控制字元或文字方向控制字元';
    if (!s) return '請填寫姓名';
    if (U.charLen(s) > lim().name) return '姓名最多 ' + lim().name + ' 字（目前 ' + U.charLen(s) + ' 字），請刪減';
    return '';
  }

  /** 這位成員的「停用」「改成老師」能不能按；不能按時回傳原因（顯示在列下方） */
  function guard(m) {
    if (m.isMe) return '這是您自己：不能停用自己或改成老師（以免把自己鎖在外面）；需要的話，請另一位主編操作。';
    if (m.active && m.role === '主編' && activeEditors() <= 1) return '這是唯一啟用中的主編，不能停用或改成老師；請先把另一位成員改成主編。';
    return '';
  }

  // ---------- 畫面 ----------
  function showMsg(html, type) {
    const box = $m('#mem-msg');
    if (!box) return;
    if (!html) { box.hidden = true; box.innerHTML = ''; return; }
    box.className = 'settings-msg ' + (type || 'info');
    box.innerHTML = html;
    box.hidden = false;
  }
  function addErr(msg) { const p = $m('#mem-add-err'); p.textContent = msg || ''; p.hidden = !msg; }

  function rowHtml(m, i) {
    const name = U.esc(m.name || m.email);
    const email = U.esc(m.email);
    const badges = [];
    if (m.isMe) badges.push('<span class="set-badge me">我</span>');
    badges.push('<span class="set-badge ' + (m.role === '主編' ? 'role-ed' : 'role-t') + '">' + U.esc(m.role) + '</span>');
    if (!m.active) badges.push('<span class="set-badge off">已停用</span>');
    if (m.dup) {
      return '<li class="mem-row dup" data-idx="' + i + '"><div class="mem-info"><b>' + name + '</b> ' + badges.join(' ') +
        '<small class="mem-email">' + email + '</small></div>' +
        '<p class="mem-note">試算表裡這個帳號出現兩次，只有第一筆有效，請聯絡管理者整理。</p></li>';
    }
    const g = guard(m);
    const dis = busy ? ' disabled' : '';
    if (editingEmail === m.email) {
      return '<li class="mem-row editing" data-email="' + email + '">' +
        '<div class="mem-info"><small class="mem-email">' + email + '</small></div>' +
        '<div class="set-rename"><label class="visually-hidden" for="mem-rename-input">「' + name + '」的新姓名</label>' +
        '<input id="mem-rename-input" type="text" value="' + U.esc(m.name) + '" autocomplete="off" aria-describedby="mem-rename-count">' +
        '<small id="mem-rename-count" class="counter set-name-count">' + U.charLen(m.name) + '／' + lim().name + '</small>' +
        '<button type="button" class="btn btn-primary" data-act="rename-ok"' + dis + '>儲存姓名</button>' +
        '<button type="button" class="btn" data-act="rename-cancel"' + dis + '>取消</button></div></li>';
    }
    return '<li class="mem-row' + (m.active ? '' : ' off') + '" data-email="' + email + '">' +
      '<div class="mem-info"><div class="mem-line"><b>' + name + '</b> ' + badges.join(' ') + '</div><small class="mem-email">' + email + '</small></div>' +
      '<div class="set-tools mem-tools">' +
      '<button type="button" class="btn-sm" data-act="rename" aria-label="修改「' + name + '」的姓名"' + dis + '>改姓名</button>' +
      '<button type="button" class="btn-sm" data-act="toggle-role" aria-label="把「' + name + '」改成' + (m.role === '主編' ? '老師' : '主編') + '"' +
        (busy || (g && m.role === '主編') ? ' disabled' : '') + '>改成' + (m.role === '主編' ? '老師' : '主編') + '</button>' +
      '<button type="button" class="btn-sm' + (m.active ? ' btn-out' : '') + '" data-act="toggle-active" aria-label="' + (m.active ? '停用' : '啟用') + '「' + name + '」"' +
        (busy || (g && m.active) ? ' disabled' : '') + '>' + (m.active ? '停用' : '啟用') + '</button>' +
      '</div>' + (g ? '<p class="mem-note">' + U.esc(g) + '</p>' : '') + '</li>';
  }

  function render() {
    const box = U.$('#set-members');
    if (!box) return;
    if (!data) {
      $m('#mem-list').innerHTML = '<li class="set-loading">' + (loading ? '載入成員中…' : '尚未載入') + '</li>';
      $m('#mem-count').textContent = '';
      $m('#mem-add').disabled = true;
      return;
    }
    const act = data.members.filter(function (m) { return !m.dup && m.active; }).length;
    const all = data.members.filter(function (m) { return !m.dup; }).length;
    $m('#mem-count').textContent = '啟用 ' + act + ' 位' + (all > act ? '／停用 ' + (all - act) + ' 位' : '');
    $m('#mem-list').innerHTML = data.members.map(rowHtml).join('');
    $m('#mem-add').disabled = busy;
    $m('#mem-add').textContent = busy ? '處理中…' : '＋ 新增成員';
    updateNameCount($m('#mem-name'), $m('#mem-name-count'));
    if (focusAfter) {
      const f = focusAfter; focusAfter = null;
      let el = null;
      if (f.sel) el = $m(f.sel);
      else {
        const row = U.$all('#set-members [data-email]').find(function (x) { return x.getAttribute('data-email') === f.email; });
        el = row ? row.querySelector('[data-act="' + f.act + '"]') : null;
        if (el && el.disabled) el = row.querySelector('[data-act="rename"]');
      }
      if (el) el.focus();
    }
  }

  function updateNameCount(input, out) {
    if (!input || !out) return false;
    const len = U.charLen(cleanName(input.value));
    out.textContent = len + '／' + lim().name;
    out.classList.toggle('near', len > lim().name);
    return len > lim().name;
  }

  // ---------- 載入 ----------
  async function load(keepMsg) {
    if (!isEditor()) return;
    loading = true;
    if (!keepMsg) showMsg('');
    render();
    try {
      data = await WC.api.listMembers();
    } catch (e) {
      data = null;
      if (e.code !== 'NOT_MEMBER') showMsg('讀取成員名單失敗：' + U.esc(U.errMsg(e)) + ' <button type="button" class="btn-sm" data-act="reload-members">再試一次</button>', 'error');
    } finally {
      loading = false;
      render();
    }
  }
  function onShow() { if (isEditor() && !loading && !busy) load(); else render(); }
  /** 新增表單清空、角色回到「老師」（回測 Q5） */
  function resetAddForm() {
    const em = $m('#mem-email'), nm = $m('#mem-name');
    if (!em) return;
    em.value = ''; nm.value = '';
    const t = U.$('#set-members input[name="mem-role"][value="老師"]');
    if (t) t.checked = true;
    addErr('');
    updateNameCount(nm, $m('#mem-name-count'));
  }
  function clear() { data = null; editingEmail = ''; busy = false; showMsg(''); resetAddForm(); }

  // ---------- 送出 ----------
  /** 送一筆修改；成功回 true。focus＝完成後要聚焦的按鈕 */
  async function submit(op, member, okText, focus) {
    if (busy || !data) return false;
    busy = true;
    showMsg('');
    render();
    try {
      data = await WC.api.saveMember({ expectedVersion: data.membersVersion, op: op, member: member });
      busy = false;
      focusAfter = focus || null;
      if (WC.api.isDemo) WC.app.renderDemoIdentities();   // 示範身分選單跟著成員名單更新
      render();
      showMsg(okText, 'ok');
      if (!focus) $m('#mem-msg').focus();
      // 自己改了自己的姓名：頁首跟著更新（角色不會變，後端擋）
      const me = byEmail(WC.state.me.email);
      if (me && me.name !== WC.state.me.name) { WC.state.me.name = me.name; U.$('#who').textContent = me.name + '（' + WC.state.me.role + '）'; }
      return true;
    } catch (e) {
      busy = false;
      if (e.code === 'CONFLICT') {
        await load(true);
        showMsg('<b>成員名單剛被其他主編（或有人在試算表）改過，已重新載入最新名單。</b>您剛才的修改還沒存，請確認後再操作一次。', 'error');
      } else if (e.code === 'DUPLICATE_MEMBER' && e.inactive) {
        showMsg(U.esc(e.message) + ' <button type="button" class="btn-sm" data-act="activate-dup" data-email-dup="' + U.esc(e.email || '') + '">現在啟用這位</button>', 'error');
      } else if (e.code === 'FORBIDDEN') {
        showMsg('您已不是主編，不能管理成員。', 'error');   // api.js 會重新讀身分，設定分頁隨之關閉
      } else if (e.code === 'NOT_MEMBER') {
        return false;
      } else {
        showMsg((e.code === 'SELF_LOCKOUT' || e.code === 'LAST_EDITOR' || e.code === 'DUPLICATE_MEMBER' || e.code === 'BAD_REQUEST' ? '' : '儲存失敗：') + U.esc(U.errMsg(e)), 'error');
      }
      render();
      if (!$m('#mem-msg').hidden) $m('#mem-msg').focus();
      return false;
    }
  }

  async function addMember() {
    const email = cleanEmail($m('#mem-email').value);
    const name = cleanName($m('#mem-name').value);
    const roleEl = U.$('#set-members input[name="mem-role"]:checked');
    const role = roleEl ? roleEl.value : '老師';
    let err = emailError(email);
    if (err) { addErr(err); $m('#mem-email').focus(); return; }
    const dup = data.members.find(function (m) { return m.email === email; });
    if (dup) {
      addErr(dup.active ? '「' + email + '」已經是成員（' + (dup.name || email) + '），不必再新增。'
        : '「' + email + '」已在名單內但目前停用：請在上面的清單按這位的「啟用」，不必再新增。');
      $m('#mem-email').focus();
      return;
    }
    err = nameError(name);
    if (err) { addErr(err); $m('#mem-name').focus(); return; }
    if (role === '主編') {
      const ok = await WC.settings.confirm({
        title: '新增主編',
        html: '<p>「<b>' + U.esc(name) + '</b>」（' + U.esc(email) + '）會成為<b>主編</b>：可以決定採用、編排家訊，也能修改設定與成員。確定嗎？</p>',
        okText: '新增為主編', opener: $m('#mem-add')
      });
      if (!ok) { resetAddForm(); showMsg('已取消新增。', 'info'); $m('#mem-email').focus(); return; }   // 回測 Q5
    }
    addErr('');
    const done = await submit('add', { email: email, name: name, role: role },
      '已新增「' + U.esc(name) + '」（' + U.esc(role) + '）。<b>對方用 ' + U.esc(email) + ' 這個 Google 帳號登入即可使用。</b>' +
      '<br><small>如果對方登入時被 Google 擋下，請聯絡幫忙架設系統的人，把這個 Email 加進允許名單。</small>',
      { sel: '#mem-email' });
    if (done) {
      $m('#mem-email').value = '';
      $m('#mem-name').value = '';
      resetAddForm();
    }
  }

  function startRename(email) { editingEmail = email; render(); const el = $m('#mem-rename-input'); if (el) { el.focus(); el.select(); } }
  function cancelRename() { const e = editingEmail; editingEmail = ''; showMsg(''); focusAfter = { email: e, act: 'rename' }; render(); }
  async function commitRename() {
    const m = byEmail(editingEmail);
    if (!m) { editingEmail = ''; render(); return; }
    const name = cleanName($m('#mem-rename-input').value);
    const err = nameError(name);
    if (err) { showMsg(U.esc(err), 'error'); $m('#mem-rename-input').focus(); return; }
    if (name === m.name) { cancelRename(); return; }
    const email = m.email;
    editingEmail = '';
    const ok = await submit('update', { email: email, name: name },
      '已把「' + U.esc(m.name) + '」改名為「' + U.esc(name) + '」。之後的新紀錄會用新姓名；已經存的紀錄仍顯示當時的姓名。', { email: email, act: 'rename' });
    if (!ok && byEmail(email)) { editingEmail = email; render(); const el = $m('#mem-rename-input'); if (el) { el.value = name; el.focus(); } }
  }

  async function toggleRole(email, opener) {
    const m = byEmail(email);
    if (!m) return;
    const to = m.role === '主編' ? '老師' : '主編';
    const g = guard(m);
    if (g && to === '老師') { showMsg(U.esc(g), 'error'); return; }
    const ok = await WC.settings.confirm({
      title: to === '主編' ? '改成主編' : '改成老師',
      html: to === '主編'
        ? '<p>把「<b>' + U.esc(m.name) + '</b>」改成<b>主編</b>？主編可以決定採用、編排家訊，也能修改設定與成員。</p>'
        : '<p>把「<b>' + U.esc(m.name) + '</b>」從主編改成<b>老師</b>？</p><p>對方下一次按任何按鈕或重新整理後就看不到「⚙ 設定」，也不能再採用或編排家訊；他寫過的紀錄不受影響。</p>',
      okText: '改成' + to, danger: to === '老師', opener: opener
    });
    if (!ok) return;
    await submit('update', { email: email, role: to }, '已把「' + U.esc(m.name) + '」改成' + to + '。', { email: email, act: 'toggle-role' });
  }

  async function toggleActive(email, opener) {
    const m = byEmail(email);
    if (!m) return;
    if (m.active) {
      const g = guard(m);
      if (g) { showMsg(U.esc(g), 'error'); return; }
      const ok = await WC.settings.confirm({
        title: '停用成員',
        html: '<p>停用「<b>' + U.esc(m.name) + '</b>」（' + U.esc(m.email) + '）？</p>' +
          '<p>對方下一次按任何按鈕或重新整理後就不能再使用白雲家訊。他寫過的紀錄<b>會保留</b>，之後隨時可以再按「啟用」恢復。</p>',
        okText: '停用', danger: true, opener: opener
      });
      if (!ok) return;
      await submit('update', { email: email, active: false }, '已停用「' + U.esc(m.name) + '」。紀錄都保留，要恢復時按「啟用」。', { email: email, act: 'toggle-active' });
    } else {
      await submit('update', { email: email, active: true }, '已啟用「' + U.esc(m.name) + '」，對方用 ' + U.esc(m.email) + ' 登入即可使用。', { email: email, act: 'toggle-active' });
    }
  }

  function bind() {
    const box = U.$('#set-members');
    if (!box) return;
    box.addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.getAttribute('data-act');
      if (act === 'reload-members') { load(); return; }
      if (!data || busy) return;
      const li = b.closest('[data-email]');
      const email = li ? li.getAttribute('data-email') : '';
      if (act === 'rename') startRename(email);
      if (act === 'rename-ok') commitRename();
      if (act === 'rename-cancel') cancelRename();
      if (act === 'toggle-role') toggleRole(email, b);
      if (act === 'toggle-active') toggleActive(email, b);
      if (act === 'activate-dup') { const em = b.getAttribute('data-email-dup'); if (byEmail(em)) toggleActive(em, b); }
    });
    box.addEventListener('keydown', function (e) {
      if (e.target.id === 'mem-rename-input') {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
      }
      if ((e.target.id === 'mem-email' || e.target.id === 'mem-name') && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (!busy && data) addMember(); }
    });
    box.addEventListener('input', function (e) {
      if (e.target.id === 'mem-name') { const over = updateNameCount(e.target, $m('#mem-name-count')); addErr(over ? '姓名最多 ' + lim().name + ' 字，請刪減' : ''); }
      if (e.target.id === 'mem-email') addErr('');
      if (e.target.id === 'mem-rename-input') updateNameCount(e.target, $m('#mem-rename-count'));
    });
    $m('#mem-add').addEventListener('click', function () { if (!busy && data) addMember(); });
    const jump = U.$('#set-goto-members');
    if (jump) jump.addEventListener('click', function () { const h = U.$('#set-members-h'); h.scrollIntoView({ block: 'start' }); h.focus({ preventScroll: true }); });
  }

  return { bind: bind, onShow: onShow, render: render, clear: clear, _data: function () { return data ? JSON.parse(JSON.stringify(data)) : null; } };
})();
