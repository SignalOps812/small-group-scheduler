/* Small Group — client app (no build step, no dependencies) */
(() => {
  'use strict';

  // ---------- State ----------
  const S = {
    config: { appName: 'Small Group' },
    me: null, groups: [], gid: null, events: [], polls: [], members: [],
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
  const validPhone = (p) => { const d = String(p).replace(/\D/g, ''); return String(p).trim().startsWith('+') ? d.length >= 8 && d.length <= 15 : d.length === 10 || (d.length === 11 && d[0] === '1'); };
  const fmtPhone = (e) => { if (!e) return ''; const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e; };
  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const PALETTE = ['blue', 'purple', 'orange', 'teal', 'pink', 'indigo', 'green', 'brown'];
  const colorFor = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `var(--${PALETTE[h % PALETTE.length]})`; };
  const avatar = (id, name, cls = '') => `<span class="avatar ${cls}" style="--c:${colorFor(id)}" title="${esc(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  const curGroup = () => S.groups.find((g) => g.id === S.gid) || null;
  const isOrganizer = () => curGroup()?.role === 'organizer';
  const canModify = (ownerId) => S.me && (isOrganizer() || S.me.id === ownerId);
  const gp = (path = '') => `/groups/${encodeURIComponent(S.gid)}${path}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

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
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>',
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
    if (!S.gid) return;
    const gid = S.gid;
    const [e, p, m] = await Promise.all([api('GET', gp('/events')), api('GET', gp('/polls')), api('GET', gp('/members'))]);
    if (gid !== S.gid) return; // switched groups mid-load
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
    const phoneRow = m === 'signup' ? `<div class="row"><label for="f-phone">Mobile</label><input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Optional"></div>` : '';
    if (m !== 'reset') fields += `<div class="row"><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>`;
    if (m !== 'forgot') fields += `<div class="row"><label for="f-pw">Password</label><input id="f-pw" name="password" type="password" minlength="8" autocomplete="${m === 'signin' ? 'current-password' : 'new-password'}" placeholder="${m === 'signin' ? 'Required' : 'At least 8 characters'}" required></div>`;
    fields += phoneRow;
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
    if (S.authMode === 'signup' && v.phone && !validPhone(v.phone)) return err('That phone number doesn\u2019t look right. Use a 10-digit number like (812) 555-0123, or leave it blank.');
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
      if (S.authMode === 'signup') toast('Account created');
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }

  // ---------- Render: shell ----------
  function render() {
    if (!S.me) { closeSheet(true); return renderAuth(); }
    if (!S.groups.length) return renderOnboarding();
    const g = curGroup();
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
          <button class="group-switch" data-action="group-menu" aria-haspopup="menu" aria-label="Current group: ${esc(g.name)}. Switch groups">
            <span class="gs-dot" style="--c:${colorFor(g.id)}">${esc(initials(g.name))}</span>
            <span class="gs-name">${esc(g.name)}</span>
            <svg class="gs-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>
          </button>
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
    const g = curGroup(), org = isOrganizer();
    const joined = (iso) => new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return `
      <div class="title-row"><div><h1 class="large-title">Members</h1><div class="sub">${S.members.length} ${S.members.length === 1 ? 'person' : 'people'} in ${esc(g.name)}</div></div></div>
      <div style="max-width:640px">
        <div class="invite card">
          <div class="invite-text">
            <div class="invite-label">Invite people</div>
            <div class="small muted">Share this code. New members enter it after they sign up.</div>
          </div>
          <div class="invite-code">
            <code>${esc(g.code)}</code>
            <button class="btn sm tinted" data-action="copy-invite">Copy Invite</button>
          </div>
        </div>
        <div class="group people" style="margin-top:22px">
          ${S.members.map((m) => `<div class="person">${avatar(m.id, m.name)}<div class="nm">${esc(m.name)}${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}<small>Joined ${esc(joined(m.joined))}</small></div>${m.role === 'organizer' ? '<span class="pill blue">Organizer</span>' : ''}${org && m.id !== S.me.id ? `<button class="icon-btn" data-action="member-actions" data-id="${esc(m.id)}" aria-label="Manage ${esc(m.name)}">${I.more}</button>` : ''}</div>`).join('')}
        </div>
        <p class="group-foot">Everyone here gets an email when a new event or poll is added, unless they turn it off in their profile.${org ? ' As an organizer, tap ••• next to someone to make them an organizer or remove them.' : ''}</p>
      </div>`;
  }

  // ---------- Onboarding (no groups yet) ----------
  function renderOnboarding() {
    closeSheet(true);
    const mode = S.onboard || 'join';
    $app.innerHTML = `
      <main class="auth-wrap">
        <div class="auth-card">
          <div class="app-icon"><img src="/icon.svg" alt=""></div>
          <h1>Hi, ${esc(S.me.name.split(' ')[0])}</h1>
          <p class="sub">Join your group with the code your leader shared, or start a new group of your own.</p>
          <div class="segmented" role="tablist">
            <span class="thumb" style="width:calc(50% - 2px);transform:translateX(${mode === 'create' ? '100%' : '0'})"></span>
            <button type="button" role="tab" aria-selected="${mode === 'join'}" data-action="onboard-mode" data-mode="join">Join a Group</button>
            <button type="button" role="tab" aria-selected="${mode === 'create'}" data-action="onboard-mode" data-mode="create">Start a Group</button>
          </div>
          <form id="onboard-form" novalidate autocomplete="off">
            ${groupFields(mode)}
            <div id="sheet-msg"></div>
            <button class="btn block" type="submit">${mode === 'create' ? 'Create Group' : 'Join Group'}</button>
          </form>
          <div class="auth-foot"><button type="button" class="link" data-action="logout">Sign out</button></div>
        </div>
      </main>`;
    const f = $app.querySelector('#onboard-form');
    f.addEventListener('submit', (e) => { e.preventDefault(); submitGroupForm(f, mode); });
    wireCodeSuggest(f);
    const first = f.querySelector('input');
    if (first && matchMedia('(min-width: 761px)').matches) first.focus();
  }
  function groupFields(mode, g) {
    if (mode === 'join') return `
      <div class="group"><div class="row"><label for="g-code">Code</label><input id="g-code" name="code" placeholder="e.g. grace-group" autocapitalize="none" spellcheck="false" required></div></div>
      <p class="group-foot" style="text-align:left">Ask your group leader for the code.</p>`;
    return `
      <div class="group">
        <div class="row"><label for="g-name">Name</label><input id="g-name" name="name" maxlength="60" placeholder="e.g. Tuesday Night Group" value="${esc(g?.name || '')}" required></div>
        <div class="row"><label for="g-code">Code</label><input id="g-code" name="code" maxlength="24" placeholder="Pick an invite code" autocapitalize="none" spellcheck="false" value="${esc(g?.code || '')}" required></div>
      </div>
      <p class="group-foot" style="text-align:left">${g ? 'Changing the code means the old one stops working. People already in the group stay in.' : 'You’ll be the organizer. Share the code with people you want to invite. It can be 4–24 letters, numbers or dashes.'}</p>`;
  }
  function suggestCode(name) {
    const slug = name.toLowerCase().normalize('NFKD').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18).replace(/-+$/, '');
    return (slug.length >= 2 ? slug : 'group') + '-' + Math.floor(10 + Math.random() * 90);
  }
  function wireCodeSuggest(root) {
    const name = root.querySelector('#g-name'), code = root.querySelector('#g-code');
    if (!name || !code || code.value) return;
    let touched = false;
    code.addEventListener('input', () => { touched = true; });
    name.addEventListener('input', () => { if (!touched) code.value = name.value.trim() ? suggestCode(name.value) : ''; });
  }
  async function submitGroupForm(form, mode, editing) {
    const v = Object.fromEntries(new FormData(form));
    const msg = form.querySelector('#sheet-msg'), btn = form.querySelector('button[type=submit]');
    const err = (t) => { msg.innerHTML = `<div class="form-error">${esc(t)}</div>`; };
    msg.innerHTML = '';
    const code = (v.code || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (mode !== 'join' && !(v.name || '').trim()) return err('Please give your group a name.');
    if (!code) return err('Please enter a code.');
    if (mode !== 'join' && !/^[a-z0-9][a-z0-9-]{2,22}[a-z0-9]$/.test(code)) return err('Codes are 4–24 characters: letters, numbers and dashes.');
    btn.disabled = true;
    try {
      let r;
      if (editing) r = await api('PATCH', `/groups/${encodeURIComponent(editing)}`, { name: v.name, code });
      else if (mode === 'join') r = await api('POST', '/groups/join', { code });
      else r = await api('POST', '/groups', { name: v.name, code });
      await refreshGroups();
      if (editing) { closeSheet(); render(); return toast('Group updated'); }
      await switchGroup(r.group.id);
      toast(r.already ? `You're already in ${r.group.name}` : mode === 'join' ? `Welcome to ${r.group.name}!` : `${r.group.name} is ready. Invite people with code ${r.group.code}`);
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }
  async function refreshGroups() {
    const me = await api('GET', '/me');
    S.me = me.user; S.groups = me.groups || [];
    if (S.gid && !S.groups.some((g) => g.id === S.gid)) S.gid = null;
    if (!S.gid && S.groups.length) S.gid = S.groups[0].id;
  }
  async function switchGroup(gid) {
    closeMenu(); closeSheet(true);
    S.gid = gid; store.set('sg_group', gid);
    S.loaded = false; S.events = []; S.polls = []; S.members = [];
    render();
    await loadAll();
    render();
  }
  function inviteText() {
    const g = curGroup();
    return `Join ${g.name} on ${S.config.appName}! Sign up at ${location.origin} and enter the group code: ${g.code}`;
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch {
      const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch {}
      ta.remove(); return ok;
    }
  }

  // ---------- Group menu (pull-down) ----------
  function openMenu() {
    const btn = document.querySelector('.group-switch');
    if (!btn) return;
    closeMenu();
    const r = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'group-menu';
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="menu-label">Your Groups</div>
      ${S.groups.map((g) => `<button role="menuitemradio" aria-checked="${g.id === S.gid}" class="menu-item" data-action="switch-group" data-id="${esc(g.id)}">
        <span class="check">${g.id === S.gid ? I.check : ''}</span>
        <span class="gs-dot" style="--c:${colorFor(g.id)}">${esc(initials(g.name))}</span>
        <span class="mi-text"><b>${esc(g.name)}</b><small>${g.memberCount} member${g.memberCount === 1 ? '' : 's'}${g.role === 'organizer' ? ' · Organizer' : ''}</small></span>
      </button>`).join('')}
      <div class="menu-sep"></div>
      <button role="menuitem" class="menu-item" data-action="group-info"><span class="check"></span><span class="mi-icon">${I.info}</span><span class="mi-text">Group Info &amp; Invite</span></button>
      <div class="menu-sep"></div>
      <button role="menuitem" class="menu-item" data-action="join-group"><span class="check"></span><span class="mi-icon">${I.key}</span><span class="mi-text">Join a Group…</span></button>
      <button role="menuitem" class="menu-item" data-action="new-group"><span class="check"></span><span class="mi-icon">${I.plus}</span><span class="mi-text">Create a Group…</span></button>`;
    document.body.appendChild(menu);
    const w = menu.offsetWidth;
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w))}px`;
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', menuOutside, true), 0);
    menu.querySelector('.menu-item')?.focus({ preventScroll: true });
  }
  function menuOutside(e) { if (!e.target.closest('#group-menu, .group-switch')) closeMenu(); }
  function closeMenu() {
    document.removeEventListener('pointerdown', menuOutside, true);
    const m = document.getElementById('group-menu');
    if (m) m.remove();
    document.querySelector('.group-switch')?.setAttribute('aria-expanded', 'false');
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
    if (form && kind === 'group-new') wireCodeSuggest(form);
  }
  function refreshSheet() {
    const sheet = $sheetRoot.querySelector('.sheet');
    if (!sheet || !S.sheet || ['event-form', 'poll-form', 'group-new', 'group-join', 'group-edit', 'profile'].includes(S.sheet.kind)) return;
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
            <div class="row"><label>Time</label>${timePicker('time', e.time, 'Event time')}</div>
            <div class="row"><label for="ev-cost">Cost</label><span class="prefix">$</span><input id="ev-cost" name="cost" inputmode="decimal" placeholder="0.00 (leave blank if none)" value="${e.cost ?? ''}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description — what to bring, who's hosting, anything people should know" maxlength="4000" aria-label="Description">${esc(e.description)}</textarea></div>
          </div>
          <p class="group-foot">Set the hour to -- for an all-day event. Enter 0 for a free event. ${s.id ? '' : 'Everyone in the group will get an email about it.'}</p>
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
      const p = s.id ? S.polls.find((x) => x.id === s.id) : null;
      const d = p || { title: '', location: '', cost: null, description: '', options: [{ date: '', time: '' }, { date: '', time: '' }] };
      const opts = d.options.map((o) => ({ id: o.id || '', date: o.date, time: o.time }));
      return `<form autocomplete="off" novalidate>${head(p ? 'Edit Poll' : 'New Poll', 'Cancel', p ? 'Save' : 'Create')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="title" placeholder="What are we planning?" maxlength="120" value="${esc(d.title)}" aria-label="Title" required></div>
            <div class="row"><input name="location" placeholder="Location" maxlength="200" value="${esc(d.location)}" aria-label="Location"></div>
            <div class="row"><label for="p-cost">Cost</label><span class="prefix">$</span><input id="p-cost" name="cost" inputmode="decimal" placeholder="0.00 (optional)" value="${esc(d.cost ?? '')}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description (optional)" maxlength="4000" aria-label="Description">${esc(d.description)}</textarea></div>
          </div>
          <div class="group-label" style="margin-top:22px">Date options</div>
          <div class="group" id="opt-list">
            ${opts.map((o) => optRow(o, opts.length > 2)).join('')}
            <div class="row button-row" data-action="add-opt" role="button" tabindex="0">${I.plus.replace('<svg', '<svg width="18" height="18"')} Add another date</div>
          </div>
          <p class="group-foot">${p
            ? 'Adding dates keeps everyone\u2019s responses. Changing the date or time of an option clears the responses for that option only, since people answered for a different time. Removing an option removes its responses.'
            : 'Add at least two dates. Members mark each one Yes, Maybe, or No, and you\u2019ll see who answered. When you pick the final date, it goes on the calendar and everyone gets an email.'}</p>
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
          ${owner ? `<div class="actions">${open ? `<button class="btn tinted block" data-action="edit-poll" data-id="${esc(p.id)}">Edit Poll</button>` : ''}<button class="btn danger block" data-action="delete-poll" data-id="${esc(p.id)}">Delete Poll</button></div>` : ''}
        </div>`;
    }
    if (s.kind === 'group-new' || s.kind === 'group-join' || s.kind === 'group-edit') {
      const mode = s.kind === 'group-join' ? 'join' : 'create';
      const g = s.kind === 'group-edit' ? curGroup() : null;
      const title = s.kind === 'group-join' ? 'Join a Group' : g ? 'Edit Group' : 'New Group';
      return `<form autocomplete="off" novalidate>${head(title, 'Cancel', s.kind === 'group-join' ? 'Join' : g ? 'Save' : 'Create')}
        <div class="sheet-body">${groupFields(mode, g)}<div id="sheet-msg"></div></div></form>`;
    }
    if (s.kind === 'group-info') {
      const g = curGroup();
      if (!g) return '';
      const org = g.role === 'organizer';
      return `${head('Group Info', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero">
            <span class="gs-dot xl" style="--c:${colorFor(g.id)}">${esc(initials(g.name))}</span>
            <h2 style="margin-top:12px">${esc(g.name)}</h2>
            <div class="w">${g.memberCount} member${g.memberCount === 1 ? '' : 's'} · You're ${org ? 'an organizer' : 'a member'}</div>
          </div>
          <div class="group-label">Invite</div>
          <div class="group kv">
            <div class="row"><span>Group code</span><span class="v"><code class="code-inline">${esc(g.code)}</code></span></div>
            <div class="row button-row" data-action="copy-code" role="button" tabindex="0">Copy Code</div>
            <div class="row button-row" data-action="copy-invite" role="button" tabindex="0">Copy Invite Message</div>
          </div>
          <p class="group-foot">New members sign up, then enter this code to join.</p>
          ${org ? `<div class="group-label" style="margin-top:22px">Organizer</div>
          <div class="group kv">
            <div class="row button-row" data-action="edit-group" role="button" tabindex="0">Edit Name &amp; Code<span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div>
            <div class="row"><span>Email delivery</span><span class="v" id="email-status">Checking…</span></div>
          </div>` : ''}
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="leave-group" role="button" tabindex="0">Leave Group</div></div>
        </div>`;
    }
    if (s.kind === 'member') {
      const m = S.members.find((x) => x.id === s.id);
      if (!m) return '';
      return `${head('Member', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero">${avatar(m.id, m.name, 'lg')}<h2 style="margin-top:12px">${esc(m.name)}</h2><div class="w">${m.role === 'organizer' ? 'Organizer' : 'Member'} of ${esc(curGroup().name)}</div></div>
          <div class="group">
            ${m.role === 'organizer'
              ? `<div class="row button-row" data-action="set-role" data-id="${esc(m.id)}" data-role="member" role="button" tabindex="0">Remove Organizer Role</div>`
              : `<div class="row button-row" data-action="set-role" data-id="${esc(m.id)}" data-role="organizer" role="button" tabindex="0">Make Organizer</div>`}
          </div>
          <p class="group-foot">Organizers can edit or delete any event or poll, change the group code, and manage members.</p>
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="remove-member" data-id="${esc(m.id)}" role="button" tabindex="0">Remove from Group</div></div>
        </div>`;
    }
    if (s.kind === 'profile') {
      const m = S.me;
      return `<form autocomplete="off">${head('Profile', 'Done', 'Save')}
        <div class="sheet-body">
          <div class="detail-hero">${avatar(m.id, m.name, 'lg')}<h2 style="margin-top:12px">${esc(m.name)}</h2><div class="w">${esc(m.email)}</div></div>
          <div class="group">
            <div class="row"><label for="pr-name">Name</label><input id="pr-name" name="name" maxlength="80" value="${esc(m.name)}"></div>
            <div class="row"><label for="pr-phone">Mobile</label><input id="pr-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Optional" value="${esc(fmtPhone(m.phone))}"></div>
          </div>
          <div class="group-label" style="margin-top:22px">Notifications</div>
          <div class="group">
            <div class="row"><span>Email me about new events and polls</span><label class="switch"><input type="checkbox" name="notify" data-action="toggle-notify" ${m.notify ? 'checked' : ''}><span></span></label></div>
          </div>
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
    if (['group-new', 'group-join', 'group-edit'].includes(s.kind)) {
      return submitGroupForm(form, s.kind === 'group-join' ? 'join' : 'create', s.kind === 'group-edit' ? S.gid : null);
    }
    const v = Object.fromEntries(new FormData(form));
    const err = (t) => { msg.innerHTML = `<div class="form-error">${esc(t)}</div>`; msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    msg.innerHTML = '';
    try {
      btn.disabled = true;
      if (s.kind === 'event-form') {
        if (!v.title.trim()) { btn.disabled = false; return err('Please add a title.'); }
        if (!v.date) { btn.disabled = false; return err('Please choose a date.'); }
        v.time = readTime(form, 'time');
        const body = { title: v.title, location: v.location, date: v.date, time: v.time, cost: v.cost, description: v.description };
        const r = s.id ? await api('PUT', gp(`/events/${s.id}`), body) : await api('POST', gp('/events'), body);
        await loadAll();
        S.selected = r.event.date; const d = parseYmd(r.event.date); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
        S.view = 'calendar'; history.replaceState(null, '', '#calendar');
        closeSheet(); render();
        toast(s.id ? 'Event updated' : 'Event added · Group notified');
      } else if (s.kind === 'poll-form') {
        if (!v.title.trim()) { btn.disabled = false; return err('Please add a title.'); }
        const options = readOptions(form).filter((o) => o.date);
        if (options.length < 2) { btn.disabled = false; return err('Add at least two dates for people to vote on.'); }
        const keys = options.map((o) => o.date + o.time);
        if (new Set(keys).size !== keys.length) { btn.disabled = false; return err('Two options have the same date and time. Change or remove one.'); }
        const body = { title: v.title, location: v.location, cost: v.cost, description: v.description, options };
        const r = s.id ? await api('PUT', gp(`/polls/${s.id}`), body) : await api('POST', gp('/polls'), body);
        await loadAll();
        S.view = 'polls'; render();
        openSheet('poll', { id: r.poll.id }); history.replaceState(null, '', '#polls/' + r.poll.id);
        toast(s.id ? 'Poll updated' : 'Poll created · Group notified');
      } else if (s.kind === 'profile') {
        if (v.phone && !validPhone(v.phone)) { btn.disabled = false; return err('That phone number doesn\u2019t look right. Use a 10-digit number like (812) 555-0123, or leave it blank.'); }
        const r = await api('PATCH', '/me', { name: v.name, phone: v.phone || '' });
        S.me = r.user; await loadAll(); closeSheet(); render(); toast('Profile saved');
      }
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }

  // ---------- Time picker & poll option rows ----------
  let rowSeq = 0;
  function timePicker(prefix, value, label) {
    let h = '', m = '00', per = 'PM';
    if (value) { const [H, M] = value.split(':').map(Number); h = String(((H + 11) % 12) + 1); m = pad(M); per = H < 12 ? 'AM' : 'PM'; }
    const mins = Array.from({ length: 12 }, (_, i) => pad(i * 5));
    if (!mins.includes(m)) { mins.push(m); mins.sort(); }
    return `<span class="tp${h ? '' : ' tp-empty'}" role="group" aria-label="${esc(label)}">
      <select name="${prefix}_h" aria-label="Hour" data-tp><option value="">--</option>${Array.from({ length: 12 }, (_, i) => `<option${String(i + 1) === h ? ' selected' : ''}>${i + 1}</option>`).join('')}</select>
      <span class="tp-colon">:</span>
      <select name="${prefix}_m" aria-label="Minutes" data-tp>${mins.map((x) => `<option${x === m ? ' selected' : ''}>${x}</option>`).join('')}</select>
      <select name="${prefix}_p" aria-label="AM or PM" data-tp><option${per === 'AM' ? ' selected' : ''}>AM</option><option${per === 'PM' ? ' selected' : ''}>PM</option></select>
    </span>`;
  }
  function readTime(root, prefix) {
    const q = (n) => root.querySelector(`[name="${prefix}_${n}"]`);
    if (!q('h') || !q('h').value) return '';
    let H = Number(q('h').value) % 12;
    if (q('p').value === 'PM') H += 12;
    return `${pad(H)}:${q('m').value || '00'}`;
  }
  function optRow(o, removable) {
    const k = 'o' + (++rowSeq);
    return `<div class="row opt-row" data-key="${k}" data-id="${esc(o.id || '')}">
      <button type="button" class="opt-remove" data-action="remove-opt" aria-label="Remove this date" ${removable ? '' : 'disabled'}>${I.minus.replace('<svg', '<svg width="22" height="22"')}</button>
      <input type="date" name="${k}_d" value="${esc(o.date)}" aria-label="Date" class="opt-date">
      ${timePicker(k + '_t', o.time, 'Time')}
    </div>`;
  }
  function readOptions(form) {
    return [...form.querySelectorAll('.opt-row')].map((r) => ({
      id: r.dataset.id || undefined,
      date: r.querySelector('.opt-date').value,
      time: readTime(r, r.dataset.key + '_t'),
    }));
  }
  function refreshRemoveButtons(form) {
    const rows = form.querySelectorAll('.opt-row');
    rows.forEach((r) => { r.querySelector('.opt-remove').disabled = rows.length <= 2; });
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
      try { await api('DELETE', gp(`/events/${e.id}`)); await loadAll(); closeSheet(); render(); toast('Event deleted'); } catch (ex) { toast(ex.message); }
    },
    ics: (el) => downloadIcs(S.events.find((x) => x.id === el.dataset.id)),
    'new-poll': () => openSheet('poll-form'),
    'open-poll': (el) => { openSheet('poll', { id: el.dataset.id }); history.replaceState(null, '', '#polls/' + el.dataset.id); },
    'add-opt': () => {
      const form = $sheetRoot.querySelector('form'), rows = form.querySelectorAll('.opt-row');
      const last = rows[rows.length - 1];
      const lastDate = last?.querySelector('.opt-date').value || '';
      const date = lastDate ? ymd(new Date(parseYmd(lastDate).getTime() + 7 * 864e5 + 3600e3)) : ''; // same weekday next week
      const time = last ? readTime(last, last.dataset.key + '_t') : '';
      const tmp = document.createElement('div');
      tmp.innerHTML = optRow({ date, time }, true);
      const row = tmp.firstElementChild;
      if (last && !time) { // keep whatever AM/PM and minutes were picked even if the hour isn't set yet
        const k = last.dataset.key, nk = row.dataset.key;
        row.querySelector(`[name="${nk}_t_m"]`).value = last.querySelector(`[name="${k}_t_m"]`).value;
        row.querySelector(`[name="${nk}_t_p"]`).value = last.querySelector(`[name="${k}_t_p"]`).value;
      }
      form.querySelector('[data-action="add-opt"]').before(row);
      refreshRemoveButtons(form);
      row.querySelector('.opt-date').focus();
    },
    'remove-opt': (el) => {
      const form = el.closest('form');
      if (form.querySelectorAll('.opt-row').length <= 2) return;
      el.closest('.opt-row').remove();
      refreshRemoveButtons(form);
    },
    'edit-poll': (el) => openSheet('poll-form', { id: el.dataset.id }),
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
        const r = await api('POST', gp(`/polls/${p.id}/vote`), { votes: { [o.id]: next } });
        Object.assign(p, r.poll); refreshSheet();
        const had = document.querySelector('.badge'); render(); if (had && !pendingPolls().length) toast('Thanks — your response is saved');
      } catch (ex) { toast(ex.message); await loadAll(); refreshSheet(); render(); }
    },
    schedule: async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.poll);
      const o = p.options.find((x) => x.id === el.dataset.opt);
      if (!confirm(`Schedule "${p.title}" for ${fmtLong(o.date)}${o.time ? ' at ' + fmtTime(o.time) : ''}?\n\nIt will go on the calendar, voting will close, and everyone will get an email.`)) return;
      try {
        await api('POST', gp(`/polls/${p.id}/schedule`), { optionId: o.id });
        await loadAll(); refreshSheet(); render(); toast('Scheduled · Added to the calendar');
      } catch (ex) { toast(ex.message); }
    },
    'delete-poll': async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.id);
      if (!confirm(`Delete the poll "${p.title}" and all its responses?${p.eventId ? ' The calendar event will stay.' : ''}`)) return;
      try { await api('DELETE', gp(`/polls/${p.id}`)); await loadAll(); closeSheet(); render(); toast('Poll deleted'); } catch (ex) { toast(ex.message); }
    },
    'goto-date': (el) => {
      S.selected = el.dataset.date; const d = parseYmd(S.selected); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      closeSheet(); go('calendar');
    },
    profile: () => { closeMenu(); openSheet('profile'); },
    'toggle-notify': async (el) => {
      try { const r = await api('PATCH', '/me', { notify: el.checked }); S.me = r.user; toast(el.checked ? 'Email notifications on' : 'Email notifications off'); }
      catch (ex) { el.checked = !el.checked; toast(ex.message); }
    },
    logout: async () => {
      try { await api('POST', '/logout', {}); } catch {}
      S.me = null; S.groups = []; S.gid = null; S.loaded = false; S.authMode = 'signin'; closeMenu(); closeSheet(true); history.replaceState(null, '', '#'); render();
    },
    'onboard-mode': (el) => { S.onboard = el.dataset.mode; renderOnboarding(); },
    'group-menu': () => (document.getElementById('group-menu') ? closeMenu() : openMenu()),
    'switch-group': (el) => { if (el.dataset.id === S.gid) return closeMenu(); switchGroup(el.dataset.id).then(() => toast(`Switched to ${curGroup().name}`)); },
    'new-group': () => { closeMenu(); openSheet('group-new'); },
    'join-group': () => { closeMenu(); openSheet('group-join'); },
    'group-info': async () => {
      closeMenu(); openSheet('group-info');
      if (isOrganizer()) {
        try {
          const r = await api('GET', gp('/email-log'));
          const last = r.log[0], el = document.getElementById('email-status');
          if (el) el.textContent = !r.configured ? 'Not set up' : last && last.status === 'failed' ? 'Last send failed' : 'Connected';
        } catch {}
      }
    },
    'edit-group': () => openSheet('group-edit'),
    'copy-code': async () => toast((await copyText(curGroup().code)) ? 'Code copied' : 'Couldn’t copy — the code is ' + curGroup().code),
    'copy-invite': async () => toast((await copyText(inviteText())) ? 'Invite copied — paste it in a text or email' : 'Couldn’t copy. The code is ' + curGroup().code),
    'leave-group': async () => {
      const g = curGroup();
      if (!confirm(`Leave ${g.name}? You'll stop seeing its calendar and getting its emails. You can rejoin with the code.`)) return;
      try {
        await api('POST', gp('/leave'), {});
        S.gid = null; await refreshGroups(); closeSheet(true);
        if (S.gid) await switchGroup(S.gid); else render();
        toast(`You left ${g.name}`);
      } catch (ex) { toast(ex.message); }
    },
    'member-actions': (el) => openSheet('member', { id: el.dataset.id }),
    'set-role': async (el) => {
      try {
        await api('PATCH', gp(`/members/${encodeURIComponent(el.dataset.id)}`), { role: el.dataset.role });
        await loadAll(); refreshSheet(); render(); toast(el.dataset.role === 'organizer' ? 'Now an organizer' : 'Organizer role removed');
      } catch (ex) { toast(ex.message); }
    },
    'remove-member': async (el) => {
      const m = S.members.find((x) => x.id === el.dataset.id);
      if (!confirm(`Remove ${m.name} from ${curGroup().name}? They can rejoin only with the current code.`)) return;
      try { await api('DELETE', gp(`/members/${encodeURIComponent(m.id)}`)); await refreshGroups(); await loadAll(); closeSheet(); render(); toast(`${m.name} removed`); }
      catch (ex) { toast(ex.message); }
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
    if (el.matches?.('select[data-tp]')) { const tp = el.closest('.tp'); tp.classList.toggle('tp-empty', !tp.querySelector('select').value); }
    if (el.dataset?.action === 'toggle-notify') actions['toggle-notify'](el);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (document.getElementById('group-menu')) closeMenu(); else if (S.sheet) closeSheet(); }
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
    if (S.sheet && ['event-form', 'poll-form', 'profile', 'group-new', 'group-join', 'group-edit'].includes(S.sheet.kind)) return;
    if (document.getElementById('group-menu')) return;
    try { await refreshGroups(); if (S.groups.length) await loadAll(); render(); if (S.sheet) refreshSheet(); } catch {}
  }
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  // ---------- Boot ----------
  async function boot() {
    const t = new Date();
    S.month = S.month || new Date(t.getFullYear(), t.getMonth(), 1);
    S.selected = S.selected || todayStr();
    const me = await api('GET', '/me');
    S.me = me.user; S.groups = me.groups || [];
    if (!S.me) return render();
    if (S.authMode === 'reset') { S.authMode = 'signin'; history.replaceState(null, '', '#calendar'); }
    const wanted = [S.linkGroup, store.get('sg_group')].find((id) => id && S.groups.some((g) => g.id === id));
    S.gid = wanted || S.groups[0]?.id || null;
    if (S.gid) store.set('sg_group', S.gid);
    if (S.linkGroup) { history.replaceState(null, '', location.pathname + location.hash); S.linkGroup = null; }
    if (!S.gid) return render(); // onboarding
    render(); // shell with spinner
    await loadAll();
    render();
    if (S.pendingPoll) { const id = S.pendingPoll; S.pendingPoll = null; if (S.polls.some((p) => p.id === id)) openSheet('poll', { id }); }
  }
  (async () => {
    S.linkGroup = new URLSearchParams(location.search).get('g');
    readHash();
    try { S.config = await api('GET', '/config'); document.title = S.config.appName; } catch {}
    if (S.authMode === 'reset') { S.me = null; return renderAuth(); }
    try { await boot(); } catch (ex) { $app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Can't connect</h1><p class="sub">${esc(ex.message)}</p><button class="btn" onclick="location.reload()">Try Again</button></div></div>`; }
  })();
})();
