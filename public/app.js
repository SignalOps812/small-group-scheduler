/* Small Group — client app (no build step, no dependencies) */
(() => {
  'use strict';

  // ---------- State ----------
  const S = {
    config: { appName: 'Groups' },
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
  // ---------- Time zones ----------
  // Times are stored as wall-clock time + IANA zone. Older items have no zone and read as the viewer's own.
  const TZ_LIST = [
    ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'],
    ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['America/Halifax', 'Atlantic'],
    ['UTC', 'UTC'], ['Europe/London', 'London'], ['Europe/Berlin', 'Central Europe'], ['Asia/Kolkata', 'India'], ['Asia/Tokyo', 'Japan'], ['Australia/Sydney', 'Sydney'],
  ];
  const tzOffset = (ts, tz) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
    } catch { return 0; }
  };
  const zonedInstant = (date, time, tz) => { // the real moment a wall-clock time happens in a zone
    const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi);
    let t = wall;
    for (let i = 0; i < 3; i++) t = wall - tzOffset(t, tz);
    return new Date(t);
  };
  const DEVICE_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  // Zones that keep the same clock all year are interchangeable (e.g. Indianapolis = Eastern)
  const sameRules = (a, b) => { const y = new Date().getFullYear(); return [0, 3, 6, 10].every((m) => tzOffset(Date.UTC(y, m, 15), a) === tzOffset(Date.UTC(y, m, 15), b)); };
  const HOME_TZ = (TZ_LIST.find(([z]) => z === DEVICE_TZ) || TZ_LIST.find(([z]) => sameRules(z, DEVICE_TZ)) || [DEVICE_TZ])[0];
  const tzName = (tz) => (TZ_LIST.find(([z]) => z === tz) || [, (tz.split('/').pop() || tz).replace(/_/g, ' ')])[1];
  const tzAbbr = (date, time, tz) => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(zonedInstant(date, time || '12:00', tz)).find((x) => x.type === 'timeZoneName')?.value || tzName(tz); }
    catch { return tzName(tz); }
  };
  const isLocalTz = (date, time, tz) => !tz || tzOffset(zonedInstant(date, time, tz).getTime(), tz) === -zonedInstant(date, time, tz).getTimezoneOffset() * 6e4;
  // "7:00 PM" in the viewer's zone, "7:00 PM CST" when the item is set in a different zone
  const fmtWhenTime = (x) => !x.time ? '' : fmtTime(x.time) + (isLocalTz(x.date, x.time, x.tz) ? '' : ' ' + tzAbbr(x.date, x.time, x.tz));
  const localEquivalent = (x) => { // "8:00 PM your time" for items set in another zone
    if (!x.time || isLocalTz(x.date, x.time, x.tz)) return '';
    const d = zonedInstant(x.date, x.time, x.tz), sameDay = ymd(d) === x.date;
    return `${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${sameDay ? '' : ' ' + d.toLocaleDateString(undefined, { weekday: 'short' })} your time`;
  };
  function tzSelect(name, value, label = 'Time zone') {
    const v = value || HOME_TZ, opts = TZ_LIST.slice();
    if (!opts.some(([z]) => z === v)) opts.unshift([v, tzName(v)]);
    if (!opts.some(([z]) => z === HOME_TZ)) opts.unshift([HOME_TZ, tzName(HOME_TZ)]);
    return `<select class="tz-select" name="${name}" aria-label="${esc(label)}" title="${esc(label)} (defaults to yours: ${esc(tzName(HOME_TZ))})">${opts.map(([z, n]) => `<option value="${esc(z)}"${z === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }
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
  const feat = (f) => { const g = curGroup(); return !!(g && (g.features || { members: true, prayer: false })[f]); };
  // Members tab stays visible to organizers even when hidden from everyone else
  const showTab = (k) => k === 'prayer' ? feat('prayer') : k === 'meals' ? feat('meals') : k === 'topics' ? feat('topics') : k === 'members' ? feat('members') || isOrganizer() : true;
  const unreadTopics = () => (S.topics || []).filter((t) => t.unread).length;
  const tabBadge = (k) => { const n = k === 'polls' ? pendingCount() : k === 'topics' ? unreadTopics() : 0; return n ? `<span class="badge">${n}</span>` : ''; };
  const tabList = () => [['calendar', 'Calendar', I.cal], ['polls', 'Polls', I.poll], ['prayer', 'Prayer', I.pray], ['meals', 'Meals', I.meal], ['topics', 'Topics', I.chat], ['members', 'Members', I.people]].filter(([k]) => showTab(k));
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
    phone: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.3.2 2.5.57 3.6a1 1 0 0 1-.25 1z"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.4 1.2 4.6 3.1 6.1L4.4 21l4-2c1.1.3 2.3.5 3.6.5 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7l8 6 8-6"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/></svg>',
    meal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h18a9 9 0 0 1-18 0z"/><path d="M8 9c0-1.5 1-2 1-3.5M12 9c0-1.5 1-2 1-3.5M16 9c0-1.5 1-2 1-3.5"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.5M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.6 9.6 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h8A2.5 2.5 0 0 1 17 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3.2A2.5 2.5 0 0 1 4 10.5z"/><path d="M20 9v6.5a2.5 2.5 0 0 1-1 2V21l-3.3-2.5H11"/></svg>',
    pray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.9c0 5.6-7.5 10-7.5 10z"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" fill="var(--red)"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  // iOS-style alert that works everywhere (some browsers block window.confirm)
  function ask({ title, message = '', ok = 'OK', destructive = false }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'alert-backdrop';
      wrap.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-t">
        <div class="alert-body"><div class="alert-title" id="alert-t">${esc(title)}</div>${message ? `<div class="alert-msg">${esc(message)}</div>` : ''}</div>
        <div class="alert-actions"><button type="button" data-r="0">Cancel</button><button type="button" data-r="1" class="${destructive ? 'destructive' : 'primary'}">${esc(ok)}</button></div>
      </div>`;
      const done = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
      wrap.addEventListener('click', (e) => { const b = e.target.closest('button[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === wrap) done(false); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector(destructive ? 'button[data-r="0"]' : 'button[data-r="1"]').focus();
    });
  }

  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
  }

  async function api(method, path, body) {
    const res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
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
    const [e, p, m, pr, mt, tp] = await Promise.all([api('GET', gp('/events')), api('GET', gp('/polls')), api('GET', gp('/members')),
      feat('prayer') ? api('GET', gp('/prayers')) : Promise.resolve({ prayers: [] }),
      feat('meals') ? api('GET', gp('/meals')) : Promise.resolve({ trains: [] }),
      feat('topics') ? api('GET', gp('/topics')) : Promise.resolve({ topics: [] })]);
    if (gid !== S.gid) return; // switched groups mid-load
    S.events = e.events; S.polls = p.polls; S.members = m.members; S.prayers = pr.prayers; S.trains = mt.trains; S.topics = tp.topics; S.loaded = true;
  }
  const eventsOn = (d) => S.events.filter((e) => e.date === d);
  const pendingPolls = () => S.polls.filter((p) => p.status === 'open' && !p.responded);
  // Calendar events with pitch-in (not created from a scheduling poll) also appear on the Polls tab as food-only sign-ups
  const foodPolls = () => S.events.filter((e) => e.pitchIn && !e.pollId && e.date >= todayStr());
  const signedUp = (e) => (e.contributions || []).some((c) => c.mine || c.userId === S.me.id);
  const pendingCount = () => pendingPolls().length + foodPolls().filter((e) => !signedUp(e)).length;

  // ---------- Routing ----------
  function readHash() {
    const [view, arg] = location.hash.replace(/^#\/?/, '').split('/');
    if (view === 'reset' && arg) { S.resetToken = arg; S.authMode = 'reset'; return; }
    if (['calendar', 'polls', 'members', 'prayer', 'meals', 'topics'].includes(view)) S.view = view;
    if (view === 'topics' && arg) S.pendingTopic = arg;
    if (view === 'topics' && !arg) { S.topicOpen = null; S.editPost = null; }
    if (view === 'meals' && arg) S.pendingTrain = arg;
    if (view === 'prayer' && arg) S.pendingPrayer = arg;
    if (view === 'calendar' && arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) { S.selected = arg; const d = parseYmd(arg); S.month = new Date(d.getFullYear(), d.getMonth(), 1); }
    if (view === 'polls' && arg) S.pendingPoll = arg;
  }
  function go(view) { S.view = view; if (view === 'topics') { S.topicOpen = null; S.editPost = null; } history.replaceState(null, '', '#' + view); render(); window.scrollTo({ top: 0 }); }

  // ---------- Render: auth ----------
  function renderAuth() {
    const m = S.authMode;
    const name = esc(S.config.appName);
    const head = {
      signin: ['Welcome back', 'Sign in to see what your groups have planned.'],
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
          <div class="app-icon"><img src="/icon.svg?v=2" alt=""></div>
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
    const pend = pendingCount();
    if (!showTab(S.view)) { S.view = 'calendar'; history.replaceState(null, '', '#calendar'); }
    const tabs = tabList();
    const idx = tabs.findIndex((t) => t[0] === S.view);
    let body = '';
    if (!S.loaded) body = '<div class="spinner"></div>';
    else if (S.view === 'calendar') body = renderCalendar();
    else if (S.view === 'polls') body = renderPolls();
    else if (S.view === 'prayer') body = renderPrayer();
    else if (S.view === 'meals') body = renderMeals();
    else if (S.view === 'topics') body = renderTopics();
    else body = renderMembers();
    $app.innerHTML = `
      <header class="topbar">
        <div class="brand"><img src="/icon.svg?v=2" alt=""><span>${esc(S.config.appName)}</span></div>
        <div class="segmented" role="tablist" aria-label="Sections">
          <span class="thumb" style="width:calc(${100 / tabs.length}% - ${4 / tabs.length}px);transform:translateX(${idx * 100}%)"></span>
          ${tabs.map(([k, label]) => `<button role="tab" aria-selected="${S.view === k}" data-action="nav" data-view="${k}">${label}${tabBadge(k)}</button>`).join('')}
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
        ${tabs.map(([k, label, icon]) => `<button role="tab" aria-selected="${S.view === k}" data-action="nav" data-view="${k}">${icon}<span>${label}</span>${tabBadge(k)}</button>`).join('')}
      </nav>`;
    if (TOUR) requestAnimationFrame(tourPlace);
    else if (S.loaded && !S.me.tourDone && !S.sheet && !S.tourChecked) { S.tourChecked = true; setTimeout(() => startTour(false), 450); }
  }

  // ---------- First-run tour ----------
  let TOUR = null;
  // Visible copy of a tab: bottom bar on phones, segmented control on wider screens
  const tabEl = (view) => [...document.querySelectorAll(`.tabbar [data-view="${view}"], .topbar .segmented [data-view="${view}"]`)].find((e) => e.getBoundingClientRect().width > 0);
  function tourSteps() {
    const first = esc((S.me.name || '').split(' ')[0]), org = isOrganizer(), g = curGroup();
    const steps = [
      { title: `Welcome to ${esc(S.config.appName)}${first ? ', ' + first : ''}!`, text: `Here\u2019s a quick look at how ${esc(g.name)} plans things together. It takes about a minute.` },
      { el: () => document.querySelector('.group-switch'), title: 'Your groups', text: `You\u2019re in <b>${esc(g.name)}</b>. Tap here to switch groups, join another with a code, or start your own. <b>Group Info</b> has the invite code to share.${org ? ' As an organizer, Group Info is also where you turn features and email notifications on or off for the group.' : ''}` },
      { el: () => tabEl('calendar'), view: 'calendar', title: 'Calendar', text: 'Everything the group has scheduled. Tap a day to see what\u2019s on, then tap an event for details, to add it to your own calendar, or to sign up for a pitch-in.' },
      { el: () => document.querySelector('.title-row [data-action="new-event"]'), view: 'calendar', title: 'Add an event', text: 'Add a title, date, time, place and cost. Turn on <b>Pitch-in</b> to let people sign up for what they\u2019re bringing. The group gets an email about it.' },
      { el: () => tabEl('polls'), view: 'polls', title: 'Polls', text: 'Can\u2019t agree on a date? Start a poll with a few options and everyone marks <b>Yes</b>, <b>Maybe</b> or <b>No</b>. Polls waiting on you show a red badge and sit at the top.' },
    ];
    if (showTab('topics')) steps.push({ el: () => tabEl('topics'), view: 'topics', title: 'Discussions', text: 'Start a topic and talk it through together. Topics with new replies you haven\u2019t read show up at the top, with a badge on the tab.' });
    if (showTab('meals')) steps.push({ el: () => tabEl('meals'), view: 'meals', title: 'Meal Trains', text: 'When a family needs support, start a meal train and share its link. Anyone can sign up for a day, even without an account, and gets the address and a reminder by email.' });
    if (showTab('prayer')) steps.push({ el: () => tabEl('prayer'), view: 'prayer', title: 'Prayer Requests', text: 'Share a request with the group, and post updates as things change. Everyone can comment to offer encouragement.' });
    if (showTab('members')) steps.push({ el: () => tabEl('members'), view: 'members', title: 'Members', text: `See who\u2019s in the group and tap anyone to call, text or email them.${feat('members') ? '' : ' (This tab is hidden from regular members right now.)'}` });
    steps.push(
      { el: () => document.querySelector('.avatar-btn'), title: 'Your profile', text: 'Add your mobile number, choose which emails you get, or sign out. You can replay this tour from here anytime.' },
      { title: 'You\u2019re all set', text: pendingCount() ? `You have <b>${pendingCount()}</b> poll${pendingCount() === 1 ? '' : 's'} waiting on you. Head to Polls when you\u2019re ready.` : 'Have fun planning together!', done: true },
    );
    return steps;
  }
  function startTour(force) {
    if (TOUR || !S.me || !S.groups.length || !S.loaded) return;
    if (!force && (S.me.tourDone || S.sheet || document.getElementById('group-menu'))) return;
    closeMenu();
    TOUR = { steps: tourSteps(), i: 0, back: S.view };
    const root = document.createElement('div');
    root.id = 'tour';
    root.innerHTML = '<div class="tour-shade"></div><div class="tour-spot" aria-hidden="true"></div><div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text"></div>';
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';
    root.addEventListener('click', (e) => {
      const a = e.target.closest('[data-tour]');
      if (a) tourGo(a.dataset.tour);
    });
    document.addEventListener('keydown', tourKeys, true);
    window.addEventListener('resize', tourPlace);
    tourShow();
  }
  function tourKeys(e) {
    if (!TOUR) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); tourGo('skip'); }
    else if (e.key === 'ArrowRight') tourGo('next');
    else if (e.key === 'ArrowLeft') tourGo('back');
  }
  function tourGo(dir) {
    if (!TOUR) return;
    if (dir === 'skip' || (dir === 'next' && TOUR.i === TOUR.steps.length - 1)) return endTour();
    TOUR.i = Math.max(0, Math.min(TOUR.steps.length - 1, TOUR.i + (dir === 'back' ? -1 : 1)));
    tourShow();
  }
  function tourShow() {
    const st = TOUR.steps[TOUR.i], n = TOUR.steps.length, last = TOUR.i === n - 1;
    if (st.view && S.view !== st.view) { S.view = st.view; history.replaceState(null, '', '#' + st.view); render(); }
    const card = document.querySelector('#tour .tour-card');
    card.innerHTML = `
      <div class="tour-dots" aria-hidden="true">${TOUR.steps.map((_, k) => `<span class="${k === TOUR.i ? 'on' : ''}"></span>`).join('')}</div>
      <h3 id="tour-title">${st.title}</h3>
      <p id="tour-text">${st.text}</p>
      <div class="tour-actions">
        ${last ? '<span></span>' : '<button type="button" class="link-btn tour-skip" data-tour="skip">Skip tour</button>'}
        <span class="tour-nav">
          ${TOUR.i ? '<button type="button" class="btn sm tinted" data-tour="back">Back</button>' : ''}
          <button type="button" class="btn sm" data-tour="next">${last ? 'Get Started' : TOUR.i ? 'Next' : 'Show Me Around'}</button>
        </span>
      </div>
      <div class="sr-only" aria-live="polite">Step ${TOUR.i + 1} of ${n}</div>`;
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => { tourPlace(); card.querySelector('[data-tour="next"]').focus({ preventScroll: true }); });
  }
  function tourPlace() {
    if (!TOUR) return;
    const root = document.getElementById('tour'); if (!root) return;
    const st = TOUR.steps[TOUR.i], spot = root.querySelector('.tour-spot'), card = root.querySelector('.tour-card'), shade = root.querySelector('.tour-shade');
    const el = st.el && st.el();
    const r = el && el.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, gap = 14, pad = 6;
    if (!r || !r.width) { // centered welcome / finish card
      spot.style.display = 'none'; shade.style.display = 'block';
      card.classList.add('centered'); card.style.left = card.style.top = ''; return;
    }
    shade.style.display = 'none'; spot.style.display = 'block'; card.classList.remove('centered');
    Object.assign(spot.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const below = r.bottom + pad + gap + ch <= vh - 8;
    const top = below ? r.bottom + pad + gap : Math.max(8, r.top - pad - gap - ch);
    const left = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), vw - cw - 8);
    card.style.left = left + 'px'; card.style.top = top + 'px';
    card.style.setProperty('--arrow-x', Math.min(Math.max(18, r.left + r.width / 2 - left), cw - 18) + 'px');
    card.dataset.side = below ? 'below' : 'above';
  }
  function endTour() {
    if (!TOUR) return;
    const back = TOUR.back;
    TOUR = null;
    document.removeEventListener('keydown', tourKeys, true);
    window.removeEventListener('resize', tourPlace);
    document.getElementById('tour')?.remove();
    document.body.style.overflow = '';
    if (back && showTab(back) && S.view !== back) { S.view = back; history.replaceState(null, '', '#' + back); render(); }
    if (!S.me.tourDone) { S.me.tourDone = true; api('PATCH', '/me', { tourDone: true }).then((r) => { S.me = r.user; }).catch(() => {}); }
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
      ${pendingBanner()}
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
  function pendingBanner() {
    const polls = pendingPolls(), food = foodPolls().filter((e) => !signedUp(e));
    const n = polls.length + food.length;
    if (!n) return '';
    const names = [...polls.map((p) => p.title), ...food.map((e) => e.title)];
    const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    const what = polls.length && food.length ? 'responses' : polls.length ? (polls.length === 1 ? 'a vote' : 'votes') : (food.length === 1 ? 'a pitch-in sign-up' : 'pitch-in sign-ups');
    return `<button class="pending-banner" data-action="nav" data-view="polls">
      <span class="pb-icon">${I.poll}</span>
      <span class="pb-text"><b>${n === 1 ? '1 poll is' : `${n} polls are`} waiting on you</b><small>${esc(list)} ${n === 1 ? 'needs' : 'need'} ${what}.</small></span>
      <span class="pb-cta">Respond${I.right.replace('<svg', '<svg width="14" height="14"')}</span>
    </button>`;
  }
  function eventRow(e) {
    const meta = [e.location && `<span>${esc(e.location)}</span>`, `<span>by ${esc(e.createdByName)}</span>`].filter(Boolean).join('');
    const cost = fmtCost(e.cost);
    return `<button class="event" style="--c:${colorFor(e.createdBy)}" data-action="open-event" data-id="${esc(e.id)}">
      <span class="bar"></span>
      <span><span class="title">${esc(e.title)}</span><span class="meta">${meta}</span></span>
      <span class="side"><span class="time">${e.time ? esc(fmtWhenTime(e)) : 'All day'}</span><span class="pills">${e.pitchIn ? `<span class="pill purple">Pitch-in${bringCount(e.contributions) ? ' · ' + bringCount(e.contributions) : ''}</span>` : ''}${cost ? `<span class="pill ${e.cost === 0 ? 'green' : ''}">${esc(cost)}</span>` : ''}</span></span>
    </button>`;
  }

  // ---------- Polls ----------
  const POLL_KINDS = { dates: ['Dates', 'Find a date that works'], pitchin: ['Pitch-in', 'Who’s bringing what'], choice: ['Multiple choice', 'Ask the group anything'] };
  const anonPill = (p) => (p.anonymous || p.bringAnon ? `<span class="pill" title="Anonymous responses">${I.eye.replace('<svg', '<svg width="12" height="12"')} Anonymous</span>` : '');
  const topChoice = (p) => { let best = null; for (const o of p.options) if (o.votes.length && (!best || o.votes.length > best.votes.length)) best = o; return best; };
  function renderPolls() {
    const active = S.polls.filter((p) => p.status === 'open'), done = S.polls.filter((p) => p.status !== 'open');
    const n = S.members.length;
    const respPill = (p) => p.status === 'scheduled' ? '<span class="pill blue">Scheduled</span>' : p.status === 'closed' ? '<span class="pill">Closed</span>'
      : p.responded ? `<span class="pill green">${p.type === 'pitchin' ? 'Signed up' : p.type === 'choice' ? 'Answered' : 'Voted'}</span>`
      : `<span class="pill orange">${p.type === 'pitchin' ? 'Sign up' : p.type === 'choice' ? 'Answer' : 'Vote'}</span>`;
    const progress = (p) => `<div><div class="progress" aria-hidden="true"><i style="width:${n ? Math.min(100, Math.round((p.responderCount / n) * 100)) : 0}%"></i></div></div>`;
    const card = (p) => {
      if (p.type === 'choice') {
        const top = topChoice(p), total = p.responderCount;
        return `<button class="poll-card" data-action="open-poll" data-id="${esc(p.id)}">
          <div class="top"><div><h3>${esc(p.title)}</h3><div class="by">${esc(p.createdByName)} · ${p.options.length} answers${p.multi ? ' · pick any' : ''}</div></div>
            <span class="pills">${anonPill(p)}${respPill(p)}</span></div>
          <div class="choice-preview">${p.options.slice(0, 3).map((o) => { const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
            return `<div class="cp-row${o.mine ? ' mine' : ''}"><span class="cp-bar" style="width:${pct}%"></span><span class="cp-text">${esc(o.text)}</span><span class="cp-n">${o.votes.length}</span></div>`; }).join('')}
            ${p.options.length > 3 ? `<div class="small muted">+${p.options.length - 3} more</div>` : ''}</div>
          <div class="foot"><span>${p.responderCount} of ${n} answered</span><span>${top ? `Leading: ${esc(top.text)}` : ''}</span></div>
        </button>`;
      }
      if (p.type === 'pitchin') {
        const flat = (p.contributions || []).flatMap((c) => c.items.map((it) => it.category));
        const cats = BRING_CATS.map((c) => [c, flat.filter((x) => x === c).length]).filter(([, k]) => k);
        return `<button class="poll-card food-card" data-action="open-poll" data-id="${esc(p.id)}">
          <div class="top"><div><h3>${esc(p.title)}</h3><div class="by">Pitch-in · ${esc(p.createdByName)}${p.location ? ' · ' + esc(p.location) : ''}</div></div>
            <span class="pills"><span class="pill purple">Pitch-in</span>${anonPill(p)}${respPill(p)}</span></div>
          <div class="food-cats" style="margin:4px 0">${cats.length ? cats.map(([c, k]) => `<span class="pill">${esc(c)} · ${k}</span>`).join('') : '<span class="small muted">Nobody has signed up yet</span>'}</div>
          <div class="foot"><span>${flat.length} item${flat.length === 1 ? '' : 's'} from ${p.responderCount} ${p.responderCount === 1 ? 'person' : 'people'}</span><span>Not linked to an event</span></div>
        </button>`;
      }
      const best = bestOption(p);
      const chosen = p.options.find((o) => o.id === p.scheduledOptionId);
      const tiles = (chosen ? [chosen] : p.options.slice(0, 5)).map((o) => `<div class="date-tile"><div class="m">${esc(monAbbr(o.date))}</div><div class="d">${parseYmd(o.date).getDate()}</div></div>`).join('');
      return `<button class="poll-card" data-action="open-poll" data-id="${esc(p.id)}">
        <div class="top">
          <div><h3>${esc(p.title)}</h3><div class="by">${esc(p.createdByName)} · ${p.options.length} option${p.options.length > 1 ? 's' : ''}</div></div>
          <span class="pills">${p.pitchIn ? '<span class="pill purple">Pitch-in</span>' : ''}${anonPill(p)}${respPill(p)}</span>
        </div>
        <div class="mini-tiles">${tiles}${!chosen && p.options.length > 5 ? `<span class="more">+${p.options.length - 5}</span>` : ''}</div>
        ${progress(p)}
        <div class="foot">
          <span>${p.responderCount} of ${n} responded</span>
          <span>${chosen ? `${esc(fmtShort(chosen.date))}${chosen.time ? ' · ' + esc(fmtWhenTime(chosen)) : ''}` : best ? `Leading: ${esc(fmtShort(best.date))}` : ''}</span>
        </div>
      </button>`;
    };
    const food = foodPolls();
    const foodCard = (e) => {
      const flat = (e.contributions || []).flatMap((c) => c.items.map((it) => it.category));
      const cats = BRING_CATS.map((c) => [c, flat.filter((x) => x === c).length]).filter(([, k]) => k);
      const people = (e.contributions || []).length;
      return `<button class="poll-card food-card" data-action="open-food" data-id="${esc(e.id)}">
        <div class="top">
          <div><h3>${esc(e.title)}</h3><div class="by">Food sign-up · ${esc(e.createdByName)}</div></div>
          <span class="pills"><span class="pill purple">Pitch-in</span>${anonPill(e)}${signedUp(e) ? '<span class="pill green">Signed up</span>' : '<span class="pill orange">Sign up</span>'}</span>
        </div>
        <div class="food-mid">
          <div class="date-tile"><div class="m">${esc(monAbbr(e.date))}</div><div class="d">${parseYmd(e.date).getDate()}</div></div>
          <div class="food-cats">${cats.length ? cats.map(([c, k]) => `<span class="pill">${esc(c)} · ${k}</span>`).join('') : '<span class="small muted">Nobody has signed up yet</span>'}</div>
        </div>
        <div class="foot">
          <span>${flat.length} item${flat.length === 1 ? '' : 's'} from ${people} ${people === 1 ? 'person' : 'people'}</span>
          <span>${esc(fmtShort(e.date))}${e.time ? ' · ' + esc(fmtWhenTime(e)) : ''}</span>
        </div>
      </button>`;
    };
    const needPolls = active.filter((p) => !p.responded), needFood = food.filter((e) => !signedUp(e));
    const donePolls = active.filter((p) => p.responded), doneFood = food.filter(signedUp);
    const needCount = needPolls.length + needFood.length;
    let html = '';
    if (needCount) html += `<div class="section-title need-title" style="margin-top:4px">Needs your response <span class="badge-inline">${needCount}</span></div>
      <div class="poll-grid">${needPolls.map(card).join('')}${needFood.map(foodCard).join('')}</div>`;
    else if (active.length || food.length) html += `<div class="all-caught-up">${I.check.replace('<svg', '<svg width="18" height="18"')} You’re all caught up — nothing needs your response.</div>`;
    if (donePolls.length) html += `<div class="section-title"${needCount ? '' : ' style="margin-top:4px"'}>Open polls</div><div class="poll-grid">${donePolls.map(card).join('')}</div>`;
    if (doneFood.length) html += `<div class="section-title">Pitch-in sign-ups</div><div class="poll-grid">${doneFood.map(foodCard).join('')}</div>`;
    if (!active.length && !food.length) html += `
      <div class="empty">${I.poll}<div>No open polls.</div><div class="small" style="margin-top:4px">Find a date, plan a pitch-in, or ask the group a question.</div>
        <button class="btn sm tinted" data-action="new-poll">${I.plus.replace('<svg', '<svg width="15" height="15"')} New Poll</button></div>`;
    return `
      <div class="title-row">
        <div><h1 class="large-title">Polls</h1><div class="sub">Pick dates, plan pitch-ins and ask the group.</div></div>
        <button class="btn sm" data-action="new-poll">${I.plus.replace('<svg', '<svg width="16" height="16"')} New Poll</button>
      </div>
      ${html}
      ${done.length ? `<div class="section-title">Finished</div><div class="poll-grid">${done.map(card).join('')}</div>` : ''}`;
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
        ${!feat('members') ? `<div class="notice card">${I.info}<div><b>Hidden from members.</b> The Members tab is turned off for this group, so only organizers see it. Turn it back on in Group Info › Features.</div></div>` : ''}
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
          ${S.members.map((m) => `<button class="person person-btn" data-action="member-actions" data-id="${esc(m.id)}" aria-label="${esc(m.name)} — contact info">
            ${avatar(m.id, m.name)}
            <span class="nm">${esc(m.name)}${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}
              <small>${esc([m.phone && fmtPhone(m.phone), m.email].filter(Boolean).join(' · '))}</small></span>
            ${m.role === 'organizer' ? '<span class="pill blue">Organizer</span>' : ''}
            <span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span>
          </button>`).join('')}
        </div>
        <p class="group-foot">Tap someone to email, call or text them. Members of a group can see each other\u2019s email and mobile number.${org ? ' As an organizer, you can also make someone an organizer or remove them there.' : ''}</p>
      </div>`;
  }

  // ---------- Prayer requests ----------
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'Just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return fmtStamp(iso);
  };
  function renderPrayer() {
    const list = S.prayers || [];
    return `
      <div class="title-row">
        <div><h1 class="large-title">Prayer</h1><div class="sub">Share requests and updates with the group.</div></div>
        <button class="btn sm" data-action="new-prayer">${I.plus.replace('<svg', '<svg width="16" height="16"')} New Request</button>
      </div>
      <div style="max-width:720px">
      ${list.length ? `<div class="prayer-list">${list.map((p) => {
        const n = p.comments.length, last = p.comments[n - 1];
        return `<button class="card prayer-card" data-action="open-prayer" data-id="${esc(p.id)}">
          <div class="pc-head">${avatar(p.createdBy, p.createdByName)}<div class="pc-who"><b>${esc(p.createdByName)}</b><small>${esc(ago(p.createdAt))}${p.updatedAt ? ' · Edited' : ''}</small></div></div>
          <h3>${esc(p.title)}</h3>
          ${p.description ? `<p class="pc-desc">${esc(p.description)}</p>` : ''}
          <div class="pc-foot">${I.message.replace('<svg', '<svg width="14" height="14"')}<span>${n ? `${n} ${n === 1 ? 'comment' : 'comments'} · Latest from ${esc(last.name)} ${esc(ago(last.at))}` : 'No comments yet'}</span></div>
        </button>`;
      }).join('')}</div>`
      : `<div class="empty">${I.pray}<div>No prayer requests yet.</div><div class="small" style="margin-top:4px">Share what you’d like the group to pray for.</div>
          <button class="btn sm" style="margin-top:14px" data-action="new-prayer">New Request</button></div>`}
      </div>`;
  }
  function prayerComment(p, c) {
    const mine = c.userId === S.me.id, editing = S.sheet?.editComment === c.id;
    const isUpdate = c.userId === p.createdBy;
    return `<div class="comment${isUpdate ? ' is-update' : ''}" data-cid="${esc(c.id)}">
      ${avatar(c.userId, c.name)}
      <div class="cm-body">
        <div class="cm-meta"><b>${esc(c.name)}${mine ? ' <span class="muted">(you)</span>' : ''}</b>${isUpdate ? '<span class="pill blue">Update</span>' : ''}<small>${esc(ago(c.at))}${c.editedAt ? ' · Edited' : ''}</small></div>
        ${editing ? `<form class="comment-edit" data-pid="${esc(p.id)}" data-cid="${esc(c.id)}"><textarea name="text" maxlength="2000" aria-label="Edit comment">${esc(c.text)}</textarea>
            <div class="cm-actions"><button type="button" class="link-btn" data-action="cancel-edit-comment">Cancel</button><button type="submit" class="btn sm">Save</button></div></form>`
          : `<div class="cm-text">${esc(c.text)}</div>
            ${canModify(c.userId) ? `<div class="cm-actions"><button class="link-btn" data-action="edit-comment" data-cid="${esc(c.id)}">Edit</button><button class="link-btn danger" data-action="delete-comment" data-pid="${esc(p.id)}" data-cid="${esc(c.id)}">Delete</button></div>` : ''}`}
      </div></div>`;
  }

  // ---------- Meal trains ----------
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const trainUpcoming = (t) => t.dates.filter((d) => d >= todayStr());
  const trainCovered = (t, dates) => dates.filter((d) => t.slots.some((s) => s.date === d)).length;
  const trainRange = (t) => `${fmtShort(t.start)} – ${fmtShort(t.end)}`;
  const trainDrop = (t, date) => !t.dropStart ? '' : `${fmtWhenTime({ date, time: t.dropStart, tz: t.tz })}${t.dropEnd ? ' – ' + fmtWhenTime({ date, time: t.dropEnd, tz: t.tz }) : ''}`;
  function renderMeals() {
    const list = S.trains || [];
    const card = (t) => {
      const up = trainUpcoming(t), cov = trainCovered(t, up), mine = t.slots.filter((s) => s.mine && s.date >= todayStr());
      return `<button class="card train-card" data-action="open-train" data-id="${esc(t.id)}">
        <h3>${esc(t.title)}</h3>
        <div class="sub">${esc(trainRange(t))}${t.status === 'closed' ? ' · Sign-ups closed' : ''}</div>
        ${up.length ? `<div class="progress" aria-hidden="true"><i style="width:${Math.round((cov / up.length) * 100)}%"></i></div>
        <div class="foot"><span>${cov} of ${up.length} meals covered</span><span>${mine.length ? `You: ${esc(fmtShort(mine[0].date))}` : up.length - cov ? `${up.length - cov} open` : 'All covered'}</span></div>`
        : '<div class="foot" style="margin-top:8px"><span>Finished</span></div>'}
      </button>`;
    };
    const active = list.filter((t) => trainUpcoming(t).length), done = list.filter((t) => !trainUpcoming(t).length);
    return `
      <div class="title-row">
        <div><h1 class="large-title">Meals</h1><div class="sub">Meal trains for families who need a hand.</div></div>
        <button class="btn sm" data-action="new-train">${I.plus.replace('<svg', '<svg width="16" height="16"')} New Meal Train</button>
      </div>
      <div style="max-width:720px">
        ${active.length ? `<div class="train-list">${active.map(card).join('')}</div>`
          : `<div class="empty">${I.meal}<div>No meal trains right now.</div><div class="small" style="margin-top:4px">Start one when someone has a baby, surgery or a hard season. Share the link with anyone.</div>
              <button class="btn sm" style="margin-top:14px" data-action="new-train">New Meal Train</button></div>`}
        ${done.length ? `<h2 class="section-title" style="margin-top:28px">Finished</h2><div class="train-list">${done.map(card).join('')}</div>` : ''}
      </div>`;
  }
  async function shareTrain(t) {
    const text = `Help bring meals to ${t.recipient}! Pick a day here:`;
    if (navigator.share) { try { await navigator.share({ title: t.title, text, url: t.publicUrl }); return; } catch (ex) { if (ex?.name === 'AbortError') return; } }
    toast((await copyText(`${text} ${t.publicUrl}`)) ? 'Link copied — paste it in a text, email or post' : 'Couldn\u2019t copy the link');
  }

  // ---------- Discussions (forum layout) ----------
  const firstOf = (n) => String(n || '').split(' ')[0];
  const lastPoster = (t) => t.commentCount ? (S.members.find((m) => m.id === (t.lastCommentBy || t.lastBy))?.name || t.lastByName || 'Someone') : t.createdByName;
  function renderTopics() {
    if (S.topicOpen) return renderThread();
    const list = S.topics || [];
    const unread = list.filter((t) => t.unread).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    const rest = list.filter((t) => !t.unread); // newest first
    const row = (t) => {
      const lp = lastPoster(t), lpId = t.commentCount ? (t.lastCommentBy || t.lastBy) : t.createdBy;
      return `<a class="forum-row${t.unread ? ' unread' : ''}" href="#topics/${esc(t.id)}" data-action="open-topic" data-id="${esc(t.id)}">
        <span class="fr-icon" aria-hidden="true">${t.unread ? '<span class="unread-dot"></span>' : I.chat.replace('<svg', '<svg width="18" height="18"')}</span>
        <span class="fr-main">
          <span class="fr-title">${esc(t.title)}</span>
          <span class="fr-meta">Started by ${esc(t.createdByName)} · ${esc(new Date(t.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))}<span class="fr-mobile"> · ${t.commentCount} ${t.commentCount === 1 ? 'reply' : 'replies'} · ${t.commentCount ? `last by ${esc(firstOf(lp))} ` : ''}${esc(ago(t.lastActivity))}</span></span>
        </span>
        <span class="fr-count"><b>${t.commentCount}</b><small>${t.commentCount === 1 ? 'reply' : 'replies'}</small></span>
        <span class="fr-last">${avatar(lpId, lp, 'xs')}<span><b>${esc(lp)}</b><small>${esc(ago(t.lastActivity))}</small></span></span>
      </a>`;
    };
    const section = (label, items, badge) => `<div class="forum-section">${esc(label)}${badge ? ` <span class="badge-inline">${items.length}</span>` : ''}</div>${items.map(row).join('')}`;
    return `
      <div class="title-row">
        <div><h1 class="large-title">Discussions</h1><div class="sub">${list.length ? `${list.length} topic${list.length === 1 ? '' : 's'}${unread.length ? ` · ${unread.length} unread` : ''}` : 'Talk things through together.'}</div></div>
        <button class="btn sm" data-action="new-topic">${I.plus.replace('<svg', '<svg width="16" height="16"')} New Topic</button>
      </div>
      ${list.length ? `<div class="forum card" role="list">
        <div class="forum-head" aria-hidden="true"><span></span><span>Topic</span><span class="fr-count">Replies</span><span class="fr-last">Last post</span></div>
        ${unread.length ? section('Unread', unread, true) : ''}
        ${rest.length ? section(unread.length ? 'All topics' : 'Topics', rest) : ''}
      </div>` : `<div class="empty">${I.chat}<div>No discussions yet.</div><div class="small" style="margin-top:4px">Start a topic — a question, an idea, or something from this week’s study.</div>
          <button class="btn sm" style="margin-top:14px" data-action="new-topic">New Topic</button></div>`}`;
  }
  function renderThread() {
    const t = (S.topicDetail || {})[S.topicOpen] || (S.topics || []).find((x) => x.id === S.topicOpen);
    if (!t) return `<div class="empty">This topic was deleted.<div style="margin-top:12px"><button class="btn sm tinted" data-action="topics-back">Back to Discussions</button></div></div>`;
    const loading = !t.comments, n = t.comments?.length ?? t.commentCount ?? 0;
    const post = (num, userId, name, at, edited, text, actions, id) => `
      <article class="post${userId === t.createdBy ? ' op' : ''}" id="post-${num}">
        <header class="post-head">${avatar(userId, name)}
          <span class="ph-who"><b>${esc(name)}${userId === S.me.id ? ' <span class="muted">(you)</span>' : ''}</b>${num === 1 ? '<span class="pill blue">Original post</span>' : userId === t.createdBy ? '<span class="pill">Topic starter</span>' : ''}</span>
          <span class="ph-when"><time title="${esc(fmtStamp(at))}">${esc(ago(at))}</time>${edited ? ' · edited' : ''} <a class="post-num" href="#post-${num}">#${num}</a></span>
        </header>
        ${id && S.editPost === id ? `<form class="tc-edit" data-tid="${esc(t.id)}" data-cid="${esc(id)}"><textarea name="text" maxlength="4000" aria-label="Edit reply">${esc(text)}</textarea>
            <div class="cm-actions"><button type="button" class="link-btn" data-action="cancel-tpost">Cancel</button><button type="submit" class="btn sm">Save</button></div></form>`
          : `<div class="post-body">${text ? esc(text) : '<span class="muted">No details.</span>'}</div>${actions ? `<footer class="post-actions">${actions}</footer>` : ''}`}
      </article>`;
    const opActions = canModify(t.createdBy) ? `<button class="link-btn" data-action="edit-topic" data-id="${esc(t.id)}">Edit</button><button class="link-btn danger" data-action="delete-topic" data-id="${esc(t.id)}">Delete topic</button>` : '';
    return `
      <nav class="thread-nav"><button class="link-btn back-link" data-action="topics-back">${I.left.replace('<svg', '<svg width="16" height="16"')} Discussions</button></nav>
      <div class="thread">
        <h1 class="thread-title">${esc(t.title)}</h1>
        <div class="thread-meta">Started by ${esc(t.createdByName)} · ${esc(fmtStamp(t.createdAt))} · ${n} ${n === 1 ? 'reply' : 'replies'}</div>
        <div class="posts">
          ${post(1, t.createdBy, t.createdByName, t.createdAt, !!t.updatedAt, t.body, opActions)}
          ${loading ? '<div class="spinner" style="margin:24px auto"></div>' : t.comments.map((c, i) => post(i + 2, c.userId, c.name, c.at, !!c.editedAt, c.text,
            canModify(c.userId) ? `<button class="link-btn" data-action="edit-tpost" data-cid="${esc(c.id)}">Edit</button><button class="link-btn danger" data-action="delete-tcomment" data-tid="${esc(t.id)}" data-cid="${esc(c.id)}">Delete</button>` : '', c.id)).join('')}
        </div>
        <form class="tc-form post-reply card" data-tid="${esc(t.id)}">
          <div class="pr-head">${avatar(S.me.id, S.me.name, 'xs')}<b>Reply as ${esc(firstOf(S.me.name))}</b></div>
          <textarea name="text" maxlength="4000" placeholder="Write a reply…" aria-label="Write a reply"></textarea>
          <div class="pr-actions"><button type="submit" class="btn sm">Post Reply</button></div>
        </form>
      </div>`;
  }
  async function openTopic(id, opts = {}) {
    const t = (S.topics || []).find((x) => x.id === id);
    if (t) t.unread = false;
    S.topicDetail = S.topicDetail || {};
    if (!S.topicDetail[id] && t) S.topicDetail[id] = { ...t, comments: null };
    S.view = 'topics'; S.topicOpen = id; S.editPost = null;
    history.replaceState(null, '', '#topics/' + id);
    render(); if (!opts.keepScroll) window.scrollTo({ top: 0 });
    try {
      const r = await api('GET', gp(`/topics/${id}`));
      S.topicDetail[id] = r.topic;
      if (S.topicOpen === id && !threadBusy()) render();
    } catch (ex) { toast(ex.message); }
  }
  // Don't redraw a thread while someone is typing a reply or editing a post
  const threadBusy = () => !!S.editPost || !!document.querySelector('.tc-form textarea')?.value.trim() || !!document.activeElement?.closest?.('.tc-form, .tc-edit');
  function closeTopic() { S.topicOpen = null; S.editPost = null; history.replaceState(null, '', '#topics'); render(); window.scrollTo({ top: 0 }); }
  function upsertTopic(t) {
    S.topicDetail = S.topicDetail || {}; S.topicDetail[t.id] = t;
    S.topics = S.topics || [];
    const summary = { ...t, comments: undefined, unread: false, lastByName: S.members.find((m) => m.id === t.lastBy)?.name || '' };
    const i = S.topics.findIndex((x) => x.id === t.id);
    if (i >= 0) S.topics[i] = summary; else S.topics.unshift(summary);
  }

  // ---------- Onboarding (no groups yet) ----------
  function renderOnboarding() {
    closeSheet(true);
    const mode = S.onboard || 'join';
    $app.innerHTML = `
      <main class="auth-wrap">
        <div class="auth-card">
          <div class="app-icon"><img src="/icon.svg?v=2" alt=""></div>
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
    S.loaded = false; S.events = []; S.polls = []; S.members = []; S.trains = []; S.prayers = []; S.topics = []; S.topicDetail = {}; S.topicOpen = null;
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
    const first = $sheetRoot.querySelector('form:not(.bring-form):not(.comment-form):not(.comment-edit) input:not([type=date]):not([type=time]):not([type=checkbox])');
    if (first && matchMedia('(min-width: 761px)').matches) setTimeout(() => { if (!$sheetRoot.contains(document.activeElement) || document.activeElement === document.body) first.focus(); }, 60);
    const form = $sheetRoot.querySelector('form:not(.bring-form):not(.comment-form):not(.comment-edit)');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); onSheetSave(); });
    if (form && kind === 'group-new') wireCodeSuggest(form);
  }
  function refreshSheet() {
    const sheet = $sheetRoot.querySelector('.sheet');
    if (!sheet || !S.sheet || ['event-form', 'poll-form', 'group-new', 'group-join', 'group-edit', 'profile', 'prayer-form', 'meal-form', 'meal-signup', 'topic-form'].includes(S.sheet.kind)) return;
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
    if (S.view === 'prayer' && /^#prayer\/./.test(location.hash)) history.replaceState(null, '', '#prayer');
    if (S.view === 'meals' && /^#meals\/./.test(location.hash)) history.replaceState(null, '', '#meals');

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
            <div class="row"><label for="ev-tz">Time zone</label>${tzSelect('tz', e.tz).replace('<select', '<select id="ev-tz"')}</div>
            <div class="row"><label for="ev-cost">Cost</label><span class="prefix">$</span><input id="ev-cost" name="cost" inputmode="decimal" placeholder="0.00 (leave blank if none)" value="${e.cost ?? ''}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description — what to bring, who's hosting, anything people should know" maxlength="4000" aria-label="Description">${esc(e.description)}</textarea></div>
          </div>
          <div class="group" style="margin-top:22px">
            <div class="row"><span>Pitch-in<small class="row-sub">Let people sign up for what they\u2019re bringing</small></span><label class="switch"><input type="checkbox" name="pitchIn" ${e.pitchIn ? 'checked' : ''}><span></span></label></div>
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
            <div class="w">${esc(fmtLongY(e.date))}${e.time ? ' · ' + esc(fmtWhenTime(e)) : ' · All day'}</div>
            ${localEquivalent(e) ? `<div class="w tz-note">${esc(localEquivalent(e))}</div>` : ''}
          </div>
          ${kv.length ? `<div class="group kv">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
          ${e.description ? `<div class="group-label" style="margin-top:22px">Details</div><div class="group"><div class="detail-desc">${esc(e.description)}</div></div>` : ''}
          ${e.pitchIn ? bringSection('event', e, true) : ''}
          <div class="actions">
            <button class="btn tinted block" data-action="ics" data-id="${esc(e.id)}">Add to My Calendar</button>
            ${canModify(e.createdBy) ? `<button class="btn tinted block" data-action="edit-event" data-id="${esc(e.id)}">Edit Event</button>
              <button class="btn danger block" data-action="delete-event" data-id="${esc(e.id)}">Delete Event</button>` : ''}
          </div>
        </div>`;
    }
    if (s.kind === 'poll-form') {
      const p = s.id ? S.polls.find((x) => x.id === s.id) : null;
      const type = p ? p.type : (s.type || 'dates'), dr = s.draft || {};
      const d = p || { title: dr.title || '', location: dr.location || '', cost: null, description: dr.description || '', anonymous: !!dr.anonymous,
        options: type === 'choice' ? [{ text: '' }, { text: '' }] : [{ date: '', time: '' }, { date: '', time: '' }] };
      const anonRow = `<div class="group" style="margin-top:22px">
          <div class="row"><span>Anonymous responses<small class="row-sub">${type === 'pitchin' ? 'Everyone sees what’s coming, but not who’s bringing it' : 'Everyone sees totals, but not who answered what'}</small></span>
            <label class="switch"><input type="checkbox" name="anonymous" ${d.anonymous ? 'checked disabled' : ''}><span></span></label></div>
        </div>${p?.anonymous ? '<p class="group-foot">Responses were collected anonymously, so this can’t be turned off.</p>' : ''}`;
      const typePicker = p ? '' : `<div class="segmented poll-type" role="tablist" aria-label="Poll type">
          <span class="thumb" style="width:calc(33.333% - 1.33px);transform:translateX(${['dates', 'pitchin', 'choice'].indexOf(type) * 100}%)"></span>
          ${Object.entries(POLL_KINDS).map(([k, [label]]) => `<button type="button" role="tab" aria-selected="${type === k}" data-action="poll-type" data-type="${k}">${label}</button>`).join('')}
        </div><p class="group-foot poll-type-hint">${POLL_KINDS[type][1]}</p>`;
      let body;
      if (type === 'choice') {
        body = `<div class="group">
            <div class="row"><input name="title" placeholder="Ask a question" maxlength="160" value="${esc(d.title)}" aria-label="Question" required></div>
            <div class="row stack"><textarea name="description" placeholder="More details (optional)" maxlength="4000" aria-label="Details">${esc(d.description)}</textarea></div>
          </div>
          <div class="group-label" style="margin-top:22px">Answers</div>
          <div class="group" id="opt-list">
            ${d.options.map((o) => choiceRow(o, d.options.length > 2)).join('')}
            <div class="row button-row" data-action="add-choice" role="button" tabindex="0">${I.plus.replace('<svg', '<svg width="18" height="18"')} Add an answer</div>
          </div>
          ${p ? '<p class="group-foot">Adding answers keeps everyone’s votes. Rewording an answer clears the votes for that answer only.</p>' : ''}
          <div class="group" style="margin-top:22px">
            <div class="row"><span>Allow more than one answer</span><label class="switch"><input type="checkbox" name="multi" ${d.multi ? 'checked' : ''}><span></span></label></div>
          </div>`;
      } else if (type === 'pitchin') {
        const evs = S.events.filter((e) => e.date >= todayStr()).slice(0, 40);
        body = `<div class="group">
            <div class="row"><input name="title" placeholder="What’s the pitch-in for?" maxlength="160" value="${esc(d.title)}" aria-label="Title" required></div>
            <div class="row"><input name="location" placeholder="Location (optional)" maxlength="200" value="${esc(d.location || '')}" aria-label="Location"></div>
            <div class="row stack"><textarea name="description" placeholder="Details — what’s needed, how many people (optional)" maxlength="4000" aria-label="Details">${esc(d.description)}</textarea></div>
          </div>
          ${p ? '' : `<div class="group-label" style="margin-top:22px">Calendar event</div>
          <div class="group"><div class="row"><label for="pi-ev">Link to</label><select id="pi-ev" name="eventId" class="tz-select ev-select">
            <option value="">No event (sign-up only)</option>
            ${evs.map((e) => `<option value="${esc(e.id)}"${dr.eventId === e.id ? ' selected' : ''}>${esc(fmtShort(e.date))} · ${esc(e.title)}${e.pitchIn ? ' (pitch-in)' : ''}</option>`).join('')}
          </select></div></div>
          <p class="group-foot">Pick the event this food is for and the sign-up goes right on that event, so everything is in one place. You can also link it later.</p>`}`;
      } else {
        const opts = d.options.map((o) => ({ id: o.id || '', date: o.date, time: o.time, tz: o.tz }));
        body = `<div class="group">
            <div class="row"><input name="title" placeholder="What are we planning?" maxlength="160" value="${esc(d.title)}" aria-label="Title" required></div>
            <div class="row"><input name="location" placeholder="Location" maxlength="200" value="${esc(d.location || '')}" aria-label="Location"></div>
            <div class="row"><label for="p-cost">Cost</label><span class="prefix">$</span><input id="p-cost" name="cost" inputmode="decimal" placeholder="0.00 (optional)" value="${esc(d.cost ?? '')}"></div>
          </div>
          <div class="group">
            <div class="row stack"><textarea name="description" placeholder="Description (optional)" maxlength="4000" aria-label="Description">${esc(d.description)}</textarea></div>
          </div>
          <div class="group" style="margin-top:22px">
            <div class="row"><span>Pitch-in<small class="row-sub">Let people sign up for what they’re bringing</small></span><label class="switch"><input type="checkbox" name="pitchIn" ${d.pitchIn ? 'checked' : ''}><span></span></label></div>
          </div>
          <div class="group-label" style="margin-top:22px">Date options</div>
          <div class="group" id="opt-list">
            ${opts.map((o) => optRow(o, opts.length > 2)).join('')}
            <div class="row button-row" data-action="add-opt" role="button" tabindex="0">${I.plus.replace('<svg', '<svg width="18" height="18"')} Add another date</div>
          </div>
          <p class="group-foot">${p
            ? 'Adding dates keeps everyone’s responses. Changing the date or time of an option clears the responses for that option only, since people answered for a different time. Removing an option removes its responses.'
            : 'Add at least two dates. Members mark each one Yes, Maybe, or No. When you pick the final date, it goes on the calendar and everyone gets an email.'}</p>`;
      }
      const verb = p ? 'Save' : type === 'pitchin' ? 'Create' : 'Create';
      return `<form autocomplete="off" novalidate>${head(p ? 'Edit Poll' : 'New Poll', 'Cancel', verb)}
        <div class="sheet-body">${typePicker}${body}${anonRow}<div id="sheet-msg"></div></div></form>`;
    }
    if (s.kind === 'poll-link') {
      const p = S.polls.find((x) => x.id === s.id);
      if (!p) return '';
      const evs = S.events.filter((e) => e.date >= todayStr());
      return `${head('Link to Event', 'Cancel')}
        <div class="sheet-body">
          <p class="group-foot" style="margin-top:0">Everyone’s sign-ups for “${esc(p.title)}” will move onto the event you pick, and this sign-up will be removed from Polls.</p>
          <div class="group people">${evs.length ? evs.map((e) => `<button class="person person-btn" data-action="link-event" data-poll="${esc(p.id)}" data-event="${esc(e.id)}">
              <div class="date-tile" style="width:40px"><div class="m">${esc(monAbbr(e.date))}</div><div class="d">${parseYmd(e.date).getDate()}</div></div>
              <span class="nm">${esc(e.title)}<small>${esc(fmtShort(e.date))}${e.time ? ' · ' + esc(fmtWhenTime(e)) : ''}${e.pitchIn ? ' · already a pitch-in' : ''}</small></span>
              <span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></button>`).join('')
            : '<div class="person"><div class="nm muted">No upcoming events. Add the event to the calendar first.</div></div>'}</div>
        </div>`;
    }
    if (s.kind === 'poll') {
      const p = S.polls.find((x) => x.id === s.id);
      if (!p) return '';
      if (p.type === 'choice' || p.type === 'pitchin') return otherPollSheet(p);
      const open = p.status === 'open', owner = canModify(p.createdBy);
      const best = open ? bestOption(p) : null;
      const chosen = p.options.find((o) => o.id === p.scheduledOptionId);
      const respondedIds = new Set(p.responders.map((r) => r.userId));
      const waiting = p.anonymous ? [] : S.members.filter((m) => !respondedIds.has(m.id));
      const kv = [['Location', p.location], ['Cost', fmtCost(p.cost)], ['Created', fmtStamp(p.createdAt)]].filter(([, v]) => v);
      const optHtml = p.options.map((o) => {
        const mine = o.mine || null;
        const by = (a) => o.votes.filter((v) => v.answer === a);
        const yes = by('yes'), maybe = by('maybe'), no = by('no');
        const cls = ['option', best && best.id === o.id && 'best', chosen && chosen.id === o.id && 'chosen', chosen && chosen.id !== o.id && 'dim'].filter(Boolean).join(' ');
        const btn = (a, label, icon) => `<button class="${a}" aria-pressed="${mine === a}" data-action="vote" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}" data-ans="${a}" ${open ? '' : 'disabled'}>${icon}${label}</button>`;
        return `<div class="${cls}">
          <div class="head">
            <div class="date-tile"><div class="m">${esc(monAbbr(o.date))}</div><div class="d">${parseYmd(o.date).getDate()}</div></div>
            <div class="when"><b>${esc(parseYmd(o.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</b><span>${o.time ? esc(fmtWhenTime(o)) : 'Time TBD'}${localEquivalent(o) ? `<small class="tz-note">${esc(localEquivalent(o))}</small>` : ''}</span></div>
            <div class="tally">
              ${chosen && chosen.id === o.id ? '<span class="pill blue">Scheduled</span>' : best && best.id === o.id ? '<span class="pill green">Most popular</span>' : ''}
              ${p.anonymous ? '' : `<span class="avatar-stack">${yes.slice(0, 4).map((v) => avatar(v.userId, v.name, 'xs')).join('')}</span>`}
            </div>
          </div>
          ${open ? `<div class="choice" role="group" aria-label="Your answer">${btn('yes', 'Yes', I.check)}${btn('maybe', 'Maybe', I.q)}${btn('no', 'No', I.x)}</div>` : ''}
          ${o.votes.length ? `<div class="who">
            ${yes.length ? `<div><span class="k yes">Yes ${yes.length}</span><span class="v">${p.anonymous ? '' : yes.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
            ${maybe.length ? `<div><span class="k maybe">Maybe ${maybe.length}</span><span class="v">${p.anonymous ? '' : maybe.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
            ${no.length ? `<div><span class="k no">No ${no.length}</span><span class="v">${p.anonymous ? '' : no.map((v) => esc(v.name)).join(', ')}</span></div>` : ''}
          </div>` : '<div class="small muted">No responses yet.</div>'}
          ${open && owner ? `<button class="btn sm tinted" style="justify-self:start" data-action="schedule" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}">${I.cal.replace('<svg', '<svg width="16" height="16"')} Schedule this date</button>` : ''}
        </div>`;
      }).join('');
      return `${head('Poll', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero" style="padding-bottom:16px">
            <h2>${esc(p.title)}</h2>
            <div class="w">Date poll · Started by ${esc(p.createdByName)}</div>
            ${p.anonymous ? `<div class="anon-note">${I.eye.replace('<svg', '<svg width="14" height="14"')} Anonymous \u2014 only totals are shown</div>` : ''}
          </div>
          ${chosen ? `<div class="group" style="margin-bottom:22px"><div class="row button-row" data-action="goto-date" data-date="${chosen.date}">${I.check.replace('<svg', '<svg width="18" height="18"')} On the calendar · ${esc(fmtShort(chosen.date))}${chosen.time ? ' · ' + esc(fmtWhenTime(chosen)) : ''}<span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div></div>` : ''}
          ${kv.length ? `<div class="group kv">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
          ${p.description ? `<div class="group" style="margin-top:22px"><div class="detail-desc">${esc(p.description)}</div></div>` : ''}
          <div class="group-label" style="margin-top:26px">${open ? 'Mark which dates work for you' : 'Results'}</div>
          <div class="options">${optHtml}</div>
          ${p.pitchIn ? bringSection('poll', p, open) : ''}
          ${responsesBlock(p)}
          ${p.anonymous ? '' : `<div class="group-label" style="margin-top:26px">Responses · ${p.responders.length} of ${S.members.length}</div>
          <div class="group people">
            ${p.responders.length ? p.responders.map((r) => `<div class="person">${avatar(r.userId, r.name)}<div class="nm">${esc(r.name)}${r.userId === S.me.id ? ' <span class="muted">(you)</span>' : ''}<small>Responded ${esc(fmtStamp(r.at))}</small></div><span class="pill green">Replied</span></div>`).join('') : '<div class="person"><div class="nm muted">No one has replied yet.</div></div>'}
          </div>`}
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
            <div class="row button-row" data-action="group-notifications" role="button" tabindex="0">Notifications<span class="v muted" style="margin-left:auto;margin-right:6px">${(() => { const n = Object.values(g.notifications || {}).filter(Boolean).length, t = Object.keys(g.notifications || {}).length; return n === 0 ? 'Off' : n === t ? 'All on' : `${n} of ${t} on`; })()}</span><span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div>
            <div class="row button-row" data-action="group-features" role="button" tabindex="0">Features<span class="v muted" style="margin-left:auto;margin-right:6px">${[g.features?.members !== false && 'Members', g.features?.prayer && 'Prayer'].filter(Boolean).join(', ') || 'None'}</span><span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div>
            <div class="row"><span>Email delivery</span><span class="v" id="email-status">Checking…</span></div>
          </div>` : ''}
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="leave-group" role="button" tabindex="0">Leave Group</div></div>
        </div>`;
    }
    if (s.kind === 'group-features') {
      const g = curGroup(), f = g.features || {};
      const sw = (k, title, sub) => `<div class="row"><span>${title}<small class="row-sub">${sub}</small></span><label class="switch"><input type="checkbox" data-action="toggle-feature" data-feature="${k}" ${f[k] ? 'checked' : ''}><span></span></label></div>`;
      return `${head('Features', 'Done')}
        <div class="sheet-body">
          <div class="group">
            ${sw('members', 'Members Tab', 'Everyone can see the member list and contact info')}
            ${sw('prayer', 'Prayer Requests', 'Members share requests and post comments and updates')}
            ${sw('meals', 'Meal Trains', 'Organize meals for a family, with a sign-up link anyone can use')}
            ${sw('topics', 'Discussions', 'Start topics and talk them through with comments')}
          </div>
          <p class="group-foot">Changes apply to everyone in ${esc(g.name)} right away. When the Members tab is off, organizers still see it and member contact info is hidden from everyone else. Turning off Prayer Requests hides them but keeps them, so they come back if you turn it on again.</p>
        </div>`;
    }
    if (s.kind === 'group-notifications') {
      const g = curGroup(), n = g.notifications || {};
      const sw = (k, title, sub) => `<div class="row"><span>${title}<small class="row-sub">${sub}</small></span><label class="switch"><input type="checkbox" data-action="toggle-notification" data-key="${k}" ${n[k] ? 'checked' : ''}><span></span></label></div>`;
      const prayerOff = !(g.features || {}).prayer;
      return `${head('Notifications', 'Done')}
        <div class="sheet-body">
          <div class="group-label">Calendar</div>
          <div class="group">
            ${sw('event', 'New events', 'When someone adds an event to the calendar')}
            ${sw('scheduled', 'Poll results', 'When an organizer schedules the final date from a poll')}
          </div>
          <div class="group-label" style="margin-top:22px">Polls</div>
          <div class="group">${sw('poll', 'New polls', 'Asks everyone to vote on dates')}</div>
          <div class="group-label" style="margin-top:22px">Prayer Requests</div>
          <div class="group">
            ${sw('prayer', 'New requests', 'When someone shares a prayer request')}
            ${sw('prayerComment', 'Comments &amp; updates', 'Every new comment or update on a request')}
          </div>
          <div class="group-label" style="margin-top:22px">Meal Trains</div>
          <div class="group">${sw('meal', 'New meal trains', 'When someone starts a meal train')}</div>
          <div class="group-label" style="margin-top:22px">Discussions</div>
          <div class="group">
            ${sw('topic', 'New topics', 'When someone starts a discussion')}
            ${sw('topicComment', 'Replies', 'Every new comment on a topic')}
          </div>
          ${prayerOff ? '<p class="group-foot">Prayer Requests is turned off for this group, so these won\u2019t send until you turn it on in Features.</p>' : ''}
          <p class="group-foot">These control which emails go to everyone in ${esc(g.name)}. Each person can also choose which of these they get from their own profile. Password reset emails always send.</p>
        </div>`;
    }
    if (s.kind === 'prayer-form') {
      const p = s.id ? (S.prayers || []).find((x) => x.id === s.id) : { title: '', description: '' };
      if (!p) return '';
      return `<form autocomplete="off">${head(s.id ? 'Edit Request' : 'New Request', 'Cancel', s.id ? 'Save' : 'Share')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="title" placeholder="Title" maxlength="120" value="${esc(p.title)}" aria-label="Title" required></div>
            <div class="row stack"><textarea name="description" placeholder="What would you like prayer for?" maxlength="4000" aria-label="Description">${esc(p.description)}</textarea></div>
          </div>
          <p class="group-foot">Everyone in ${esc(curGroup().name)} can see this and add comments.${s.id ? '' : (() => { const n = curGroup().notifications || {}; return n.prayer ? ` The group will get an email about it${n.prayerComment ? ', and about new comments and updates' : '; comments and updates don\u2019t send emails'}.` : ''; })()}</p>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'prayer') {
      const p = (S.prayers || []).find((x) => x.id === s.id);
      if (!p) return '';
      return `${head('Prayer Request', 'Done')}
        <div class="sheet-body">
          <div class="prayer-detail">
            <div class="pc-head">${avatar(p.createdBy, p.createdByName)}<div class="pc-who"><b>${esc(p.createdByName)}${p.createdBy === S.me.id ? ' <span class="muted">(you)</span>' : ''}</b><small>${esc(fmtStamp(p.createdAt))}${p.updatedAt ? ' · Edited' : ''}</small></div></div>
            <h2>${esc(p.title)}</h2>
            ${p.description ? `<div class="detail-desc" style="padding:0">${esc(p.description)}</div>` : ''}
          </div>
          <div class="group-label" style="margin-top:22px">Comments &amp; Updates${p.comments.length ? ' · ' + p.comments.length : ''}</div>
          <div class="group comments">
            ${p.comments.length ? p.comments.map((c) => prayerComment(p, c)).join('') : '<div class="empty small" style="padding:18px;box-shadow:none">No comments yet.</div>'}
          </div>
          <form class="comment-form" data-pid="${esc(p.id)}">
            <textarea name="text" maxlength="2000" placeholder="${p.createdBy === S.me.id ? 'Post an update…' : 'Add a comment…'}" aria-label="Add a comment"></textarea>
            <button type="submit" class="btn sm">${p.createdBy === S.me.id ? 'Post Update' : 'Comment'}</button>
          </form>
          ${canModify(p.createdBy) ? `<div class="actions">
            <button class="btn tinted block" data-action="edit-prayer" data-id="${esc(p.id)}">Edit Request</button>
            <button class="btn danger block" data-action="delete-prayer" data-id="${esc(p.id)}">Delete Request</button></div>` : ''}
        </div>`;
    }
    if (s.kind === 'meal-form') {
      const t = s.id ? (S.trains || []).find((x) => x.id === s.id) : null;
      const d = t || { recipient: '', title: '', note: '', start: todayStr(), end: ymd(new Date(Date.now() + 13 * 864e5)), days: [0, 1, 2, 3, 4, 5, 6], dropStart: '17:00', dropEnd: '18:30', tz: '', headcount: '', dietary: '', instructions: '', address: '', contactPhone: '', showDishes: true, coordinators: [S.me.id] };
      if (s.id && !t) return '';
      return `<form autocomplete="off" novalidate>${head(t ? 'Edit Meal Train' : 'New Meal Train', 'Cancel', t ? 'Save' : 'Create')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="recipient" placeholder="Who are the meals for? (e.g. The Johnson family)" maxlength="100" value="${esc(d.recipient)}" aria-label="Who are the meals for" required></div>
            <div class="row stack"><textarea name="note" placeholder="Share what\u2019s going on and how people can help (shown on the sign-up page)" maxlength="2000" aria-label="Note">${esc(d.note)}</textarea></div>
          </div>
          <div class="group-label" style="margin-top:22px">Dates</div>
          <div class="group">
            <div class="row"><label for="mt-start">Starts</label><input id="mt-start" name="start" type="date" value="${esc(d.start)}" required></div>
            <div class="row"><label for="mt-end">Ends</label><input id="mt-end" name="end" type="date" value="${esc(d.end)}" required></div>
            <div class="row stack"><div class="weekday-chips" role="group" aria-label="Days that need a meal">${WD.map((w, i) => `<label><input type="checkbox" name="day" value="${i}" ${d.days.includes(i) ? 'checked' : ''}><span>${w}</span></label>`).join('')}</div></div>
          </div>
          <p class="group-foot">One meal for each selected day between the start and end dates.</p>
          <div class="group-label" style="margin-top:22px">Drop-off</div>
          <div class="group">
            <div class="row"><label>From</label>${timePicker('ds', d.dropStart, 'Drop-off from')}</div>
            <div class="row"><label>Until</label>${timePicker('de', d.dropEnd, 'Drop-off until')}</div>
            <div class="row"><label for="mt-tz">Time zone</label>${tzSelect('tz', d.tz).replace('<select', '<select id="mt-tz"')}</div>
            <div class="row"><input name="instructions" placeholder="Drop-off instructions (e.g. cooler on the porch)" maxlength="1000" value="${esc(d.instructions)}" aria-label="Drop-off instructions"></div>
          </div>
          <div class="group-label" style="margin-top:22px">The Family</div>
          <div class="group">
            <div class="row"><input name="headcount" placeholder="How many to feed (e.g. 2 adults, 3 kids)" maxlength="120" value="${esc(d.headcount)}" aria-label="How many to feed"></div>
            <div class="row"><input name="dietary" placeholder="Allergies, likes & dislikes" maxlength="1000" value="${esc(d.dietary)}" aria-label="Allergies, likes and dislikes"></div>
          </div>
          <div class="group-label" style="margin-top:22px">Private</div>
          <div class="group">
            <div class="row"><input name="address" placeholder="Delivery address" maxlength="300" value="${esc(d.address)}" aria-label="Delivery address" autocomplete="off"></div>
            <div class="row"><input name="contactPhone" type="tel" placeholder="Family\u2019s phone (optional)" maxlength="40" value="${esc(d.contactPhone)}" aria-label="Family's phone"></div>
          </div>
          <p class="group-foot">Only shown to people after they sign up, and to coordinators. Never on the public page.</p>
          <div class="group" style="margin-top:22px">
            <div class="row"><span>Show what people are bringing<small class="row-sub">Helps avoid three lasagnas in a row</small></span><label class="switch"><input type="checkbox" name="showDishes" ${d.showDishes !== false ? 'checked' : ''}><span></span></label></div>
          </div>
          <div class="group-label" style="margin-top:22px">Coordinators</div>
          <div class="group coord-list">${S.members.map((m) => `<label class="row"><input type="checkbox" name="coord" value="${esc(m.id)}" ${(d.coordinators || []).includes(m.id) ? 'checked' : ''}><span style="flex:1">${esc(m.name)}${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</span></label>`).join('')}</div>
          <p class="group-foot">Coordinators get an email when someone signs up or cancels, can see volunteers\u2019 contact info, and can edit the meal train. Group organizers can always manage it.</p>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'meal') {
      const t = (S.trains || []).find((x) => x.id === s.id);
      if (!t) return '';
      const today = todayStr(), up = trainUpcoming(t), cov = trainCovered(t, up), open = t.status === 'open';
      const slotOn = (d) => t.slots.find((x) => x.date === d);
      const kv = [['Dates', trainRange(t)], ['Drop-off', trainDrop(t, up[0] || t.start)], ['Serving', t.headcount], ['Allergies & food notes', t.dietary], ['Instructions', t.instructions], ['Address', t.address], ['Family\u2019s phone', t.contactPhone]].filter(([, v]) => v);
      const showPast = !!s.showPast, dates = showPast ? t.dates : up;
      return `${head('Meal Train', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero">
            <div class="mt-icon">${I.meal}</div>
            <h2 style="margin-top:12px">${esc(t.title)}</h2>
            <div class="w">${up.length ? `${cov} of ${up.length} meals covered` : 'Finished'}${!open ? ' · Sign-ups closed' : ''}</div>
            ${up.length ? `<div class="progress mt-progress" aria-hidden="true"><i style="width:${Math.round((cov / up.length) * 100)}%"></i></div>` : ''}
          </div>
          <div class="group-label">Sign-up link</div>
          <div class="group">
            <div class="share-box"><code>${esc(t.publicUrl)}</code><button class="btn sm" data-action="share-train" data-id="${esc(t.id)}">${I.share.replace('<svg', '<svg width="15" height="15"')} Share</button></div>
          </div>
          <p class="group-foot">Anyone with this link can sign up \u2014 no account needed. <a class="link" href="${esc(t.publicUrl)}" target="_blank" rel="noopener">Preview the page</a></p>
          ${t.note ? `<div class="group" style="margin-top:22px"><div class="detail-desc">${esc(t.note)}</div></div>` : ''}
          <div class="group kv" style="margin-top:22px">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v" style="white-space:pre-line">${k === 'Address' ? `<a class="link" target="_blank" rel="noopener" href="https://maps.apple.com/?q=${encodeURIComponent(v)}">${esc(v)}</a>` : esc(v)}</span></div>`).join('')}</div>
          ${!t.address && !t.canManage ? '<p class="group-foot">The address shows here once you sign up.</p>' : ''}
          <div class="group-label" style="margin-top:22px">${showPast ? 'All dates' : 'Upcoming dates'}</div>
          <div class="group mt-dates">
            ${dates.length ? dates.map((d) => {
              const sl = slotOn(d), past = d < today;
              const who = sl ? `${esc(sl.name)}${sl.mine ? ' <span class="muted">(you)</span>' : ''}${sl.dish ? ' · ' + esc(sl.dish) : ''}` : (t.dropStart ? esc(trainDrop(t, d)) : 'Open');
              const contact = sl && (sl.email || sl.phone) && !sl.mine ? `<small class="mt-contact">${[sl.phone && `<a class="link" href="tel:${esc(sl.phone)}">${esc(fmtPhone(sl.phone) || sl.phone)}</a>`, sl.email && `<a class="link" href="mailto:${esc(sl.email)}">${esc(sl.email)}</a>`].filter(Boolean).join(' · ')}${sl.member ? '' : ' · via link'}</small>` : '';
              const noteLine = sl && sl.note && (t.canManage || sl.mine) ? `<small class="mt-contact">\u201c${esc(sl.note)}\u201d</small>` : '';
              let act = '';
              if (sl && sl.mine && !past) act = `<button class="btn sm tinted" data-action="edit-my-slot" data-id="${esc(t.id)}" data-date="${d}">Change</button>`;
              else if (sl && t.canManage && !past) act = `<button class="btn sm danger" data-action="remove-slot" data-id="${esc(t.id)}" data-date="${d}">Remove</button>`;
              else if (sl) act = `<span class="pill green">Covered</span>`;
              else if (!past && open) act = `<button class="btn sm" data-action="train-signup" data-id="${esc(t.id)}" data-date="${d}">Sign Up</button>`;
              else act = `<span class="pill">${past ? 'Past' : 'Open'}</span>`;
              return `<div class="row mt-date${sl?.mine ? ' mine' : ''}${past ? ' past' : ''}">${`<div class="date-tile"><div class="m">${esc(monAbbr(d))}</div><div class="d">${parseYmd(d).getDate()}</div></div>`}
                <div class="mt-date-text"><b>${esc(parseYmd(d).toLocaleDateString(undefined, { weekday: 'long' }))}</b><small>${who}</small>${contact}${noteLine}</div>${act}</div>`;
            }).join('') : '<div class="empty small" style="padding:18px;box-shadow:none">No upcoming dates.</div>'}
          </div>
          ${t.dates.length !== up.length ? `<p class="group-foot"><button class="link-btn" data-action="toggle-past" data-id="${esc(t.id)}">${showPast ? 'Hide past dates' : `Show ${t.dates.length - up.length} past date${t.dates.length - up.length === 1 ? '' : 's'}`}</button></p>` : ''}
          ${t.canManage ? `<div class="actions">
            <button class="btn tinted block" data-action="edit-train" data-id="${esc(t.id)}">Edit Meal Train</button>
            <button class="btn tinted block" data-action="train-status" data-id="${esc(t.id)}">${open ? 'Close Sign-ups' : 'Reopen Sign-ups'}</button>
            <button class="btn tinted block" data-action="train-new-link" data-id="${esc(t.id)}">Make a New Link</button>
            <button class="btn danger block" data-action="delete-train" data-id="${esc(t.id)}">Delete Meal Train</button>
          </div>
          <p class="group-foot">A new link stops the old one from working. Existing sign-ups and their change links keep working.</p>` : ''}
        </div>`;
    }
    if (s.kind === 'meal-signup') {
      const t = (S.trains || []).find((x) => x.id === s.id);
      if (!t) return '';
      const mine = s.edit ? t.slots.find((x) => x.mine && x.date === s.date) : null;
      const opts = t.dates.filter((d) => d >= todayStr() && (!t.slots.some((x) => x.date === d) || d === mine?.date));
      return `<form autocomplete="off" novalidate>${head(mine ? 'Your Meal' : 'Sign Up', 'Cancel', mine ? 'Save' : 'Sign Up')}
        <div class="sheet-body">
          <div class="group"><div class="row"><label for="ms-date">Date</label><select id="ms-date" name="date" class="tz-select">${opts.map((d) => `<option value="${d}"${d === s.date ? ' selected' : ''}>${esc(fmtLong(d))}</option>`).join('')}</select></div></div>
          ${t.dropStart ? `<p class="group-foot">Drop off ${esc(trainDrop(t, s.date))}.</p>` : ''}
          <div class="group" style="margin-top:18px">
            <div class="row"><input name="dish" placeholder="What you\u2019re bringing" maxlength="160" value="${esc(mine?.dish || '')}" aria-label="What you're bringing" required></div>
            <div class="row stack"><textarea name="note" placeholder="Note for the family or coordinator (optional)" maxlength="500" aria-label="Note">${esc(mine?.note || '')}</textarea></div>
          </div>
          ${t.dietary ? `<div class="card mt-allergy" role="note" style="margin-top:18px"><div class="mt-allergy-icon">${I.info}</div><div><b>Allergies &amp; food notes</b><p>${esc(t.dietary)}</p></div></div>` : ''}
          <p class="group-foot">${mine ? '' : `You\u2019ll get the address and details by email at ${esc(S.me.email)}, and a reminder the day before.`}</p>
          ${mine ? `<div class="group" style="margin-top:22px"><div class="row danger-row" data-action="cancel-my-slot" data-id="${esc(t.id)}" data-date="${esc(mine.date)}" role="button" tabindex="0">Cancel My Sign-up</div></div>` : ''}
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'topic-form') {
      const t = s.id ? (S.topicDetail || {})[s.id] || (S.topics || []).find((x) => x.id === s.id) : { title: '', body: '' };
      if (!t) return '';
      return `<form autocomplete="off">${head(s.id ? 'Edit Topic' : 'New Topic', 'Cancel', s.id ? 'Save' : 'Post')}
        <div class="sheet-body">
          <div class="group">
            <div class="row"><input name="title" placeholder="Topic" maxlength="160" value="${esc(t.title)}" aria-label="Topic" required></div>
            <div class="row stack"><textarea name="body" placeholder="Start the conversation (optional)" maxlength="6000" aria-label="Details" style="min-height:140px">${esc(t.body || '')}</textarea></div>
          </div>
          <p class="group-foot">Everyone in ${esc(curGroup().name)} can read and reply.</p>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    if (s.kind === 'member') {
      const m = S.members.find((x) => x.id === s.id);
      if (!m) return '';
      return `${head('Member', 'Done')}
        <div class="sheet-body">
          <div class="detail-hero">${avatar(m.id, m.name, 'lg')}<h2 style="margin-top:12px">${esc(m.name)}</h2><div class="w">${m.role === 'organizer' ? 'Organizer' : 'Member'} of ${esc(curGroup().name)} · Joined ${esc(new Date(m.joined).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</div></div>
          ${m.phone ? `<div class="contact-actions">
            <a class="contact-btn" href="tel:${esc(m.phone)}">${I.phone}<span>Call</span></a>
            <a class="contact-btn" href="sms:${esc(m.phone)}">${I.message}<span>Text</span></a>
            <a class="contact-btn" href="mailto:${esc(m.email)}">${I.mail}<span>Email</span></a>
          </div>` : ''}
          ${m.email ? `<div class="group-label" style="margin-top:22px">Contact</div>
          <div class="group kv">
            <div class="row"><span>Mobile</span><span class="v">${m.phone ? `<a class="link" href="tel:${esc(m.phone)}">${esc(fmtPhone(m.phone))}</a>` : 'Not provided'}</span></div>
            <div class="row"><span>Email</span><span class="v"><a class="link" href="mailto:${esc(m.email)}">${esc(m.email)}</a></span></div>
          </div>` : ''}
          ${m.id !== S.me.id && m.email ? `<div class="group" style="margin-top:22px"><div class="row button-row" data-action="copy-contact" data-id="${esc(m.id)}" role="button" tabindex="0">Copy Contact Info</div></div>` : ''}
          ${isOrganizer() && m.id !== S.me.id ? `<div class="group-label" style="margin-top:22px">Organizer</div>
          <div class="group">
            ${m.role === 'organizer'
              ? `<div class="row button-row" data-action="set-role" data-id="${esc(m.id)}" data-role="member" role="button" tabindex="0">Remove Organizer Role</div>`
              : `<div class="row button-row" data-action="set-role" data-id="${esc(m.id)}" data-role="organizer" role="button" tabindex="0">Make Organizer</div>`}
          </div>
          <p class="group-foot">Organizers can edit or delete any event or poll, change the group code, and manage members.</p>
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="remove-member" data-id="${esc(m.id)}" role="button" tabindex="0">Remove from Group</div></div>` : ''}
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
          <p class="group-foot">Your email and mobile number are visible to members of your groups. Leave mobile blank to keep it private.</p>
          <div class="group-label" style="margin-top:22px">Notifications</div>
          <div class="group">
            <div class="row"><span>Group emails<small class="row-sub">Turn off to stop all emails from your groups</small></span><label class="switch"><input type="checkbox" name="notify" data-action="toggle-notify" ${m.notify ? 'checked' : ''}><span></span></label></div>
          </div>
          <div class="group notify-types${m.notify ? '' : ' is-off'}" style="margin-top:12px">
            ${[['event', 'New events'], ['scheduled', 'Poll results', 'When a poll\u2019s final date is scheduled'], ['poll', 'New polls'],
              ...(S.groups.some((g) => g.features?.prayer) ? [['prayer', 'New prayer requests'], ['prayerComment', 'Prayer comments & updates']] : []),
              ...(S.groups.some((g) => g.features?.meals) ? [['meal', 'New meal trains']] : []),
              ...(S.groups.some((g) => g.features?.topics !== false) ? [['topic', 'New discussion topics'], ['topicComment', 'Discussion replies']] : [])]
              .map(([k, label, sub]) => `<div class="row"><span>${esc(label)}${sub ? `<small class="row-sub">${sub}</small>` : ''}</span><label class="switch"><input type="checkbox" data-action="toggle-pref" data-key="${k}" ${(m.notifyPrefs || {})[k] !== false ? 'checked' : ''} ${m.notify ? '' : 'disabled'}><span></span></label></div>`).join('')}
          </div>
          <p class="group-foot">Choose which emails you get. Group organizers can also turn some emails off for everyone in a group.</p>
          <div class="group" style="margin-top:22px"><div class="row button-row" data-action="replay-tour" role="button" tabindex="0">Take the Tour<span class="chev">${I.right.replace('<svg', '<svg width="14" height="14"')}</span></div></div>
          <div class="group" style="margin-top:22px"><div class="row danger-row" data-action="logout" role="button" tabindex="0">Sign Out</div></div>
          <div id="sheet-msg"></div>
        </div></form>`;
    }
    return '';
  }

  function upsertTrain(t) {
    S.trains = S.trains || [];
    const i = S.trains.findIndex((x) => x.id === t.id);
    if (i >= 0) S.trains[i] = t; else S.trains.unshift(t);
  }
  function upsertPrayer(p) {
    S.prayers = S.prayers || [];
    const i = S.prayers.findIndex((x) => x.id === p.id);
    if (i >= 0) S.prayers[i] = p; else S.prayers.unshift(p);
    S.prayers.sort((a, b) => (b.lastActivity || b.createdAt).localeCompare(a.lastActivity || a.createdAt));
  }
  async function onSheetSave() {
    const s = S.sheet, form = $sheetRoot.querySelector('form:not(.bring-form):not(.comment-form):not(.comment-edit)');
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
        const body = { title: v.title, location: v.location, date: v.date, time: v.time, tz: v.tz, cost: v.cost, description: v.description, pitchIn: !!form.elements.pitchIn?.checked };
        const r = s.id ? await api('PUT', gp(`/events/${s.id}`), body) : await api('POST', gp('/events'), body);
        await loadAll();
        S.selected = r.event.date; const d = parseYmd(r.event.date); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
        S.view = 'calendar'; history.replaceState(null, '', '#calendar');
        closeSheet(); render();
        toast(s.id ? 'Event updated' : 'Event added · Group notified');
      } else if (s.kind === 'poll-form') {
        const existing = s.id ? S.polls.find((x) => x.id === s.id) : null;
        const type = existing ? existing.type : (s.type || 'dates');
        const anonymous = !!form.elements.anonymous?.checked;
        let body;
        if (!v.title.trim()) { btn.disabled = false; return err(type === 'choice' ? 'Please add a question.' : 'Please add a title.'); }
        if (type === 'choice') {
          const options = [...form.querySelectorAll('.choice-row')].map((r) => ({ id: r.dataset.id || undefined, text: r.querySelector('[name="choice"]').value.trim() })).filter((o) => o.text);
          if (options.length < 2) { btn.disabled = false; return err('Add at least two answers for people to choose from.'); }
          const ks = options.map((o) => o.text.toLowerCase());
          if (new Set(ks).size !== ks.length) { btn.disabled = false; return err('Two answers are the same. Change or remove one.'); }
          body = { type, title: v.title, description: v.description, options, multi: !!form.elements.multi?.checked, anonymous };
        } else if (type === 'pitchin') {
          body = { type, title: v.title, location: v.location, description: v.description, anonymous, eventId: v.eventId || undefined };
        } else {
          const options = readOptions(form).filter((o) => o.date);
          if (options.length < 2) { btn.disabled = false; return err('Add at least two dates for people to vote on.'); }
          const keys = options.map((o) => o.date + o.time);
          if (new Set(keys).size !== keys.length) { btn.disabled = false; return err('Two options have the same date and time. Change or remove one.'); }
          body = { type, title: v.title, location: v.location, cost: v.cost, description: v.description, options, pitchIn: !!form.elements.pitchIn?.checked, anonymous };
        }
        const r = s.id ? await api('PUT', gp(`/polls/${s.id}`), body) : await api('POST', gp('/polls'), body);
        await loadAll();
        if (r.linked) { // pitch-in went straight onto the chosen event
          S.view = 'polls'; render(); openSheet('event', { id: r.event.id });
          toast(`Pitch-in sign-up added to “${r.event.title}”`);
        } else {
          S.view = 'polls'; render();
          openSheet('poll', { id: r.poll.id }); history.replaceState(null, '', '#polls/' + r.poll.id);
          toast(s.id ? 'Poll updated' : 'Poll created · Group notified');
        }
      } else if (s.kind === 'topic-form') {
        if (!v.title.trim()) { btn.disabled = false; return err('Please give the topic a title.'); }
        const r = s.id ? await api('PUT', gp(`/topics/${s.id}`), { title: v.title, body: v.body }) : await api('POST', gp('/topics'), { title: v.title, body: v.body });
        upsertTopic(r.topic);
        closeSheet(true); openTopic(r.topic.id);
        toast(s.id ? 'Topic updated' : 'Topic posted');
      } else if (s.kind === 'meal-form') {
        const days = [...form.querySelectorAll('[name="day"]:checked')].map((x) => Number(x.value));
        const coordinators = [...form.querySelectorAll('[name="coord"]:checked')].map((x) => x.value);
        if (!v.recipient.trim()) { btn.disabled = false; return err('Who are the meals for?'); }
        if (!days.length) { btn.disabled = false; return err('Pick at least one day of the week.'); }
        const dropStart = readTime(form, 'ds'), dropEnd = readTime(form, 'de');
        const body = { recipient: v.recipient, note: v.note, start: v.start, end: v.end, days, dropStart, dropEnd, tz: v.tz, instructions: v.instructions, headcount: v.headcount, dietary: v.dietary, address: v.address, contactPhone: v.contactPhone, showDishes: !!form.elements.showDishes?.checked, coordinators };
        const r = s.id ? await api('PUT', gp(`/meals/${s.id}`), body) : await api('POST', gp('/meals'), body);
        await loadAll(); S.view = 'meals'; render();
        openSheet('meal', { id: r.train.id }); history.replaceState(null, '', '#meals/' + r.train.id);
        toast(s.id ? 'Meal train updated' : 'Meal train created · Share the link to get sign-ups');
      } else if (s.kind === 'meal-signup') {
        if (!v.dish.trim()) { btn.disabled = false; return err('What are you planning to bring? (\u201cNot sure yet\u201d is fine.)'); }
        const editing = s.edit;
        const r = editing ? await api('PUT', gp(`/meals/${s.id}/slots/${s.date}`), { date: v.date, dish: v.dish, note: v.note })
          : await api('POST', gp(`/meals/${s.id}/signup`), { date: v.date, dish: v.dish, note: v.note });
        upsertTrain(r.train); render(); openSheet('meal', { id: s.id });
        toast(editing ? 'Saved' : `Thank you! You\u2019re bringing a meal ${fmtShort(v.date)}`);
      } else if (s.kind === 'prayer-form') {
        if (!v.title.trim()) { btn.disabled = false; return err('Please add a title.'); }
        const body = { title: v.title, description: v.description };
        const r = s.id ? await api('PUT', gp(`/prayers/${s.id}`), body) : await api('POST', gp('/prayers'), body);
        upsertPrayer(r.prayer);
        if (S.view !== 'prayer') S.view = 'prayer';
        render(); openSheet('prayer', { id: r.prayer.id }); history.replaceState(null, '', '#prayer/' + r.prayer.id);
        toast(s.id ? 'Request updated' : 'Prayer request shared');
      } else if (s.kind === 'profile') {
        if (v.phone && !validPhone(v.phone)) { btn.disabled = false; return err('That phone number doesn\u2019t look right. Use a 10-digit number like (812) 555-0123, or leave it blank.'); }
        const r = await api('PATCH', '/me', { name: v.name, phone: v.phone || '' });
        S.me = r.user; await loadAll(); closeSheet(); render(); toast('Profile saved');
      }
    } catch (ex) { err(ex.message); btn.disabled = false; }
  }

  // ---------- Pitch-in ----------
  const BRING_CATS = ['Main dish', 'Side dish', 'Salad', 'Bread', 'Dessert', 'Drinks', 'Supplies', 'Other'];
  const bringCount = (list) => (list || []).reduce((n, c) => n + (c.items?.length || 0), 0);
  function choiceRow(o, removable) {
    return `<div class="row choice-row" data-id="${esc(o.id || '')}">
      <button type="button" class="opt-remove" data-action="remove-choice" aria-label="Remove this answer" ${removable ? '' : 'disabled'}>${I.minus.replace('<svg', '<svg width="22" height="22"')}</button>
      <input name="choice" maxlength="200" placeholder="Answer" value="${esc(o.text || '')}" aria-label="Answer">
    </div>`;
  }
  // Anonymous polls: a simple count instead of names
  function responsesBlock(p) {
    if (!p.anonymous) return '';
    const n = S.members.length;
    return `<div class="group-label" style="margin-top:26px">Responses</div>
      <div class="group"><div class="row" style="justify-content:space-between"><span>${p.responderCount} of ${n} ${p.type === 'pitchin' ? 'signed up' : 'responded'}</span>
        ${p.responded ? '<span class="pill green">You responded</span>' : '<span class="pill orange">Waiting on you</span>'}</div></div>
      <p class="group-foot">This poll is anonymous, so no one — not even organizers — can see who answered what.</p>`;
  }
  function otherPollSheet(p) {
    const open = p.status === 'open', owner = canModify(p.createdBy), n = S.members.length;
    const hero = `<div class="detail-hero" style="padding-bottom:16px">
        <h2>${esc(p.title)}</h2>
        <div class="w">${p.type === 'choice' ? 'Multiple choice' : 'Pitch-in'} · Started by ${esc(p.createdByName)}${p.status === 'closed' ? ' · Closed' : ''}</div>
        ${p.anonymous ? `<div class="anon-note">${I.eye.replace('<svg', '<svg width="14" height="14"')} Anonymous — ${p.type === 'pitchin' ? 'items are shown without names' : 'only totals are shown'}</div>` : ''}
      </div>`;
    const kv = [['Location', p.location], ['Created', fmtStamp(p.createdAt)]].filter(([, v]) => v);
    const desc = p.description ? `<div class="group" style="margin-top:22px"><div class="detail-desc">${esc(p.description)}</div></div>` : '';
    let main = '';
    if (p.type === 'choice') {
      const total = p.responderCount, top = topChoice(p);
      main = `<div class="group-label" style="margin-top:26px">${open ? (p.multi ? 'Choose any that apply' : 'Choose one') : 'Results'}</div>
        <div class="group choice-list" role="${p.multi ? 'group' : 'radiogroup'}">
        ${p.options.map((o) => {
          const pct = total ? Math.round((o.votes.length / total) * 100) : 0, mine = !!o.mine;
          return `<button class="choice-opt${mine ? ' mine' : ''}${top && top.id === o.id && !open ? ' winner' : ''}" ${open ? '' : 'disabled'} role="${p.multi ? 'checkbox' : 'radio'}" aria-checked="${mine}" data-action="choose" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}">
            <span class="co-bar" style="width:${pct}%"></span>
            <span class="co-mark ${p.multi ? 'sq' : ''}">${mine ? I.check.replace('<svg', '<svg width="13" height="13"') : ''}</span>
            <span class="co-text">${esc(o.text)}${!p.anonymous && o.votes.length ? `<small>${o.votes.map((v) => esc(v.name)).join(', ')}</small>` : ''}</span>
            <span class="co-n">${o.votes.length}<small>${pct}%</small></span>
          </button>`;
        }).join('')}
        </div>
        <p class="group-foot">${total} of ${n} answered${open ? ' · Tap again to change your answer' : ''}</p>`;
    } else {
      main = bringSection('poll', p, open);
    }
    const people = p.anonymous ? responsesBlock(p) : `<div class="group-label" style="margin-top:26px">${p.type === 'pitchin' ? 'Signed up' : 'Answered'} · ${p.responders.length} of ${n}</div>
      <div class="group people">${p.responders.length ? p.responders.map((r) => `<div class="person">${avatar(r.userId, r.name)}<div class="nm">${esc(r.name)}${r.userId === S.me.id ? ' <span class="muted">(you)</span>' : ''}<small>${esc(fmtStamp(r.at))}</small></div></div>`).join('') : '<div class="person"><div class="nm muted">No one yet.</div></div>'}</div>`;
    return `${head('Poll', 'Done')}
      <div class="sheet-body">
        ${hero}
        ${kv.length ? `<div class="group kv">${kv.map(([k, v]) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : ''}
        ${desc}
        ${main}
        ${people}
        ${owner ? `<div class="actions">
          ${p.type === 'pitchin' && open ? `<button class="btn tinted block" data-action="open-poll-link" data-id="${esc(p.id)}">${I.cal.replace('<svg', '<svg width="16" height="16"')} Link to Calendar Event</button>` : ''}
          ${open ? `<button class="btn tinted block" data-action="edit-poll" data-id="${esc(p.id)}">Edit Poll</button>` : ''}
          <button class="btn tinted block" data-action="poll-status" data-id="${esc(p.id)}">${open ? (p.type === 'pitchin' ? 'Close Sign-ups' : 'Close Poll') : 'Reopen'}</button>
          <button class="btn danger block" data-action="delete-poll" data-id="${esc(p.id)}">Delete Poll</button></div>` : ''}
      </div>`;
  }
  function bringRow(it, removable) {
    return `<div class="row bring-row">
      <button type="button" class="opt-remove" data-action="bring-row-remove" aria-label="Remove this item" ${removable ? '' : 'disabled'}>${I.minus.replace('<svg', '<svg width="22" height="22"')}</button>
      <input name="item" maxlength="200" placeholder="e.g. Mac and cheese" value="${esc(it.item || '')}" aria-label="Item">
      <select name="category" class="bring-select" aria-label="Category">${BRING_CATS.map((c) => `<option${(it.category || 'Main dish') === c ? ' selected' : ''}>${c}</option>`).join('')}</select>
    </div>`;
  }
  function bringSection(kind, obj, editable) {
    const list = obj.contributions || [];
    const mine = list.find((c) => c.mine || c.userId === S.me.id);
    const anon = !!(obj.anonymous || obj.bringAnon);
    const flat = list.flatMap((c) => c.items.map((it) => ({ ...it, userId: c.userId, name: c.name, mine: c.mine || c.userId === S.me.id })));
    const groups = BRING_CATS.map((cat) => [cat, flat.filter((x) => x.category === cat)]).filter(([, l]) => l.length);
    const summary = groups.length
      ? `<div class="group bring-list">${groups.map(([cat, l]) => `
          <div class="bring-cat"><span>${esc(cat)}</span><span class="pill">${l.length}</span></div>
          ${l.map((x) => `<div class="bring-item">${anon ? `<span class="avatar xs anon-av" aria-hidden="true">${x.mine ? 'You' : '?'}</span>` : avatar(x.userId, x.name, 'xs')}<span class="bi-text"><b>${esc(x.item)}</b><small>${anon ? (x.mine ? 'You' : 'Someone') : esc(x.name) + (x.mine ? ' (you)' : '')}</small></span></div>`).join('')}`).join('')}
        </div>`
      : `<div class="empty small" style="padding:18px">Nobody has signed up yet${editable ? ' — be the first!' : '.'}</div>`;
    const myItems = mine?.items?.length ? mine.items : [{ item: '', category: 'Main dish' }];
    const form = editable ? `
      <form class="group bring-form" data-kind="${kind}" data-id="${esc(obj.id)}" autocomplete="off" novalidate>
        ${myItems.map((it) => bringRow(it, myItems.length > 1)).join('')}
        <div class="row button-row" data-action="bring-row-add" role="button" tabindex="0">${I.plus.replace('<svg', '<svg width="18" height="18"')} Add another item</div>
        <div class="row bring-actions">
          ${mine ? `<button type="button" class="link danger-link" data-action="bring-clear" data-kind="${kind}" data-id="${esc(obj.id)}">Remove all mine</button>` : '<span></span>'}
          <button type="submit" class="btn sm">${mine ? 'Save Changes' : 'Sign Up'}</button>
        </div>
      </form>` : (kind === 'poll' && obj.eventId ? `<p class="group-foot">The date is set. Add or change what you’re bringing on the calendar event.</p>` : '');
    const total = flat.length;
    return `<div class="group-label" style="margin-top:26px">Pitch-in · ${anon ? 'what\u2019s coming' : 'who’s bringing what'}${total ? ` · ${total} item${total === 1 ? '' : 's'}` : ''}</div>
      ${summary}
      ${form ? `<div class="group-label" style="margin-top:16px">${mine ? `Your items · ${mine.items.length}` : 'What will you bring?'}</div>${form}` : ''}`;
  }
  async function saveBring(kind, id, items) {
    const path = kind === 'poll' ? `/polls/${id}/bring` : `/events/${id}/bring`;
    const r = await api('PUT', gp(path), { items });
    if (kind === 'poll') { const i = S.polls.findIndex((x) => x.id === id); if (i >= 0) S.polls[i] = r.poll; }
    else { const i = S.events.findIndex((x) => x.id === id); if (i >= 0) S.events[i] = r.event; }
    refreshSheet(); render();
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
      <div class="opt-fields">
        <input type="date" name="${k}_d" value="${esc(o.date)}" aria-label="Date" class="opt-date">
        <div class="opt-time">${timePicker(k + '_t', o.time, 'Time')}${tzSelect(k + '_z', o.tz)}</div>
      </div>
    </div>`;
  }
  function readOptions(form) {
    return [...form.querySelectorAll('.opt-row')].map((r) => ({
      id: r.dataset.id || undefined,
      date: r.querySelector('.opt-date').value,
      time: readTime(r, r.dataset.key + '_t'),
      tz: r.querySelector(`[name="${r.dataset.key}_z"]`)?.value || HOME_TZ,
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
    if (e.time && e.tz) { // exact moment in UTC so it lands right in any calendar app
      const start = zonedInstant(e.date, e.time, e.tz), end = new Date(start.getTime() + 2 * 3600e3);
      const u = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      when = `DTSTART:${u(start)}\r\nDTEND:${u(end)}`;
    } else if (e.time) {
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
      if (!(await ask({ title: `Delete “${e.title}”?`, message: `This removes it from the calendar for everyone${e.pitchIn ? ', along with the pitch-in sign-ups' : ''}.${e.pollId ? ' Its poll will reopen for voting.' : ''}`, ok: 'Delete', destructive: true }))) return;
      try { await api('DELETE', gp(`/events/${e.id}`)); await loadAll(); closeSheet(); render(); toast('Event deleted'); } catch (ex) { toast(ex.message); }
    },
    ics: (el) => downloadIcs(S.events.find((x) => x.id === el.dataset.id)),
    'new-poll': () => openSheet('poll-form'),
    'poll-type': (el) => {
      const f = $sheetRoot.querySelector('form'), val = (n) => f.querySelector(`[name="${n}"]`)?.value || '';
      const draft = { title: val('title'), description: val('description'), location: val('location'), anonymous: !!f.querySelector('[name="anonymous"]')?.checked };
      openSheet('poll-form', { type: el.dataset.type, draft });
    },
    'add-choice': (el) => {
      const f = el.closest('form'), rows = f.querySelectorAll('.choice-row');
      if (rows.length >= 20) return toast('That\u2019s the limit of 20 answers');
      const tmp = document.createElement('div'); tmp.innerHTML = choiceRow({ text: '' }, true);
      el.before(tmp.firstElementChild);
      f.querySelectorAll('.choice-row .opt-remove').forEach((b) => { b.disabled = f.querySelectorAll('.choice-row').length <= 2; });
      el.previousElementSibling.querySelector('input').focus();
    },
    'remove-choice': (el) => {
      const f = el.closest('form');
      if (f.querySelectorAll('.choice-row').length <= 2) return;
      el.closest('.choice-row').remove();
      f.querySelectorAll('.choice-row .opt-remove').forEach((b) => { b.disabled = f.querySelectorAll('.choice-row').length <= 2; });
    },
    choose: async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.poll), id = el.dataset.opt;
      const cur = p.options.filter((o) => o.mine).map((o) => o.id);
      const next = p.multi ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : (cur.includes(id) ? [] : [id]);
      p.options.forEach((o) => { o.mine = next.includes(o.id) ? 'x' : null; });
      refreshSheet();
      try {
        const r = await api('POST', gp(`/polls/${p.id}/vote`), { choices: next });
        Object.assign(p, r.poll); refreshSheet(); render();
      } catch (ex) { toast(ex.message); await loadAll(); refreshSheet(); render(); }
    },
    'poll-status': async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.id), closing = p.status === 'open';
      if (closing && !(await ask({ title: p.type === 'pitchin' ? 'Close sign-ups?' : 'Close this poll?', message: 'No one will be able to change their answer until you reopen it.', ok: 'Close' }))) return;
      try { const r = await api('POST', gp(`/polls/${p.id}/status`), { status: closing ? 'closed' : 'open' }); Object.assign(p, r.poll); refreshSheet(); render(); toast(closing ? 'Closed' : 'Reopened'); }
      catch (ex) { toast(ex.message); }
    },
    'open-poll-link': (el) => openSheet('poll-link', { id: el.dataset.id }),
    'link-event': async (el) => {
      const ev = S.events.find((x) => x.id === el.dataset.event);
      if (!(await ask({ title: `Link to \u201c${ev.title}\u201d?`, message: 'Everyone\u2019s sign-ups move onto that event and this poll is removed.', ok: 'Link' }))) return;
      try {
        const r = await api('POST', gp(`/polls/${el.dataset.poll}/link-event`), { eventId: ev.id });
        await loadAll(); render(); openSheet('event', { id: r.event.id }); toast('Linked · Sign-ups are on the event now');
      } catch (ex) { toast(ex.message); }
    },
    'open-poll': (el) => { openSheet('poll', { id: el.dataset.id }); history.replaceState(null, '', '#polls/' + el.dataset.id); },
    'add-opt': () => {
      const form = $sheetRoot.querySelector('form'), rows = form.querySelectorAll('.opt-row');
      const last = rows[rows.length - 1];
      const lastDate = last?.querySelector('.opt-date').value || '';
      const date = lastDate ? ymd(new Date(parseYmd(lastDate).getTime() + 7 * 864e5 + 3600e3)) : ''; // same weekday next week
      const time = last ? readTime(last, last.dataset.key + '_t') : '';
      const tz = last?.querySelector(`[name="${last.dataset.key}_z"]`)?.value;
      const tmp = document.createElement('div');
      tmp.innerHTML = optRow({ date, time, tz }, true);
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
      const cur = o.mine || null;
      const next = cur === el.dataset.ans ? null : el.dataset.ans;
      // optimistic update
      o.mine = next;
      if (!p.anonymous) {
        o.votes = o.votes.filter((v) => v.userId !== S.me.id);
        if (next) o.votes.push({ userId: S.me.id, name: S.me.name, answer: next, at: new Date().toISOString() });
      }
      if (next) p.responded = true;
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
      if (!(await ask({ title: `Schedule for ${fmtLong(o.date)}${o.time ? ' at ' + fmtWhenTime(o) : ''}?`, message: `“${p.title}” will go on the calendar, voting will close, and everyone will get an email.`, ok: 'Schedule' }))) return;
      try {
        await api('POST', gp(`/polls/${p.id}/schedule`), { optionId: o.id });
        await loadAll(); refreshSheet(); render(); toast('Scheduled · Added to the calendar');
      } catch (ex) { toast(ex.message); }
    },
    'delete-poll': async (el) => {
      const p = S.polls.find((x) => x.id === el.dataset.id);
      if (!(await ask({ title: `Delete “${p.title}”?`, message: `All responses${p.pitchIn ? ' and pitch-in sign-ups' : ''} will be deleted.${p.eventId ? ' The calendar event will stay.' : ''}`, ok: 'Delete', destructive: true }))) return;
      try { await api('DELETE', gp(`/polls/${p.id}`)); await loadAll(); closeSheet(); render(); toast('Poll deleted'); } catch (ex) { toast(ex.message); }
    },
    'goto-date': (el) => {
      S.selected = el.dataset.date; const d = parseYmd(S.selected); S.month = new Date(d.getFullYear(), d.getMonth(), 1);
      closeSheet(); go('calendar');
    },
    profile: () => { closeMenu(); openSheet('profile'); },
    'toggle-pref': async (el) => {
      const k = el.dataset.key, on = el.checked;
      try {
        const r = await api('PATCH', '/me', { notifyPrefs: { [k]: on } }); S.me = r.user;
        toast(`${el.closest('.row').querySelector('span').firstChild.textContent.trim()} emails ${on ? 'on' : 'off'}`);
      } catch (ex) { el.checked = !on; toast(ex.message); }
    },
    'toggle-notify': async (el) => {
      const box = $sheetRoot.querySelector('.notify-types');
      if (box) { box.classList.toggle('is-off', !el.checked); box.querySelectorAll('input').forEach((i) => { i.disabled = !el.checked; }); }
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
      if (!(await ask({ title: `Leave ${g.name}?`, message: 'You’ll stop seeing its calendar and getting its emails. You can rejoin with the group code.', ok: 'Leave', destructive: true }))) return;
      try {
        await api('POST', gp('/leave'), {});
        S.gid = null; await refreshGroups(); closeSheet(true);
        if (S.gid) await switchGroup(S.gid); else render();
        toast(`You left ${g.name}`);
      } catch (ex) { toast(ex.message); }
    },
    'bring-clear': async (el) => {
      if (!(await ask({ title: 'Remove your items?', message: 'Everything you signed up to bring will be removed.', ok: 'Remove', destructive: true }))) return;
      try { await saveBring(el.dataset.kind, el.dataset.id, []); toast('Removed your items'); } catch (ex) { toast(ex.message); }
    },
    'bring-row-add': (el) => {
      const f = el.closest('form'), rows = f.querySelectorAll('.bring-row');
      if (rows.length >= 15) return toast('That\u2019s the limit of 15 items');
      const last = rows[rows.length - 1];
      const tmp = document.createElement('div');
      tmp.innerHTML = bringRow({ item: '', category: last?.querySelector('[name="category"]').value || 'Main dish' }, true);
      el.before(tmp.firstElementChild);
      f.querySelectorAll('.bring-row .opt-remove').forEach((b) => { b.disabled = f.querySelectorAll('.bring-row').length <= 1; });
      el.previousElementSibling.querySelector('[name="item"]').focus();
    },
    'bring-row-remove': (el) => {
      const f = el.closest('form');
      if (f.querySelectorAll('.bring-row').length <= 1) return;
      el.closest('.bring-row').remove();
      f.querySelectorAll('.bring-row .opt-remove').forEach((b) => { b.disabled = f.querySelectorAll('.bring-row').length <= 1; });
    },
    'open-food': (el) => {
      openSheet('event', { id: el.dataset.id });
      setTimeout(() => {
        const label = [...$sheetRoot.querySelectorAll('.group-label')].find((x) => x.textContent.startsWith('Pitch-in'));
        if (label) label.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 350);
    },
    'group-features': () => openSheet('group-features'),
    'new-train': () => openSheet('meal-form'),
    'new-topic': () => openSheet('topic-form'),
    'open-topic': (el, ev) => { ev?.preventDefault?.(); openTopic(el.dataset.id); },
    'topics-back': () => closeTopic(),
    'edit-tpost': (el) => {
      S.editPost = el.dataset.cid; render();
      const t = document.querySelector('.tc-edit textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    },
    'cancel-tpost': () => { S.editPost = null; render(); },
    'edit-topic': (el) => openSheet('topic-form', { id: el.dataset.id }),
    'delete-topic': async (el) => {
      const t = S.topicDetail[el.dataset.id];
      if (!(await ask({ title: `Delete \u201c${t.title}\u201d?`, message: 'The topic and all of its replies will be deleted for everyone.', ok: 'Delete', destructive: true }))) return;
      try { await api('DELETE', gp(`/topics/${t.id}`)); S.topics = S.topics.filter((x) => x.id !== t.id); delete S.topicDetail[t.id]; closeTopic(); toast('Topic deleted'); }
      catch (ex) { toast(ex.message); }
    },
    'delete-tcomment': async (el) => {
      if (!(await ask({ title: 'Delete this reply?', message: 'This can\u2019t be undone.', ok: 'Delete', destructive: true }))) return;
      try { const r = await api('DELETE', gp(`/topics/${el.dataset.tid}/comments/${el.dataset.cid}`)); upsertTopic(r.topic); render(); toast('Reply deleted'); }
      catch (ex) { toast(ex.message); }
    },
    'open-train': (el) => { openSheet('meal', { id: el.dataset.id }); history.replaceState(null, '', '#meals/' + el.dataset.id); },
    'edit-train': (el) => openSheet('meal-form', { id: el.dataset.id }),
    'share-train': (el) => shareTrain(S.trains.find((x) => x.id === el.dataset.id)),
    'toggle-past': (el) => { S.sheet.showPast = !S.sheet.showPast; refreshSheet(); },
    'train-signup': (el) => openSheet('meal-signup', { id: el.dataset.id, date: el.dataset.date }),
    'edit-my-slot': (el) => openSheet('meal-signup', { id: el.dataset.id, date: el.dataset.date, edit: true }),
    'cancel-my-slot': async (el) => {
      if (!(await ask({ title: 'Cancel your sign-up?', message: `You won\u2019t be bringing a meal on ${fmtLong(el.dataset.date)}. The coordinators will be told.`, ok: 'Cancel Sign-up', destructive: true }))) return;
      try { const r = await api('DELETE', gp(`/meals/${el.dataset.id}/slots/${el.dataset.date}`)); upsertTrain(r.train); render(); openSheet('meal', { id: el.dataset.id }); toast('Sign-up cancelled'); }
      catch (ex) { toast(ex.message); }
    },
    'remove-slot': async (el) => {
      const t = S.trains.find((x) => x.id === el.dataset.id), sl = t.slots.find((x) => x.date === el.dataset.date);
      if (!(await ask({ title: `Remove ${sl.name}?`, message: `${sl.name} won\u2019t be bringing a meal on ${fmtLong(sl.date)}. They\u2019ll get an email letting them know.`, ok: 'Remove', destructive: true }))) return;
      try { const r = await api('DELETE', gp(`/meals/${t.id}/slots/${sl.date}`)); upsertTrain(r.train); refreshSheet(); render(); toast('Sign-up removed'); }
      catch (ex) { toast(ex.message); }
    },
    'train-status': async (el) => {
      const t = S.trains.find((x) => x.id === el.dataset.id), closing = t.status === 'open';
      if (closing && !(await ask({ title: 'Close sign-ups?', message: 'No one will be able to sign up until you reopen it. Existing sign-ups stay.', ok: 'Close Sign-ups' }))) return;
      try { const r = await api('POST', gp(`/meals/${t.id}/status`), { status: closing ? 'closed' : 'open' }); upsertTrain(r.train); refreshSheet(); render(); toast(closing ? 'Sign-ups closed' : 'Sign-ups reopened'); }
      catch (ex) { toast(ex.message); }
    },
    'train-new-link': async (el) => {
      if (!(await ask({ title: 'Make a new link?', message: 'The old sign-up link will stop working. Anyone you shared it with will need the new one.', ok: 'Make New Link', destructive: true }))) return;
      try { const r = await api('POST', gp(`/meals/${el.dataset.id}/new-link`), {}); upsertTrain(r.train); refreshSheet(); toast('New link ready'); }
      catch (ex) { toast(ex.message); }
    },
    'delete-train': async (el) => {
      const t = S.trains.find((x) => x.id === el.dataset.id), n = t.slots.filter((x) => x.date >= todayStr()).length;
      if (!(await ask({ title: `Delete \u201c${t.title}\u201d?`, message: `The sign-up link will stop working.${n ? ` ${n} volunteer${n === 1 ? '' : 's'} with upcoming dates will get an email that it was cancelled.` : ''}`, ok: 'Delete', destructive: true }))) return;
      try { await api('DELETE', gp(`/meals/${t.id}`)); S.trains = S.trains.filter((x) => x.id !== t.id); closeSheet(); render(); toast('Meal train deleted'); }
      catch (ex) { toast(ex.message); }
    },
    'group-notifications': () => openSheet('group-notifications'),
    'toggle-notification': async (el) => {
      const g = curGroup(), k = el.dataset.key, on = el.checked;
      el.disabled = true;
      try {
        const r = await api('PATCH', gp(''), { notifications: { [k]: on } });
        g.notifications = r.group.notifications;
        toast(`${el.closest('.row').querySelector('span').firstChild.textContent.trim()} emails ${on ? 'on' : 'off'}`);
      } catch (ex) { el.checked = !on; toast(ex.message); }
      el.disabled = false;
    },
    'toggle-feature': async (el) => {
      const g = curGroup(), k = el.dataset.feature, on = el.checked;
      el.disabled = true;
      try {
        const r = await api('PATCH', gp(''), { features: { [k]: on } });
        Object.assign(g, r.group || {}, { features: (r.group && r.group.features) || { ...(g.features || {}), [k]: on } });
        await loadAll(); render();
        toast(`${k === 'members' ? 'Members tab' : 'Prayer Requests'} turned ${on ? 'on' : 'off'}`);
      } catch (ex) { el.checked = !on; toast(ex.message); }
      el.disabled = false;
    },
    'new-prayer': () => openSheet('prayer-form'),
    'open-prayer': (el) => { openSheet('prayer', { id: el.dataset.id }); history.replaceState(null, '', '#prayer/' + el.dataset.id); },
    'edit-prayer': (el) => openSheet('prayer-form', { id: el.dataset.id }),
    'delete-prayer': async (el) => {
      const p = S.prayers.find((x) => x.id === el.dataset.id);
      if (!(await ask({ title: `Delete “${p.title}”?`, message: 'The request and all of its comments will be deleted for everyone.', ok: 'Delete', destructive: true }))) return;
      try { await api('DELETE', gp(`/prayers/${p.id}`)); S.prayers = S.prayers.filter((x) => x.id !== p.id); closeSheet(); render(); toast('Prayer request deleted'); }
      catch (ex) { toast(ex.message); }
    },
    'edit-comment': (el) => {
      S.sheet.editComment = el.dataset.cid; refreshSheet();
      const t = $sheetRoot.querySelector('.comment-edit textarea, .tc-edit textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    },
    'cancel-edit-comment': () => { S.sheet.editComment = null; refreshSheet(); },
    'delete-comment': async (el) => {
      if (!(await ask({ title: 'Delete this comment?', message: 'This can’t be undone.', ok: 'Delete', destructive: true }))) return;
      try { const r = await api('DELETE', gp(`/prayers/${el.dataset.pid}/comments/${el.dataset.cid}`)); upsertPrayer(r.prayer); refreshSheet(); render(); toast('Comment deleted'); }
      catch (ex) { toast(ex.message); }
    },
    'replay-tour': () => { closeSheet(true); startTour(true); },
    'member-actions': (el) => openSheet('member', { id: el.dataset.id }),
    'copy-contact': async (el) => {
      const m = S.members.find((x) => x.id === el.dataset.id);
      const t = [m.name, m.phone && fmtPhone(m.phone), m.email].filter(Boolean).join('\n');
      toast((await copyText(t)) ? 'Contact info copied' : 'Couldn\u2019t copy');
    },
    'set-role': async (el) => {
      try {
        await api('PATCH', gp(`/members/${encodeURIComponent(el.dataset.id)}`), { role: el.dataset.role });
        await loadAll(); refreshSheet(); render(); toast(el.dataset.role === 'organizer' ? 'Now an organizer' : 'Organizer role removed');
      } catch (ex) { toast(ex.message); }
    },
    'remove-member': async (el) => {
      const m = S.members.find((x) => x.id === el.dataset.id);
      if (!(await ask({ title: `Remove ${m.name}?`, message: `They’ll be removed from ${curGroup().name} and can rejoin only with the current group code.`, ok: 'Remove', destructive: true }))) return;
      try { await api('DELETE', gp(`/members/${encodeURIComponent(m.id)}`)); await refreshGroups(); await loadAll(); closeSheet(); render(); toast(`${m.name} removed`); }
      catch (ex) { toast(ex.message); }
    },
    close: () => closeSheet(),
    backdrop: (el, ev) => { if (ev.target === el) closeSheet(); },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || (el.tagName === 'INPUT' && el.type === 'checkbox' && ['toggle-notify', 'toggle-feature', 'toggle-notification', 'toggle-pref'].includes(el.dataset.action))) return;
    const fn = actions[el.dataset.action];
    if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') ev.preventDefault(); fn(el, ev); }
  });
  document.addEventListener('submit', async (ev) => {
    const f = ev.target;
    if (f.classList?.contains('tc-form') || f.classList?.contains('tc-edit')) {
      ev.preventDefault();
      const text = f.querySelector('textarea').value.trim();
      if (!text) { f.querySelector('textarea').focus(); return; }
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const editing = f.classList.contains('tc-edit');
        const r = editing ? await api('PUT', gp(`/topics/${f.dataset.tid}/comments/${f.dataset.cid}`), { text })
          : await api('POST', gp(`/topics/${f.dataset.tid}/comments`), { text });
        if (editing) S.editPost = null; else f.querySelector('textarea').value = '';
        upsertTopic(r.topic); render();
        if (!editing) [...document.querySelectorAll('.posts .post')].pop()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        toast(editing ? 'Reply updated' : 'Replied');
      } catch (ex) { toast(ex.message); btn.disabled = false; }
      return;
    }
    if (f.classList?.contains('comment-form') || f.classList?.contains('comment-edit')) {
      ev.preventDefault();
      const text = f.querySelector('textarea').value.trim();
      if (!text) { f.querySelector('textarea').focus(); return; }
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const editing = f.classList.contains('comment-edit');
        const r = editing ? await api('PUT', gp(`/prayers/${f.dataset.pid}/comments/${f.dataset.cid}`), { text })
          : await api('POST', gp(`/prayers/${f.dataset.pid}/comments`), { text });
        if (editing) S.sheet.editComment = null; else f.querySelector('textarea').value = '';
        upsertPrayer(r.prayer); refreshSheet(); render();
        if (!editing) { const b = $sheetRoot.querySelector('.sheet-body'); if (b) b.querySelector('.comments .comment:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        toast(editing ? 'Comment updated' : 'Posted');
      } catch (ex) { toast(ex.message); btn.disabled = false; }
      return;
    }
    if (!f.classList?.contains('bring-form')) return;
    ev.preventDefault();
    const items = [...f.querySelectorAll('.bring-row')].map((r) => ({ item: r.querySelector('[name="item"]').value.trim(), category: r.querySelector('[name="category"]').value })).filter((x) => x.item);
    if (!items.length) { f.querySelector('[name="item"]').focus(); return toast('Type what you\u2019re bringing'); }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try { await saveBring(f.dataset.kind, f.dataset.id, items); toast(items.length === 1 ? 'Thanks — you\u2019re signed up' : `Thanks — you\u2019re signed up for ${items.length} items`); }
    catch (ex) { toast(ex.message); btn.disabled = false; }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches?.('select[data-tp]')) { const tp = el.closest('.tp'); tp.classList.toggle('tp-empty', !tp.querySelector('select').value); }
    if (el.dataset?.action === 'toggle-notify') actions['toggle-notify'](el);
    if (el.dataset?.action === 'toggle-feature') actions['toggle-feature'](el);
    if (el.dataset?.action === 'toggle-notification') actions['toggle-notification'](el);
    if (el.dataset?.action === 'toggle-pref') actions['toggle-pref'](el);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { if (document.getElementById('group-menu')) closeMenu(); else if (S.sheet) closeSheet(); }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role=button][data-action]')) { ev.preventDefault(); ev.target.click(); }
  });
  window.addEventListener('hashchange', () => {
    if (!S.me) { readHash(); return render(); }
    const before = S.view; readHash();
    if (S.pendingPoll) { const id = S.pendingPoll; S.pendingPoll = null; if (S.view !== before) render(); if (S.polls.some((p) => p.id === id)) openSheet('poll', { id }); }
    else if (S.pendingPrayer) { const id = S.pendingPrayer; S.pendingPrayer = null; render(); if ((S.prayers || []).some((p) => p.id === id)) openSheet('prayer', { id }); }
    else if (S.pendingTrain) { const id = S.pendingTrain; S.pendingTrain = null; render(); if ((S.trains || []).some((t) => t.id === id)) openSheet('meal', { id }); }
    else if (S.pendingTopic) { const id = S.pendingTopic; S.pendingTopic = null; render(); if ((S.topics || []).some((t) => t.id === id)) openTopic(id); }
    else render();
  });

  // Keep things fresh while the tab is open
  async function refresh() {
    if (!S.me || document.hidden) return;
    if (TOUR) return;
    if (!S.groups.length) return; // join/create screen: never redraw it, or it wipes what someone is typing
    if (S.sheet && ['event-form', 'poll-form', 'profile', 'group-new', 'group-join', 'group-edit', 'prayer-form', 'meal-form', 'meal-signup', 'topic-form'].includes(S.sheet.kind)) return;
    if (S.sheet?.editComment) return;
    if (S.view === 'topics' && S.topicOpen && threadBusy()) return;
    const typing = document.querySelector('.comment-form textarea, .tc-form textarea');
    if (typing && typing.value.trim()) return;
    if (document.getElementById('group-menu')) return;
    if (document.activeElement?.closest?.('.bring-form, .comment-form, .comment-edit, .tc-form, .tc-edit')) return;
    try {
      await refreshGroups(); if (S.groups.length) await loadAll();
      if (S.view === 'topics' && S.topicOpen) { try { S.topicDetail[S.topicOpen] = (await api('GET', gp(`/topics/${S.topicOpen}`))).topic; } catch {} }
      render(); if (S.sheet) refreshSheet();
    } catch {}
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
    if (S.pendingPrayer) { const id = S.pendingPrayer; S.pendingPrayer = null; if ((S.prayers || []).some((p) => p.id === id)) openSheet('prayer', { id }); }
    if (S.pendingTrain) { const id = S.pendingTrain; S.pendingTrain = null; if ((S.trains || []).some((t) => t.id === id)) openSheet('meal', { id }); }
    if (S.pendingTopic) { const id = S.pendingTopic; S.pendingTopic = null; if ((S.topics || []).some((t) => t.id === id)) openTopic(id); }
  }
  (async () => {
    S.linkGroup = new URLSearchParams(location.search).get('g');
    readHash();
    try { S.config = await api('GET', '/config'); document.title = S.config.appName; } catch {}
    if (S.authMode === 'reset') { S.me = null; return renderAuth(); }
    try { await boot(); } catch (ex) { $app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Can't connect</h1><p class="sub">${esc(ex.message)}</p><button class="btn" onclick="location.reload()">Try Again</button></div></div>`; }
  })();
})();
