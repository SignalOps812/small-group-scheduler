// Public meal train page — no account needed.
//   /m/<token>          sign up for a date
//   /m/manage/<token>   a volunteer's private link to view, change or cancel their sign-up
(() => {
  'use strict';
  const $app = document.getElementById('app'), $sheet = document.getElementById('sheet-root'), $toast = document.getElementById('toast');
  const parts = location.pathname.split('/').filter(Boolean); // ['m', token] or ['m', 'manage', token]
  const MODE = parts[1] === 'manage' ? 'manage' : 'train';
  const TOKEN = MODE === 'manage' ? parts[2] : parts[1];
  const S = { train: null, mine: null, details: null, slot: null, manageToken: MODE === 'manage' ? TOKEN : null, view: 'list' };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtLong = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtMonth = (s) => parseYmd(s).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
  const tzOffset = (ts, tz) => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
      return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
    } catch { return 0; }
  };
  const zoned = (date, time, tz) => {
    const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi); let t = wall;
    for (let i = 0; i < 3; i++) t = wall - tzOffset(t, tz);
    return new Date(t);
  };
  const abbr = (date, time, tz) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(zoned(date, time, tz)).find((x) => x.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
  const isLocal = (date, time, tz) => { const d = zoned(date, time, tz); return tzOffset(d.getTime(), tz) === -d.getTimezoneOffset() * 6e4; };
  const dropWindow = (t, date) => {
    if (!t.dropStart) return '';
    const z = isLocal(date, t.dropStart, t.tz) ? '' : ' ' + abbr(date, t.dropStart, t.tz);
    return `${fmtTime(t.dropStart)}${t.dropEnd ? ' – ' + fmtTime(t.dropEnd) : ''}${z}`;
  };
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };
  function toast(msg) { $toast.textContent = msg; $toast.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => $toast.classList.remove('show'), 2600); }
  async function api(method, path, body) {
    const res = await fetch('/api' + path, { method, headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {}, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
    return data;
  }
  function ask({ title, message, ok, destructive }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'alert-backdrop';
      wrap.innerHTML = `<div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-t"><div class="alert-body"><div class="alert-title" id="alert-t">${esc(title)}</div>${message ? `<div class="alert-msg">${esc(message)}</div>` : ''}</div>
        <div class="alert-actions"><button type="button" data-v="0">Keep It</button><button type="button" data-v="1" class="${destructive ? 'destructive' : 'primary'}">${esc(ok)}</button></div></div>`;
      wrap.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { wrap.remove(); resolve(b.dataset.v === '1'); } else if (e.target === wrap) { wrap.remove(); resolve(false); } });
      document.body.appendChild(wrap);
      wrap.querySelector('[data-v="0"]').focus();
    });
  }
  const I = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
    meal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h18a9 9 0 0 1-18 0z"/><path d="M8 9c0-1.5 1-2 1-3.5M12 9c0-1.5 1-2 1-3.5M16 9c0-1.5 1-2 1-3.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  };

  // ---------- views ----------
  const dateTile = (d) => `<div class="date-tile"><div class="m">${esc(parseYmd(d).toLocaleDateString(undefined, { month: 'short' }))}</div><div class="d">${parseYmd(d).getDate()}</div></div>`;
  function trainDetails(t, extra) {
    const rows = [['Drop-off', t.dropStart ? dropWindow(t, (t.dates[0] || {}).date || '2026-01-01') : ''], ['Serving', t.headcount], ['Instructions', t.instructions], ...(extra || [])].filter(([, v]) => v);
    return rows.length ? `<div class="group kv mt-kv">${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : '';
  }
  // Allergies get their own highlighted card so no one misses them
  const allergyCard = (t) => t.dietary ? `<div class="card mt-allergy" role="note"><div class="mt-allergy-icon">${I.alert}</div><div><b>Allergies &amp; food notes</b><p>${esc(t.dietary)}</p></div></div>` : '';
  const aboutCard = (t, label) => t.note ? `${label ? `<div class="group-label" style="margin-top:22px">${label}</div>` : ''}<div class="group"><div class="detail-desc">${esc(t.note)}</div></div>` : '';
  function header(t) {
    return `<header class="mt-top"><div class="brand"><img src="/icon.svg?v=2" alt=""><span>${esc(t?.groupName || 'Groups')}</span></div></header>`;
  }
  function renderTrain() {
    const t = S.train, open = t.status === 'open';
    const upcoming = t.dates.filter((d) => !d.past), free = upcoming.filter((d) => !d.taken).length;
    const mineTok = store.get('mt:' + TOKEN), mine = mineTok && S.mine;
    let lastMonth = '';
    const list = upcoming.map((d) => {
      const month = fmtMonth(d.date), headerRow = month !== lastMonth ? `${lastMonth ? '</div>' : ''}<div class="group-label" style="margin-top:22px">${esc(month)}</div><div class="group mt-dates">` : '';
      lastMonth = month;
      const isMine = mine && mine.date === d.date;
      return `${headerRow}<div class="row mt-date${d.taken ? ' taken' : ''}${isMine ? ' mine' : ''}">
        ${dateTile(d.date)}
        <div class="mt-date-text"><b>${esc(parseYmd(d.date).toLocaleDateString(undefined, { weekday: 'long' }))}</b>
          <small>${d.taken ? `${esc(d.name)}${isMine ? ' (you)' : ''}${d.dish ? ' · ' + esc(d.dish) : ''}` : t.dropStart ? esc(dropWindow(t, d.date)) : 'Open'}</small></div>
        ${d.taken ? `<span class="pill ${isMine ? 'blue' : 'green'}">${isMine ? 'You' : 'Covered'}</span>` : open ? `<button class="btn sm" data-act="signup" data-date="${d.date}">Sign Up</button>` : '<span class="pill">Open</span>'}
      </div>`;
    }).join('') + (lastMonth ? '</div>' : '');
    $app.innerHTML = `${header(t)}
      <main class="page mt-page fade-in">
        <section class="mt-hero">
          <div class="mt-icon">${I.meal}</div>
          <h1>${esc(t.title)}</h1>
          <div class="sub">${upcoming.length ? `${free ? `${free} of ${upcoming.length} meal${upcoming.length === 1 ? '' : 's'} still open` : 'Every meal is covered — thank you!'}` : 'This meal train has finished.'}</div>
          ${upcoming.length ? `<div class="progress mt-progress" aria-hidden="true"><i style="width:${Math.round(((upcoming.length - free) / upcoming.length) * 100)}%"></i></div>` : ''}
        </section>
        ${mine ? `<div class="card mt-mine"><div>${I.check}</div><div><b>You\u2019re bringing a meal on ${esc(fmtLong(mine.date))}</b><small>${esc(mine.dish)}</small></div><a class="btn sm tinted" href="/m/manage/${esc(mineTok)}">View</a></div>` : ''}
        ${!open ? '<div class="card notice-card">Sign-ups are closed right now. Contact the coordinator if you\u2019d still like to help.</div>' : ''}
        ${aboutCard(t)}
        ${allergyCard(t)}
        ${trainDetails(t)}
        ${t.hasAddress ? `<p class="group-foot mt-lock">${I.lock}<span>The address is shared once you sign up.</span></p>` : ''}
        ${list || '<div class="empty" style="margin-top:22px">No upcoming dates.</div>'}
        <p class="mt-foot">Organized with <a href="/">Groups</a>. Your contact info is shared only with the meal train coordinators.</p>
      </main>`;
  }
  function signupSheet(date) {
    const open = S.train.dates.filter((d) => !d.past && !d.taken);
    const saved = (() => { try { return JSON.parse(store.get('mt:me') || '{}'); } catch { return {}; } })();
    openSheet(`<form id="signup" autocomplete="on" novalidate>
      <div class="sheet-head"><button class="l" type="button" data-act="close">Cancel</button><div class="t">Sign Up</div><button class="r" type="submit">Sign Up</button></div>
      <div class="sheet-body">
        ${allergyCard(S.train)}
        <div class="group">
          <div class="row"><label for="s-date">Date</label><select id="s-date" name="date" class="tz-select">${open.map((d) => `<option value="${d.date}"${d.date === date ? ' selected' : ''}>${esc(fmtLong(d.date))}</option>`).join('')}</select></div>
        </div>
        ${S.train.dropStart ? `<p class="group-foot">Drop off ${esc(dropWindow(S.train, date))}.</p>` : ''}
        <div class="group-label" style="margin-top:18px">You</div>
        <div class="group">
          <div class="row"><input name="name" autocomplete="name" placeholder="Your name" maxlength="80" value="${esc(saved.name || '')}" aria-label="Your name" required></div>
          <div class="row"><input name="email" type="email" autocomplete="email" inputmode="email" placeholder="Email" maxlength="200" value="${esc(saved.email || '')}" aria-label="Email" required></div>
          <div class="row"><input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="Mobile (optional)" maxlength="40" value="${esc(saved.phone || '')}" aria-label="Mobile, optional"></div>
        </div>
        <div class="group-label" style="margin-top:18px">Meal</div>
        <div class="group">
          <div class="row"><input name="dish" placeholder="What you\u2019re bringing" maxlength="160" aria-label="What you're bringing" required></div>
          <div class="row stack"><textarea name="note" placeholder="Note for the family or coordinator (optional)" maxlength="500" aria-label="Note"></textarea></div>
        </div>
        <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
        <p class="group-foot">We\u2019ll email you the address and details, plus a link to change or cancel.</p>
        <div id="sheet-msg"></div>
      </div></form>`);
    const f = $sheet.querySelector('form');
    f.querySelector('#s-date').addEventListener('change', (e) => { const p = f.querySelector('.group-foot'); if (p && S.train.dropStart) p.textContent = `Drop off ${dropWindow(S.train, e.target.value)}.`; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f)), btn = f.querySelector('button[type=submit]'), msg = f.querySelector('#sheet-msg');
      const err = (t) => { msg.innerHTML = `<div class="form-error">${esc(t)}</div>`; msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
      if (!v.name.trim()) return err('Please enter your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return err('Please enter a valid email so we can send you the details.');
      if (!v.dish.trim()) return err('What are you planning to bring? (\u201cNot sure yet\u201d is fine.)');
      btn.disabled = true;
      try {
        const r = await api('POST', `/public/meals/${TOKEN}/signup`, v);
        store.set('mt:' + TOKEN, r.manage);
        store.set('mt:me', JSON.stringify({ name: v.name.trim(), email: v.email.trim(), phone: v.phone.trim() }));
        S.train = r.train; S.mine = r.slot; S.details = r.details; S.manageToken = r.manage;
        closeSheet(); renderDone(true);
      } catch (ex) {
        btn.disabled = false; err(ex.message);
        if (ex.status === 409) { try { S.train = (await api('GET', `/public/meals/${TOKEN}`)).train; renderTrain(); } catch {} }
      }
    });
  }
  // Confirmation (just signed up) and the volunteer's manage page share this layout
  function renderDone(justSignedUp) {
    const t = S.train, s = S.mine, d = S.details || {};
    const rows = [['Date', fmtLong(s.date)], ['Drop-off', t.dropStart ? dropWindow(t, s.date) : ''], ['Address', d.address], ['Family\u2019s phone', d.contactPhone],
      ['Bringing', s.dish], ['Serving', t.headcount], ['Instructions', t.instructions]].filter(([, v]) => v);
    const past = t.dates.find((x) => x.date === s.date)?.past;
    $app.innerHTML = `${header(t)}
      <main class="page mt-page fade-in">
        <section class="mt-hero">
          <div class="mt-icon done">${I.check}</div>
          <h1>${justSignedUp ? 'You\u2019re signed up!' : 'Your meal sign-up'}</h1>
          <div class="sub">${esc(t.title)}</div>
        </section>
        ${allergyCard(t)}
        <div class="group kv mt-kv">${rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span class="v">${k === 'Address' ? `<a class="link" target="_blank" rel="noopener" href="https://maps.apple.com/?q=${encodeURIComponent(v)}">${esc(v)}</a>` : k === 'Family\u2019s phone' ? `<a class="link" href="tel:${esc(v)}">${esc(v)}</a>` : esc(v)}</span></div>`).join('')}</div>
        ${s.note ? `<p class="group-foot">Your note: ${esc(s.note)}</p>` : ''}
        ${aboutCard(t, 'About')}
        <div class="actions">
          <button class="btn block" data-act="ics">Add to My Calendar</button>
          ${past ? '' : '<button class="btn tinted block" data-act="edit">Change Sign-up</button><button class="btn danger block" data-act="cancel">Cancel Sign-up</button>'}
        </div>
        <p class="group-foot" style="text-align:center">${justSignedUp ? `We emailed the details to <b>${esc(s.email)}</b>, with a link to change or cancel later. ` : ''}Keep this link private \u2014 anyone with it can change your sign-up.</p>
        <p class="mt-foot"><a href="/m/${esc(S.publicToken || TOKEN)}" data-act="back">\u2190 See all dates</a></p>
      </main>`;
    if (justSignedUp && MODE !== 'manage') history.replaceState(null, '', '/m/manage/' + S.manageToken);
    window.scrollTo({ top: 0 });
  }
  function editSheet() {
    const t = S.train, s = S.mine;
    const opts = t.dates.filter((d) => !d.past && (!d.taken || d.date === s.date));
    openSheet(`<form id="edit" novalidate>
      <div class="sheet-head"><button class="l" type="button" data-act="close">Cancel</button><div class="t">Change Sign-up</div><button class="r" type="submit">Save</button></div>
      <div class="sheet-body">
        ${allergyCard(t)}
        <div class="group"><div class="row"><label for="e-date">Date</label><select id="e-date" name="date" class="tz-select">${opts.map((d) => `<option value="${d.date}"${d.date === s.date ? ' selected' : ''}>${esc(fmtLong(d.date))}</option>`).join('')}</select></div></div>
        <div class="group" style="margin-top:18px">
          <div class="row"><input name="name" placeholder="Your name" maxlength="80" value="${esc(s.name)}" aria-label="Your name"></div>
          <div class="row"><input name="email" type="email" placeholder="Email" maxlength="200" value="${esc(s.email)}" aria-label="Email"></div>
          <div class="row"><input name="phone" type="tel" placeholder="Mobile (optional)" maxlength="40" value="${esc(s.phone)}" aria-label="Mobile, optional"></div>
        </div>
        <div class="group" style="margin-top:18px">
          <div class="row"><input name="dish" placeholder="What you\u2019re bringing" maxlength="160" value="${esc(s.dish)}" aria-label="What you're bringing"></div>
          <div class="row stack"><textarea name="note" placeholder="Note (optional)" maxlength="500" aria-label="Note">${esc(s.note)}</textarea></div>
        </div>
        <div id="sheet-msg"></div>
      </div></form>`);
    const f = $sheet.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f)), btn = f.querySelector('button[type=submit]'), msg = f.querySelector('#sheet-msg');
      btn.disabled = true;
      try {
        const r = await api('PUT', `/public/meal-signup/${S.manageToken}`, v);
        S.train = r.train; S.mine = r.slot; S.details = r.details; S.publicToken = r.token;
        closeSheet(); renderDone(false); toast(v.date !== s.date ? `Moved to ${fmtLong(r.slot.date)}` : 'Saved');
      } catch (ex) { btn.disabled = false; msg.innerHTML = `<div class="form-error">${esc(ex.message)}</div>`; }
    });
  }
  function renderGone(message, backToken) {
    $app.innerHTML = `${header(S.train)}<main class="page mt-page fade-in"><section class="mt-hero"><div class="mt-icon">${I.meal}</div><h1>${esc(message)}</h1>
      ${backToken ? `<div class="actions" style="max-width:320px;margin:22px auto 0"><a class="btn block" href="/m/${esc(backToken)}">See the Meal Train</a></div>` : ''}</section></main>`;
  }
  function downloadIcs() {
    const t = S.train, s = S.mine, d = S.details || {};
    const u = (x) => x.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    let when;
    if (t.dropStart) {
      const start = zoned(s.date, t.dropStart, t.tz), end = t.dropEnd ? zoned(s.date, t.dropEnd, t.tz) : new Date(start.getTime() + 3600e3);
      when = `DTSTART:${u(start)}\r\nDTEND:${u(end > start ? end : new Date(start.getTime() + 3600e3))}`;
    } else {
      const nd = new Date(parseYmd(s.date).getTime() + 864e5 + 3600e3);
      when = `DTSTART;VALUE=DATE:${s.date.replace(/-/g, '')}\r\nDTEND;VALUE=DATE:${nd.getFullYear()}${pad(nd.getMonth() + 1)}${pad(nd.getDate())}`;
    }
    const e = (x) => String(x || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
    const desc = [`Bringing: ${s.dish}`, t.headcount && `Serving: ${t.headcount}`, t.dietary && `Allergies & food notes: ${t.dietary}`, t.note && `About: ${t.note}`, t.instructions && `Drop-off: ${t.instructions}`, d.contactPhone && `Phone: ${d.contactPhone}`, location.href].filter(Boolean).join('\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Groups//Meal Train//EN', 'BEGIN:VEVENT', `UID:meal-${s.date}-${S.manageToken.slice(0, 12)}@groups`,
      `DTSTAMP:${u(new Date())}`, when, `SUMMARY:${e('Meal for ' + t.recipient)}`, d.address ? `LOCATION:${e(d.address)}` : '', `DESCRIPTION:${e(desc)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', `DESCRIPTION:${e('Meal for ' + t.recipient)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = 'meal-train.ics';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- sheet plumbing ----------
  function openSheet(html) {
    $sheet.innerHTML = `<div class="backdrop" data-act="backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.style.overflow = 'hidden';
    const first = $sheet.querySelector('input:not([type=hidden]):not([name=website])');
    if (first && !first.value && matchMedia('(min-width: 761px)').matches) setTimeout(() => first.focus(), 60);
  }
  function closeSheet() { $sheet.innerHTML = ''; document.body.style.overflow = ''; }
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const a = el.dataset.act;
    if (a === 'backdrop' && ev.target !== el) return;
    if (a === 'signup') signupSheet(el.dataset.date);
    else if (a === 'close' || a === 'backdrop') closeSheet();
    else if (a === 'ics') downloadIcs();
    else if (a === 'edit') editSheet();
    else if (a === 'cancel') {
      if (!(await ask({ title: 'Cancel your sign-up?', message: `You won\u2019t be bringing a meal on ${fmtLong(S.mine.date)}. The coordinator will be told.`, ok: 'Cancel Sign-up', destructive: true }))) return;
      try {
        const r = await api('DELETE', `/public/meal-signup/${S.manageToken}`);
        store.del('mt:' + r.token);
        renderGone('Your sign-up was cancelled. Thanks for letting the family know.', r.token);
      } catch (ex) { toast(ex.message); }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $sheet.innerHTML) closeSheet(); });

  // ---------- boot ----------
  (async () => {
    try {
      if (!TOKEN) throw new Error('This link is missing part of its address. Ask the coordinator to send it again.');
      if (MODE === 'manage') {
        const r = await api('GET', `/public/meal-signup/${TOKEN}`);
        S.train = r.train; S.mine = r.slot; S.details = r.details; S.publicToken = r.token;
        store.set('mt:' + r.token, TOKEN);
        document.title = `Your meal · ${r.train.recipient}`;
        renderDone(false);
      } else {
        S.train = (await api('GET', `/public/meals/${TOKEN}`)).train;
        document.title = S.train.title;
        const mine = store.get('mt:' + TOKEN);
        if (mine) { try { S.mine = (await api('GET', `/public/meal-signup/${mine}`)).slot; } catch { store.del('mt:' + TOKEN); } }
        renderTrain();
        const want = new URLSearchParams(location.search).get('date');
        if (want && S.train.status === 'open' && S.train.dates.some((d) => d.date === want && !d.taken && !d.past)) signupSheet(want);
      }
    } catch (ex) {
      $app.innerHTML = `<main class="page mt-page"><section class="mt-hero"><div class="mt-icon">${I.meal}</div><h1>Meal train unavailable</h1><div class="sub">${esc(ex.message)}</div></section></main>`;
    }
  })();
})();
