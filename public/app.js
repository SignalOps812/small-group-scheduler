/* Small Group — client app (no build step, no dependencies) */
(() => {
  'use strict';

  // ---------- State ----------
  const S = {
    config: { appName: 'Small Group', requireCode: false },
    me: null, events: [], polls: [], members: [],
    view: 'calendar', month: null, selected: null,
    authMode: 'signin', resetToken: null,
    sheet: null, // { kind, id }
    loaded: false,
  };
  const $app = document.getElementById('app');
  const $sheetRoot = document.getElementById('sheet-root');
  const $toast = document.getElementById('toast');

  // ---------- Utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => ymd(new Date());
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmtLong = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtLongY = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fmtShort = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const monAbbr = (s) => parseYmd(s).toLocaleDateString(undefined, { month: 'short' });
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const fmtCost = (c) => (c === null || c === undefined ? '' : c === 0 ? 'Free' : `$${Number(c).toFixed(c % 1 ? 2 : 0)}`);
  const fmtStamp = (iso) => {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const relDay = (s) => {
    const diff = Math.round((parseYmd(s) - parseYmd(todayStr())) / 864e5);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : '';
  };
  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const PALETTE = ['blue', 'purple', 'orange', 'teal', 'pink', 'indigo', 'green', 'brown'];
  const colorFor = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `var(--${PALETTE[h % PALETTE.length]})`; };
  const avatar = (id, name, cls = '') => `<span class="avatar ${cls}" style="--c:${colorFor(id)}" title="${esc(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  const canModify = (ownerId) => S.me && (S.me.isAdmin || S.me.id === ownerId);

  const I = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    poll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 16v-4M12 16V8M16 16v-6"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M17 14.5c2.4 0 4 1.5 4.5 4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    q: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><circle cx="12" cy="18.5" r=".6" fill="currentColor"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" fill="var(--red)"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/login' && S.me) { S.me = null; closeSheet(true); render(); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- Data ----------
  async function loadAll() {
    const [e, p, m] = await Promise.all([api('GET', '/events'), api('GET', '/polls'), api('GET', '/members')]);
    S.events = e.events; S.polls = p.polls; S.members = m.members; S.loaded = true;
  }
  const eventsOn = (d) => S.events.filter((e) => e.date === d);
  const pendingPolls = () => S.polls.filter((p) => p.status === 'open' && !p.responders.some((r) => r.userId === S.me.id));

  // ---------- Routing ----------
  function readHash() {
    const [view, arg] = location.hash.replace(/^#\/?/, '').split('/');
    if (view === 'reset' && arg) { S.resetToken = arg; S.authMode = 'reset'; return; }
    if (['calendar', 'polls', 'members'].includes(view)) S.view = view;
    if (view === 'calendar' && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) { S.selected = arg; const d = parseYmd(arg); S.month = new Date(d.getFullYear(), d.getMonth(), 1); }
    if (view === 'polls' && arg) S.pendingPoll = arg;
  }
  function go(view) { S.view = view; history.replaceState(null, '', '#' + view); render(); window.scrollTo({ top: 0 }); }

  // ---------- Render: auth ----------
  function renderAuth() {
    const m = S.authMode;
    const name = esc(S.config.appName);
    const head = {
      signin: ['Welcome back', `Sign in to see what ${name} has planned.`],
      signup: [`Join ${name}`, 'Create an account to see the calendar and vote on dates.'],
      forgot: ['Reset password', 'Enter your email and we\u2019ll send you a link to choose a new password.'],
      reset: ['Choose a new password', 'Make it at least 8 characters.'],
    }[m];
    let fields = '';
    if (m === 'signup') fields += `<div class="row"><label for="f-name">Name</label><input id="f-name" name="name" autocomplete="name" placeholder="First and last name" required></div>`;
    if (m !== 'reset') fields += `<div class="row"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>`;
    if (m !== 'forgot') fields += `<div class="row"><label for="f-pw">Password</label><input id="f-pw" name="password" type="password" minlength="8" autocomplete="${m === 'signin' ? 'current-password' : 'new-password'}" placeholder="${m === 'signin' ? 'Required' : 'At least 8 characters'}" required></div>`;
    if (m === 'signup' && S.config.requireCode) fields += `<div class="row"><label for="f-code">Group code</label><input id="f-code" name="code" autocomplete="off" placeholder="From your group leader" required></div>`;
    const btn = { signin: 'Sign In', signup: 'Create Account', forgot: 'Send Reset Link', reset: 'Save Password' }[m];
    const seg = (m === 'signin' || m === 'signup') ? `
      <div class="segmented" role="tablist" data-seg>
        <span class="thumb" style="width:calc(50% - 2px);transform:translateX(${m === 'signup' ? '100%' : '0'})"></span>
        <button type="button" role="tab" aria-selected="${m === 'signin'}" data-action="auth-mode" data-mode="signin">Sign In</button>
        <button type="button" role="tab" aria-selected="${m === 'signup'}" data-action="auth-mode" data-mode="signup">Create Account</button>
      </div>` : '';
    const foot = m === 'signin' ? `<div class="auth-foot"><button type="button" class="link" data-action="auth-mode" data-mode="forgot">Forgot password?</button></div>`
      : (m === 'forgot' || m === 'reset') ? `<div class="auth-foot"><button type="button" class="link" data-action="auth-mode" data-mode="signin">Back to Sign In</button></div>` : '';
    $app.innerHTML = `
      <main class="auth-wrap">
        <div class="auth-card">
          <div class="app-icon"><img src="/icon.svg" alt=""></div>
          <h1>${head[0]}</h1>
          <p class="sub">${head[1]}</p>
          ${seg}
          <form id="auth-form" novalidate>
            <div class="group">${fields}</div>
            <div id="auth-msg"></div>
            <button class="btn block" type="submit">${btn}</button>
          </form>
          ${foot}
        </div>
      </main>`;
    const first = $app.querySelector('input');
    if (first && matchMedia('(min-width: 761px)').matches) first.focus();
    $app.querySelector('#auth-form').addEventListener('submit', onAuthSubmit);
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]'), msg = f.querySelector('#auth-msg');
    const v = Object.fromEntries(new FormData(f));
    msg.innerHTML = '';
    const err = (t) => { msg.innerHTML = `<div class="form-error">${esc(t)}</div>`; };
    if (S.authMode === 'signup' && !v.name?.trim()) return err('Please enter your name.');
    if (S.authMode !== 'reset' && !/^\S+@\S+\.\S+$/.test(v.email || '')) return err('Please enter a valid email address.');
    if (S.authMode !== 'forgot' && (v.password || '').length < (S.authMode === 'signin' ? 1 : 8)) return err(S.authMode === 'signin' ? 'Please enter your password.' : 'Password must be at least 8 characters.');
    btn.disabled = true;
    try {
      if (S.authMode === 'signin') await api('POST', '/login', { email: v.email, password: v.password });
      else if (S.authMode === 'signup') await api('POST', '/register', v);
      else if (S.authMode === 'forgot') {
        await api('POST', '/forgot', { email: v.email });
        msg.innerHTML = `<p class="form-note">If an account exists for that email, a reset link is on its way. Check your inbox.</p>`;
        btn.disabled = false; return;
      } else if (S.authMode === 'reset') {
        await api('POST', '/reset', { token: S.resetToken, password: v.password });
        S.resetToken = null; history.replaceState(null, '', '#calendar');
      }
      await boot();
      if (S.authMode === 'signup') toast(`Welcome to ${S.config.appName}!`);
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }

  // ---------- Render: shell ----------
  function render() {
    if (!S.me) { closeSheet(true); return renderAuth(); }
    const pend = pendingPolls().length;
    const tabs = [['calendar', 'Calendar', I.cal], ['polls', 'Polls', I.poll], ['members', 'Members', I.people]];
    const idx = tabs.findIndex((t) => t[0] === S.view);
    let body = '';
    if (!S.loaded) body = '<div class="spinner"></div>';
    else if (S.view === 'calendar') body = renderCalendar();
    else if (S.view === 'polls') body = renderPolls();
    else body = renderMembers();
    $app.innerHTML = `
      <header class="topbar">
        <div class="brand"><img src="/icon.svg" alt=""><span>${esc(S.config.appName)}</span></div>
        <div class="segmented" role="tablist" aria-label="Sections">
          <span class="thumb" style="width:calc(${100 / tabs.length}% - ${4 / tabs.length}px);transform:translateX(${idx * 100}%)"></span>
          ${tabs.map(([k, label]) => `<button role="tab" aria-selected="${S.view === k}" data-action="nav" data-view="${k}">${label}${k === 'polls' && pend ? `<span class="badge">${pend}</span>` : ''}</button>`).join('')}
        </div>
        <div class="right">
          <button class="avatar-btn" data-action="profile" aria-label="Your profile">${avatar(S.me.id, S.me.name, 'avatar')}</button>
        </div>
      </header>
      <main class="page fade-in">${body}</main>
      <nav class="tabbar" role="tablist" aria-label="Sections">
        ${tabs.map(([k, label, icon]) => `<button role="tab" aria-selected="${S.view === k}" data-action="nav" data-view="${k}">${icon}<span>${label}</span>${k === 'polls' && pend ? `<span class="badge">${pend}</span>` : ''}</button>`).join('')}
      </nav>`;
  }

  // ---------- Calendar ----------
  function renderCalendar() {
    const m = S.month, y = m.getFullYear(), mo = m.getMonth();
    const start = new Date(y, mo, 1 - new Date(y, mo, 1).getDay());
    const today = todayStr();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      if (i === 35 && d.getMonth() !== mo) break; // drop an all-next-month 6th row
      const ds = ymd(d), evs = eventsOn(ds);
      const cls = ['day', d.getMonth() !== mo && 'other', ds === today && 'today', ds === S.selected && 'selected', (d.getDay() % 6 === 0) && 'weekend'].filter(Boolean).join(' ');
      const label = `${fmtLong(ds)}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}`;
      cells += `<button class="${cls}" data-action="select-day" data-date="${ds}" aria-label="${esc(label)}" aria-pressed="${ds === S.selected}">
        <span class="num">${d.getDate()}</span>
        <span class="dots">${evs.slice(0, 3).map((e) => `<i style="--c:${colorFor(e.createdBy)}"></i>`).join('')}</span>
      </button>`;
    }
    const dayEvents = eventsOn(S.selected);
    const upcoming = S.events.filter((e) => e.date >= today).slice(0, 12);
    const groups = [];
    for (const e of upcoming) {
      const g = groups[groups.length - 1];
      if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] });
    }
    const rel = relDay(S.selected);
    return `
      <div class="title-row">
        <div><h1 class="large-title">Calendar</h1><div class="sub">${upcoming.length ? `${upcoming.length}${upcoming.length === 12 ? '+' : ''} upcoming event${upcoming.length > 1 ? 's' : ''}` : 'Nothing scheduled yet'}</div></div>
        <button class="btn sm" data-action="new-event">${I.plus.replace('<svg', '<svg width="16" height="16"')} Add Event</button>
      </div>
      <div class="cal-layout">
        <section class="card cal" aria-label="Month view">
          <div class="cal-head">
            <h2>${MONTHS[mo]} <span>${y}</span></h2>
            <div class="nav">
              <button class="today-btn" data-action="today">Today</button>
              <button class="icon-btn" data-action="month" data-dir="-1" aria-label="Previous month">${I.left}</button>
              <button class="icon-btn" data-action="month" data-dir="1" aria-label="Next month">${I.right}</button>
            </div>
          </div>
          <div class="weekdays">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('')}</div>
          <div class="days">${cells}</div>
        </section>
        <section class="agenda" aria-label="Selected day">
          <h3>${rel || parseYmd(S.selected).toLocaleDateString(undefined, { weekday: 'long' })}</h3>
          <div class="when-sub">${rel ? fmtLongY(S.selected) : parseYmd(S.selected).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</div>
          ${dayEvents.length ? `<div class="event-list">${dayEvents.map(eventRow).join('')}</div>` : `
            <div class="empty">${I.cal}<div>No events this day.</div>
              <button class="btn sm tinted" data-action="new-event" data-date="${S.selected}">${I.plus.replace('<svg', '<svg width="15" height="15"')} Add Event</button></div>`}
          <div class="section-title">Upcoming</div>
          ${groups.length ? groups.map((g) => `
            <div class="upcoming-group"><h4>${relDay(g.date) ? relDay(g.date) + ' · ' : ''}${fmtShort(g.date)}</h4>
              <div class="event-list">${g.items.map(eventRow).join('')}</div></div>`).join('')
            : `<div class="empty">Nothing coming up. Add an event or start a poll to find a date.</div>`}
        </section>
      </div>`;
  }
  function eventRow(e) {
    const meta = [e.location && `<span>${esc(e.location)}</span>`, `<span>by ${esc(e.createdByName)}</span>`].filter(Boolean).join('');
    const cost = fmtCost(e.cost);
    return `<button class="event" style="--c:${colorFor(e.createdBy)}" data-action="open-event" data-id="${esc(e.id)}">
      <span class="bar"></span>
      <span><span class="title">${esc(e.title)}</span><span class="meta">${meta}</span></span>
      <span class="side"><span class="time">${e.time ? fmtTime(e.time) : 'All day'}</span>${cost ? `<span class="pill ${e.cost === 0 ? 'green' : ''}">${esc(cost)}</span>` : ''}</span>
    </button>`;
  }

  // ---------- Polls ----------
  function renderPolls() {
    const open = S.polls.filter((p) => p.status === 'open'), done = S.polls.filter((p) => p.status !== 'open');
    const n = S.members.length;
    const card = (p) => {
      const responded = p.responders.some((r) => r.userId === S.me.id);
      const best = bestOption(p);
      const chosen = p.options.find((o) => o.id === p.scheduledOptionId);
      const tiles = (chosen ? [chosen] : p.options.slice(0, 5)).map((o) => `<div class="date-tile"><div class="m">${esc(monAbbr(o.date))}</div><div class="d">${parseYmd(o.date).getDate()}</div></div>`).join('');
      return `<button class="poll-card" data-action="open-poll" data-id="${esc(p.id)}">
        <div class="top">
          <div><h3>${esc(p.title)}</h3><div class="by">${esc(p.createdByName)} · ${p.options.length} option${p.options.length > 1 ? 's' : ''}</div></div>
          ${p.status === 'open' ? (responded ? '<span class="pill green">Voted</span>' : '<span class="pill orange">Vote</span>') : '<span class="pill blue">Scheduled</span>'}
        </div>
        <div class="mini-tiles">${tiles}${!chosen && p.options.length > 5 ? `<span class="more">+${p.options.length - 5}</span>` : ''}</div>
        <div>
          <div class="progress" aria-hidden="true"><i style="width:${n ? Math.round((p.responders.length / n) * 100) : 0}%"></i></div>
        </div>
        <div class="foot">
          <span>${p.responders.length} of ${n} responded</span>
          <span>${chosen ? `${esc(fmtShort(chosen.date))}${chosen.time ? ' · ' + fmtTime(chosen.time) : ''}` : best ? `Leading: ${esc(fmtShort(best.date))}` : ''}</span>
        </div>
      </button>`;
    };
    return `
      <div class="title-row">
        <div><h1 class="large-title">Polls</h1><div class="sub">Propose dates and let everyone vote.</div></div>
        <button class="btn sm" data-action="new-poll">${I.plus.replace('<svg', '<svg width="16" height="16"')} New Poll</button>
      </div>
      ${open.length ? `<div class="poll-grid">${open.map(card).join('')}</div>` : `
        <div class="empty">${I.poll}<div>No open polls.</div><div class="small" style="margin-top:4px">Trying to find a date? Start a poll and let everyone vote.</div>
          <button class="btn sm tinted" data-action="new-poll">${I.plus.replace('<svg', '<svg width="15" height="15"')} New Poll</button></div>`}
      ${done.length ? `<div class="section-title">Scheduled</div><div class="poll-grid">${done.map(card).join('')}</div>` : ''}`;
  }
  function score(o) { return o.votes.reduce((s, v) => s + (v.answer === 'yes' ? 2 : v.answer === 'maybe' ? 1 : 0), 0); }
  function bestOption(p) {
    let best = null, bs = 0;
    for (const o of p.options) { const s = score(o); if (s > bs) { bs = s; best = o; } }
    return best;
  }

  // ---------- Members ----------
  function renderMembers() {
    return `
      <div class="title-row"><div><h1 class="large-title">Members</h1><div class="sub">${S.members.length} ${S.members.length === 1 ? 'person' : 'people'} in ${esc(S.config.appName)}</div></div></div>
      <div class="group people" style="max-width:640px">
        ${S.members.map((m) => `<div class="person">${avatar(m.id, m.name)}<div class="nm">${esc(m.name)}${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}<small>Joined ${esc(new Date(m.joined.includes('T') ? m.joined : m.joined.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</small></div>${m.isAdmin ? '<span class="pill blue">Organizer</span>' : ''}</div>`).join('')}
      </div>
      <p class="group-foot" style="max-width:640px">Everyone here gets an email when a new event or poll is added, unless they turn it off in their profile.</p>`;
  }

  // ---------- Sheets ----------
  function openSheet(kind, opts = {}) {
    S.sheet = { kind, ...opts };
    const html = sheetHtml();
    $sheetRoot.innerHTML = `<div class="backdrop" data-action="backdrop"><div class="sheet ${kind === 'poll' ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.style.overflow = 'hidden';
    const first = $sheetRoot.querySelector('input:not([type=date]):not([type=time]):not([type=checkbox])');
    if (first && matchMedia('(min-width: 761px)').matches) setTimeout(() => first.focus(), 60);
    const form = $sheetRoot.querySelector('form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); onSheetSave(); });
  }
  function refreshSheet() {
    const sheet = $sheetRoot.querySelector('.sheet');
    if (!sheet || !S.sheet || S.sheet.kind === 'event-form' || S.sheet.kind === 'poll-form') return;
    const body = sheet.querySelector('.sheet-body'), top = body ? body.scrollTop : 0;
    const html = sheetHtml();
    if (!html) return closeSheet();
    sheet.innerHTML = html;
    const nb = sheet.querySelector('.sheet-body'); if (nb) nb.scrollTop = top;
  }
  function closeSheet(instant) {
    const bd = $sheetRoot.querySelector('.backdrop');
    S.sheet = null;
    document.body.style.overflow = '';
    if (S.view === 'polls' && /^#polls\/./.test(location.hash)) history.replaceState(null, '', '#polls');
    if (!bd) return;
    if (instant) { $sheetRoot.innerHTML = ''; return; }
    bd.classList.add('closing');
    setTimeout(() => { if (!S.sheet) $sheetRoot.innerHTML = ''; }, 190);
  }
  const head = (title, left, right, rightDisabled) => `<div class="sheet-head">
      <button class="l" type="button" data-action="close">${left}</button>
      <div class="t">${esc(title)}</div>
      ${right ? `<button class="r" type="submit" ${rightDisabled ? 'disabled' : ''}>${right}</button>` : '<span></span>'}
    </div>`;

  function sheetHtml() {
    const s = S.sheet;
    if (s.kind === 'event-form') {
      const e = s.id ? S.events.find((x) => x.id === s.id) : { title: '', description: '', date: s.date || S.selected, time: '', cost: null, location: '' };
      return `<form autocomplete="off">${head(s.id ? 'Edit Event' : 'New Event', 'Cancel', s.id ? 'Save' : 'Add')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="title" placeholder="Title" maxlength="120" value="${esc(e.title)}" aria-label="Title" required></div>
            <div class="row"><input name="location" placeholder="Location" maxlength="200" value="${esc(e.location)}" aria-label="Location"></div>
          </div>
          <div class="group">
            <div class="row"><label for="ev-date">Date</label><input id="ev-date" name="date" type="date" value="${esc(e.date)}" required></div>
            <div class="row"><label for="ev-time">Time</label><input id="ev-time" name="time" type="time" value="${esc(e.time)}"></div>
            <div class="row"><label for="ev-cost">Cost</label><span class="prefix">$</span><input id="ev-cost" name="cost" inputmode="decimal" placeholder="0.00 (leave blank if none)" value="${e.cost ?? ''}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description — what to bring, who's hosting, anything people should know" maxlength="4000" aria-label="Description">${esc(e.description)}</textarea></div>
          </div>
          <p class="group-foot">Leave the time blank for an all-day event. Enter 0 for a free event. ${s.id ? '' : 'Everyone in the group will get an email about it.'}</p>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'event') {
      const e = S.events.find((x) => x.id === s.id);
      if (!e) return '';
      const kv = [['Location', e.location], ['Cost', fmtCost(e.cost)], ['Added by', e.createdByName], ['From poll', e.pollId ? 'Yes — picked by vote' : '']].filter(([, v]) => v);
      return `${head('Event', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero">
            <div class="date-tile"><div class="m">${esc(monAbbr(e.date))}</div><div class="d">${parseYmd(e.date).getDate()}</div></div>
            <h2>${esc(e.title)}</h2>
            <div class="w">${esc(fmtLongY(e.date))}${e.time ? ' · ' + fmtTime(e.time) : ' · All day'}</div>
          </div>
          ${kv.length ? `<div class="group kv">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
          ${e.description ? `<div class="group-label" style="margin-top:22px">Details</div><div class="group"><div class="detail-desc">${esc(e.description)}</div></div>` : ''}
          <div class="actions">
            <button class="btn tinted block" data-action="ics" data-id="${esc(e.id)}">Add to My Calendar</button>
            ${canModify(e.createdBy) ? `<button class="btn tinted block" data-action="edit-event" data-id="${esc(e.id)}">Edit Event</button>
              <button class="btn danger block" data-action="delete-event" data-id="${esc(e.id)}">Delete Event</button>` : ''}
          </div>
        </div>`;
    }
    if (s.kind === 'poll-form') {
      const opts = s.options || (s.options = [{ date: '', time: '' }, { date: '', time: '' }]);
      return `<form autocomplete="off">${head('New Poll', 'Cancel', 'Create')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="title" placeholder="What are we planning?" maxlength="120" value="${esc(s.title || '')}" aria-label="Title" required></div>
            <div class="row"><input name="location" placeholder="Location" maxlength="200" value="${esc(s.location || '')}" aria-label="Location"></div>
            <div class="row"><label for="p-cost">Cost</label><span class="prefix">$</span><input id="p-cost" name="cost" inputmode="decimal" placeholder="0.00 (optional)" value="${esc(s.cost ?? '')}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description (optional)" maxlength="4000" aria-label="Description">${esc(s.description || '')}</textarea></div>
          </div>
          <div class="group-label" style="margin-top:22px">Date options</div>
          <div class="group" id="opt-list">
            ${opts.map((o, i) => `<div class="row" data-i="${i}">
              <button type="button" class="opt-remove" data-action="remove-opt" data-i="${i}" aria-label="Remove option ${i + 1}" ${opts.length <= 2 ? 'disabled style="opacity:.35"' : ''}>${I.minus.replace('<svg', '<svg width="22" height="22"')}</button>
              <input type="date" name="od${i}" value="${esc(o.date)}" aria-label="Option ${i + 1} date" style="text-align:left">
              <input type="time" name="ot${i}" value="${esc(o.time)}" aria-label="Option ${i + 1} time" style="flex:0 0 auto;width:auto">
            </div>`).join('')}
            <div class="row button-row" data-action="add-opt" role="button" tabindex="0">${I.plus.replace('<svg', '<svg width="18" height="18"')} Add another date</div>
          </div>
          <p class="group-foot">Add at least two dates. Members mark each one Yes, Maybe, or No, and you'll see who answered. When you pick the final date, it goes on the calendar and everyone gets an email.</p>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'poll') {
      const p = S.polls.find((x) => x.id === s.id);
      if (!p) return '';
      const open = p.status === 'open', owner = canModify(p.createdBy);
      const best = open ? bestOption(p) : null;
      const chosen = p.options.find((o) => o.id === p.scheduledOptionId);
      const respondedIds = new Set(p.responders.map((r) => r.userId));
      const waiting = S.members.filter((m) => !respondedIds.has(m.id));
      const kv = [['Location', p.location], ['Cost', fmtCost(p.cost)], ['Created', fmtStamp(p.createdAt)]].filter(([, v]) => v);
      const optHtml = p.options.map((o) => {
        const mine = o.votes.find((v) => v.userId === S.me.id)?.answer || null;
        const by = (a) => o.votes.filter((v) => v.answer === a);
        const yes = by('yes'), maybe = by('maybe'), no = by('no');
        const cls = ['option', best && best.id === o.id && 'best', chosen && chosen.id === o.id && 'chosen', chosen && chosen.id !== o.id && 'dim'].filter(Boolean).join(' ');
        const btn = (a, label, icon) => `<button class="${a}" aria-pressed="${mine === a}" data-action="vote" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}" data-ans="${a}" ${open ? '' : 'disabled'}>${icon}${label}</button>`;
        return `<div class="${cls}">
          <div class="head">
            <div class="date-tile"><div class="m">${esc(monAbbr(o.date))}</div><div class="d">${parseYmd(o.date).getDate()}</div></div>
            <div class="when"><b>${esc(parseYmd(o.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</b><span>${o.time ? fmtTime(o.time) : 'Time TBD'}</span></div>
            <div class="tally">
              ${chosen && chosen.id === o.id ? '<span class="pill blue">Scheduled</span>' : best && best.id === o.id ? '<span class="pill green">Most popular</span>' : ''}
              <span class="avatar-stack">${yes.slice(0, 4).map((v) => avatar(v.userId, v.name, 'xs')).join('')}</span>
            </div>
          </div>
          ${open ? `<div class="choice" role="group" aria-label="Your answer">${btn('yes', 'Yes', I.check)}${btn('maybe', 'Maybe', I.q)}${btn('no', 'No', I.x)}</div>` : ''}
          ${o.votes.length ? `<div class="who">
            ${yes.length ? `<div><span class="k yes">Yes ${yes.length}</span><span class="v">${yes.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
            ${maybe.length ? `<div><span class="k maybe">Maybe ${maybe.length}</span><span class="v">${maybe.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
            ${no.length ? `<div><span class="k no">No ${no.length}</span><span class="v">${no.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
          </div>` : '<div class="small muted">No responses yet.</div>'}
          ${open && owner ? `<button class="btn sm tinted" style="justify-self:start" data-action="schedule" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}">${I.cal.replace('<svg', '<svg width="16" height="16"')} Schedule this date</button>` : ''}
        </div>`;
      }).join('');
      return `${head('Poll', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero" style="padding-bottom:16px">
            <h2>${esc(p.title)}</h2>
            <div class="w">Started by ${esc(p.createdByName)}</div>
          </div>
          ${chosen ? `<div class="group" style="margin-bottom:22px"><div class="row button-row" data-action="goto-date" data-date="${chosen.date}">${I.check.replace('<svg', '<svg width="18" height="18"')} On the calendar · ${esc(fmtShort(chosen.date))}${chosen.time ? ' · ' + fmtTime(chosen.time) : ''}<span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div></div>` : ''}
          ${kv.length ? `<div class="group kv">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
          ${p.description ? `<div class="group" style="margin-top:22px"><div class="detail-desc">${esc(p.description)}</div></div>` : ''}
          <div class="group-label" style="margin-top:26px">${open ? 'Mark which dates work for you' : 'Results'}</div>
          <div class="options">${optHtml}</div>
          <div class="group-label" style="margin-top:26px">Responses · ${p.responders.length} of ${S.members.length}</div>
          <div class="group people">
            ${p.responders.length ? p.responders.map((r) => `<div class="person">${avatar(r.userId, r.name)}<div class="nm">${esc(r.name)}${r.userId === S.me.id ? ' <span class="muted">(you)</span>' : ''}<small>Responded ${esc(fmtStamp(r.at))}</small></div><span class="pill green">Replied</span></div>`).join('') : '<div class="person"><div class="nm muted">No one has replied yet.</div></div>'}
          </div>
          ${waiting.length ? `<div class="group-label" style="margin-top:22px">Waiting on · ${waiting.length}</div>
          <div class="group people">${waiting.map((m) => `<div class="person">${avatar(m.id, m.name)}<div class="nm">${esc(m.name)}${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</div><span class="pill">No reply</span></div>`).join('')}</div>` : ''}
          ${owner ? `<div class="actions"><button class="btn danger block" data-action="delete-poll" data-id="${esc(p.id)}">Delete Poll</button></div>` : ''}
        </div>`;
    }
    if (s.kind === 'profile') {
      const m = S.me;
      return `<form autocomplete="off">${head('Profile', 'Done', 'Save')}
        <div class="sheet-body">
          <div class="detail-hero">${avatar(m.id, m.name, 'lg')}<h2 style="margin-top:12px">${esc(m.name)}</h2><div class="w">${esc(m.email)}</div></div>
          <div class="group">
            <div class="row"><label for="pr-name">Name</label><input id="pr-name" name="name" maxlength="80" value="${esc(m.name)}"></div>
          </div>
          <div class="group-label" style="margin-top:22px">Notifications</div>
          <div class="group">
            <div class="row"><span>Email me about new events and polls</span><label class="switch"><input type="checkbox" name="notify" data-action="toggle-notify" ${m.notify ? 'checked' : ''}><span></span></label></div>
          </div>
          ${m.isAdmin ? `<div class="group-label" style="margin-top:22px">Organizer</div><div class="group kv"><div class="row"><span>Email delivery</span><span class="v" id="email-status">Checking…</span></div></div>
            <p class="group-foot">You're the organizer because you created the first account. You can edit or delete any event or poll.</p>` : ''}
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="logout" role="button" tabindex="0">Sign Out</div></div>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    return '';
  }

  async function onSheetSave() {
    const s = S.sheet, form = $sheetRoot.querySelector('form');
    if (!form) return;
    const btn = form.querySelector('button[type=submit]'), msg = form.querySelector('#sheet-msg');
    const v = Object.fromEntries(new FormData(form));
    const err = (t) => { msg.innerHTML = `<div class="form-error">${esc(t)}</div>`; msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    msg.innerHTML = '';
    try {
      btn.disabled = true;
      if (s.kind === 'event-form') {
        if (!v.title.trim()) { btn.disabled = false; return err('Please add a title.'); }
        if (!v.date) { btn.disabled = false; return err('Please choose a date.'); }
        const body = { title: v.title, location: v.location, date: v.date, time: v.time, cost: v.cost, description: v.description };
        const r = s.id ? await api('PUT', `/events/${s.id}`, body) : await api('POST', '/events', body);
        await loadAll();
        S.selected = r.event.date; const d = parseYmd(r.event.date); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
        S.view = 'calendar'; history.replaceState(null, '', '#calendar');
        closeSheet(); render();
        toast(s.id ? 'Event updated' : 'Event added · Group notified');
      } else if (s.kind === 'poll-form') {
        syncPollForm();
        if (!v.title.trim()) { btn.disabled = false; return err('Please add a title.'); }
        const options = s.options.filter((o) => o.date);
        if (options.length < 2) { btn.disabled = false; return err('Add at least two dates for people to vote on.'); }
        const r = await api('POST', '/polls', { title: v.title, location: v.location, cost: v.cost, description: v.description, options });
        await loadAll();
        S.view = 'polls'; render();
        openSheet('poll', { id: r.poll.id }); history.replaceState(null, '', '#polls/' + r.poll.id);
        toast('Poll created · Group notified');
      } else if (s.kind === 'profile') {
        const r = await api('PATCH', '/me', { name: v.name });
        S.me = r.user; await loadAll(); closeSheet(); render(); toast('Profile saved');
      }
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }

  function syncPollForm() {
    const s = S.sheet, form = $sheetRoot.querySelector('form');
    if (!s || s.kind !== 'poll-form' || !form) return;
    const fd = new FormData(form);
    s.title = fd.get('title'); s.location = fd.get('location'); s.cost = fd.get('cost'); s.description = fd.get('description');
    s.options = s.options.map((_, i) => ({ date: fd.get('od' + i) || '', time: fd.get('ot' + i) || '' }));
  }
  function rerenderForm() {
    const sheet = $sheetRoot.querySelector('.sheet');
    const top = sheet.querySelector('.sheet-body').scrollTop;
    sheet.innerHTML = sheetHtml();
    sheet.querySelector('.sheet-body').scrollTop = top;
    sheet.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); onSheetSave(); });
  }

  function downloadIcs(e) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
    const d = e.date.replace(/-/g, '');
    let when;
    if (e.time) {
      const [h, m] = e.time.split(':').map(Number);
      const end = new Date(2000, 0, 1, h + 2, m);
      const endDay = end.getDate() > 1 ? ymd(new Date(parseYmd(e.date).getTime() + 864e5)).replace(/-/g, '') : d;
      when = `DTSTART:${d}T${pad(h)}${pad(m)}00\r\nDTEND:${endDay}T${pad(end.getHours())}${pad(end.getMinutes())}00`;
    } else {
      when = `DTSTART;VALUE=DATE:${d}\r\nDTEND;VALUE=DATE:${ymd(new Date(parseYmd(e.date).getTime() + 864e5 + 3600e3)).replace(/-/g, '')}`;
    }
    const desc = [e.description, fmtCost(e.cost) && 'Cost: ' + fmtCost(e.cost)].filter(Boolean).join('\n\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Small Group//EN', 'BEGIN:VEVENT', `UID:${e.id}@smallgroup`, `DTSTAMP:${stamp}`, when,
      `SUMMARY:${icsEsc(e.title)}`, e.location ? `LOCATION:${icsEsc(e.location)}` : '', desc ? `DESCRIPTION:${icsEsc(desc)}` : '', 'END:VEVENT', 'END:VCALENDAR']
      .filter(Boolean).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = (e.title.replace(/[^\w\s-]/g, '').trim() || 'event') + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- Actions ----------
  const actions = {
    'auth-mode': (el) => { S.authMode = el.dataset.mode; renderAuth(); },
    nav: (el) => go(el.dataset.view),
    month: (el) => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + Number(el.dataset.dir), 1); render(); },
    today: () => { const t = new Date(); S.month = new Date(t.getFullYear(), t.getMonth(), 1); S.selected = todayStr(); render(); },
    'select-day': (el) => {
      S.selected = el.dataset.date;
      const d = parseYmd(S.selected);
      if (d.getMonth() !== S.month.getMonth()) S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      render();
      if (matchMedia('(max-width: 900px)').matches) document.querySelector('.agenda')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    'new-event': (el) => openSheet('event-form', { date: el.dataset.date }),
    'open-event': (el) => openSheet('event', { id: el.dataset.id }),
    'edit-event': (el) => openSheet('event-form', { id: el.dataset.id }),
    'delete-event': async (el) => {
      const e = S.events.find((x) => x.id === el.dataset.id);
      if (!confirm(`Delete "${e.title}"?${e.pollId ? ' Its poll will reopen for voting.' : ''}`)) return;
      try { await api('DELETE', `/events/${e.id}`); await loadAll(); closeSheet(); render(); toast('Event deleted'); } catch (ex) { toast(ex.message); }
    },
    ics: (el) => downloadIcs(S.events.find((x) => x.id === el.dataset.id)),
    'new-poll': () => openSheet('poll-form'),
    'open-poll': (el) => { openSheet('poll', { id: el.dataset.id }); history.replaceState(null, '', '#polls/' + el.dataset.id); },
    'add-opt': () => {
      syncPollForm();
      const last = S.sheet.options[S.sheet.options.length - 1];
      let date = '';
      if (last?.date) date = ymd(new Date(parseYmd(last.date).getTime() + 7 * 864e5 + 3600e3)); // suggest same day next week
      S.sheet.options.push({ date, time: last?.time || '' });
      rerenderForm();
      const rows = $sheetRoot.querySelectorAll('#opt-list input[type=date]');
      rows[rows.length - 1]?.focus();
    },
    'remove-opt': (el) => { syncPollForm(); if (S.sheet.options.length > 2) { S.sheet.options.splice(Number(el.dataset.i), 1); rerenderForm(); } },
    vote: async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.poll);
      const o = p.options.find((x) => x.id === el.dataset.opt);
      const cur = o.votes.find((v) => v.userId === S.me.id)?.answer || null;
      const next = cur === el.dataset.ans ? null : el.dataset.ans;
      // optimistic update
      o.votes = o.votes.filter((v) => v.userId !== S.me.id);
      if (next) o.votes.push({ userId: S.me.id, name: S.me.name, answer: next, at: new Date().toISOString() });
      if (!p.responders.some((r) => r.userId === S.me.id) && next) p.responders.push({ userId: S.me.id, name: S.me.name, at: new Date().toISOString() });
      refreshSheet();
      try {
        const r = await api('POST', `/polls/${p.id}/vote`, { votes: { [o.id]: next } });
        Object.assign(p, r.poll); refreshSheet();
        const had = document.querySelector('.badge'); render(); if (had && !pendingPolls().length) toast('Thanks — your response is saved');
      } catch (ex) { toast(ex.message); await loadAll(); refreshSheet(); render(); }
    },
    schedule: async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.poll);
      const o = p.options.find((x) => x.id === el.dataset.opt);
      if (!confirm(`Schedule "${p.title}" for ${fmtLong(o.date)}${o.time ? ' at ' + fmtTime(o.time) : ''}?\n\nIt will go on the calendar, voting will close, and everyone will get an email.`)) return;
      try {
        await api('POST', `/polls/${p.id}/schedule`, { optionId: o.id });
        await loadAll(); refreshSheet(); render(); toast('Scheduled · Added to the calendar');
      } catch (ex) { toast(ex.message); }
    },
    'delete-poll': async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.id);
      if (!confirm(`Delete the poll "${p.title}" and all its responses?${p.eventId ? ' The calendar event will stay.' : ''}`)) return;
      try { await api('DELETE', `/polls/${p.id}`); await loadAll(); closeSheet(); render(); toast('Poll deleted'); } catch (ex) { toast(ex.message); }
    },
    'goto-date': (el) => {
      S.selected = el.dataset.date; const d = parseYmd(S.selected); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      closeSheet(); go('calendar');
    },
    profile: async () => {
      openSheet('profile');
      if (S.me.isAdmin) {
        try {
          const r = await api('GET', '/email-log');
          const last = r.log[0];
          const el = document.getElementById('email-status');
          if (el) el.textContent = !r.configured ? 'Not set up' : last && last.status === 'failed' ? 'Last send failed' : 'Connected';
        } catch {}
      }
    },
    'toggle-notify': async (el) => {
      try { const r = await api('PATCH', '/me', { notify: el.checked }); S.me = r.user; toast(el.checked ? 'Email notifications on' : 'Email notifications off'); }
      catch (ex) { el.checked = !el.checked; toast(ex.message); }
    },
    logout: async () => {
      try { await api('POST', '/logout', {}); } catch {}
      S.me = null; S.loaded = false; S.authMode = 'signin'; closeSheet(true); history.replaceState(null, '', '#'); render();
    },
    close: () => closeSheet(),
    backdrop: (el, ev) => { if (ev.target === el) closeSheet(); },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || (el.tagName === 'INPUT' && el.type === 'checkbox' && ev.type === 'click' && el.dataset.action === 'toggle-notify')) return;
    const fn = actions[el.dataset.action];
    if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') ev.preventDefault(); fn(el, ev); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset?.action === 'toggle-notify') actions['toggle-notify'](el);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.sheet) closeSheet();
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role=button][data-action]')) { ev.preventDefault(); ev.target.click(); }
  });
  window.addEventListener('hashchange', () => {
    if (!S.me) { readHash(); return render(); }
    const before = S.view; readHash();
    if (S.pendingPoll) { const id = S.pendingPoll; S.pendingPoll = null; if (S.view !== before) render(); if (S.polls.some((p) => p.id === id)) openSheet('poll', { id }); }
    else render();
  });

  // Keep things fresh while the tab is open
  async function refresh() {
    if (!S.me || document.hidden) return;
    if (S.sheet && ['event-form', 'poll-form', 'profile'].includes(S.sheet.kind)) return;
    try { await loadAll(); render(); if (S.sheet) refreshSheet(); } catch {}
  }
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- Boot ----------
  async function boot() {
    const t = new Date();
    S.month = S.month || new Date(t.getFullYear(), t.getMonth(), 1);
    S.selected = S.selected || todayStr();
    const me = await api('GET', '/me');
    S.me = me.user;
    if (!S.me) return render();
    if (S.authMode === 'reset') { S.authMode = 'signin'; history.replaceState(null, '', '#calendar'); }
    render(); // shell with spinner
    await loadAll();
    render();
    if (S.pendingPoll) { const id = S.pendingPoll; S.pendingPoll = null; if (S.polls.some((p) => p.id === id)) openSheet('poll', { id }); }
  }
  (async () => {
    readHash();
    try { S.config = await api('GET', '/config'); document.title = S.config.appName; } catch {}
    if (S.authMode === 'reset') { S.me = null; return renderAuth(); }
    try { await boot(); } catch (ex) { $app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Can't connect</h1><p class="sub">${esc(ex.message)}</p><button class="btn" onclick="location.reload()">Try Again</button></div></div>`; }
  })();
})();
