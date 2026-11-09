// Small Group Scheduler — Netlify Function (all /api/* routes)
// Storage: Netlify Blobs · Passwords: scrypt · Email: Resend HTTP API
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const env = (k, d = '') => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);
const APP_NAME = () => env('APP_NAME', 'Small Group');
const APP_URL = () => (env('APP_URL') || env('URL') || 'http://localhost:8888').replace(/\/$/, '');
const GROUP_CODE = () => env('GROUP_CODE').trim();
const RESEND_API_KEY = () => env('RESEND_API_KEY');
const EMAIL_FROM = () => env('EMAIL_FROM') || `${APP_NAME()} <onboarding@resend.dev>`;
const SESSION_DAYS = 60;

export const config = { path: '/api/*' };

// ---------- Storage ----------
let _store;
const store = () => (_store ||= getStore({ name: 'smallgroup', consistency: 'strong' }));
const get = (key) => store().get(key, { type: 'json' });
const put = (key, val) => store().setJSON(key, val);
const del = (key) => store().delete(key);
async function listAll(prefix) {
  const { blobs } = await store().list({ prefix });
  const vals = await Promise.all(blobs.map((b) => get(b.key)));
  return vals.filter(Boolean);
}
const newId = () => crypto.randomBytes(9).toString('base64url');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();

// ---------- Helpers ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = (s) => s === '' || (typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s));
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function parseCost(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new HttpError(400, 'Cost must be a positive number.');
  return Math.round(n * 100) / 100;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(pw, salt, 64, SCRYPT).toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  return crypto.timingSafeEqual(expected, crypto.scryptSync(pw, Buffer.from(s, 'base64'), expected.length, SCRYPT));
}
let _dummy;
const dummyHash = () => (_dummy ||= hashPassword('not-a-real-password'));

function cookie(value, maxAge, secure) {
  return `sg_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function sessionToken(req) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sg_session') return v.join('=');
  }
  return '';
}
async function createSession(ctx, userId) {
  const token = newToken();
  await put(`sessions/${token}`, { userId, expiresAt: Date.now() + SESSION_DAYS * 864e5 });
  ctx.setCookie = cookie(token, SESSION_DAYS * 86400, ctx.secure);
}
async function currentUser(req) {
  const token = sessionToken(req);
  if (!token || !/^[\w-]+$/.test(token)) return null;
  const s = await get(`sessions/${token}`);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { await del(`sessions/${token}`); return null; }
  const u = await get(`users/${s.userId}`);
  return u ? { ...u, token } : null;
}
async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in.');
  return u;
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, isAdmin: !!u.isAdmin, notify: u.notify !== false });
const canModify = (u, ownerId) => u.isAdmin || u.id === ownerId;

// Best-effort rate limiting (per function instance)
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
  if (arr.length > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ---------- Email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, mi] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const fmtCost = (c) => (c === null || c === undefined ? '' : c === 0 ? 'Free' : `$${Number(c).toFixed(c % 1 ? 2 : 0)}`);

function emailShell(heading, bodyHtml, ctaText, ctaUrl) {
  return `<!doctype html><html><body style="margin:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden">
    <tr><td style="padding:28px 28px 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8e8e93">${esc(APP_NAME())}</td></tr>
    <tr><td style="padding:0 28px;font-size:24px;font-weight:700;line-height:1.25">${heading}</td></tr>
    <tr><td style="padding:16px 28px 8px;font-size:16px;line-height:1.5">${bodyHtml}</td></tr>
    <tr><td style="padding:16px 28px 30px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#007aff;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 22px;border-radius:12px">${esc(ctaText)}</a></td></tr>
  </table>
  <p style="font-size:12px;color:#8e8e93;margin:16px 0 0">You're receiving this as a member of ${esc(APP_NAME())}. You can turn these emails off from your profile.</p>
  </td></tr></table></body></html>`;
}
const detailRows = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 4px;font-size:15px">` +
  rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:6px 0;color:#8e8e93;width:90px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;white-space:pre-line">${esc(v)}</td></tr>`).join('') + `</table>`;

async function logEmail(subject, recipients, status, detail = '') {
  const at = now();
  try { await put(`emaillog/${at}-${newId()}`, { subject, recipients, status, detail, at }); } catch {}
}
async function sendEmail({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) return;
  const key = RESEND_API_KEY();
  if (!key) {
    console.log(`[email:not-configured] "${subject}" → ${recipients.length} recipient(s)`);
    return logEmail(subject, recipients.length, 'skipped', 'RESEND_API_KEY is not set');
  }
  try {
    for (let i = 0; i < recipients.length; i += 100) { // one message per person keeps addresses private
      const batch = recipients.slice(i, i + 100).map((addr) => ({ from: EMAIL_FROM(), to: [addr], subject, html, text }));
      const r = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    await logEmail(subject, recipients.length, 'sent');
  } catch (err) {
    console.error('[email] failed:', err.message);
    await logEmail(subject, recipients.length, 'failed', err.message);
  }
}
async function notifyAll(ctx, subject, html, text) {
  const users = await listAll('users/');
  const to = users.filter((u) => u.notify !== false).map((u) => u.email);
  ctx.background(sendEmail({ to, subject, html, text }));
}
function notifyNewEvent(ctx, ev, byName, viaPoll) {
  const when = `${fmtDate(ev.date)}${ev.time ? ' at ' + fmtTime(ev.time) : ''}`;
  const link = `${APP_URL()}/#calendar/${ev.date}`;
  const intro = `<p style="margin:0 0 8px">${esc(byName)} ${viaPoll ? 'picked the final date from the poll' : 'added an event to the calendar'}.</p>`;
  return notifyAll(ctx,
    `${viaPoll ? 'Scheduled' : 'New event'}: ${ev.title} — ${when}`,
    emailShell(`${viaPoll ? 'It’s on the calendar' : 'New event'}: ${esc(ev.title)}`,
      intro + detailRows([['When', when], ['Where', ev.location], ['Cost', fmtCost(ev.cost)], ['Details', ev.description]]), 'Open calendar', link),
    `${byName} ${viaPoll ? 'scheduled' : 'added'} "${ev.title}" for ${when}.${ev.location ? '\nWhere: ' + ev.location : ''}${ev.description ? '\n\n' + ev.description : ''}\n\n${link}`);
}
function notifyNewPoll(ctx, poll, byName) {
  const link = `${APP_URL()}/#polls/${poll.id}`;
  const list = poll.options.map((o) => `<li style="margin:2px 0">${esc(fmtDate(o.date))}${o.time ? ' · ' + esc(fmtTime(o.time)) : ''}</li>`).join('');
  return notifyAll(ctx,
    `New poll: ${poll.title} — please vote`,
    emailShell(`Help pick a date: ${esc(poll.title)}`,
      `<p style="margin:0 0 8px">${esc(byName)} wants to find a time that works for everyone. Mark the dates you can make.</p>` +
      detailRows([['Where', poll.location], ['Cost', fmtCost(poll.cost)], ['Details', poll.description]]) +
      `<p style="margin:10px 0 4px;color:#8e8e93;font-size:14px">Proposed times</p><ul style="margin:0;padding-left:20px">${list}</ul>`, 'Vote now', link),
    `${byName} created a poll: "${poll.title}". Vote here: ${link}`);
}

// ---------- Data shaping ----------
async function nameMap() {
  const m = {};
  for (const u of await listAll('users/')) m[u.id] = u.name;
  return m;
}
const eventOut = (e, names) => ({ ...e, createdByName: names[e.createdBy] || 'Former member' });
async function pollOut(p, names) {
  const votes = await listAll(`votes/${p.id}/`); // one record per person: { userId, answers: {optionId: 'yes'|'maybe'|'no'}, at }
  const options = p.options.map((o) => ({
    ...o,
    votes: votes.filter((v) => v.answers[o.id]).map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', answer: v.answers[o.id], at: v.at })),
  }));
  const responders = votes.filter((v) => Object.keys(v.answers).length)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', at: v.at }));
  return { ...p, options, responders, createdByName: names[p.createdBy] || 'Former member' };
}

function readEventBody(body) {
  const title = str(body.title, 120), description = str(body.description, 4000), location = str(body.location, 200);
  const date = str(body.date, 10), time = str(body.time, 5);
  if (!title) throw new HttpError(400, 'Please add a title.');
  if (!isDate(date)) throw new HttpError(400, 'Please choose a date.');
  if (!isTime(time)) throw new HttpError(400, 'Please choose a valid time.');
  return { title, description, location, date, time, cost: parseCost(body.cost) };
}
const validId = (id) => { if (!/^[\w-]{1,40}$/.test(id)) throw new HttpError(404, 'Not found.'); return id; };

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^/api' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/config', () => ({ appName: APP_NAME(), requireCode: !!GROUP_CODE() }));

route('POST', '/register', async ({ body, ctx }) => {
  rateLimit('reg:' + ctx.ip, 10, 15 * 60e3);
  const name = str(body.name, 80), email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const code = GROUP_CODE();
  if (code && str(body.code).toLowerCase() !== code.toLowerCase()) throw new HttpError(403, 'That group code isn’t right. Ask your group leader for it.');
  if (await get(`emails/${email}`)) throw new HttpError(409, 'An account with that email already exists. Try signing in.');
  const { blobs } = await store().list({ prefix: 'users/' });
  const user = { id: newId(), name, email, pwHash: hashPassword(password), isAdmin: blobs.length === 0, notify: true, createdAt: now() };
  await put(`users/${user.id}`, user);
  await put(`emails/${email}`, { userId: user.id });
  await createSession(ctx, user.id);
  return { ok: true };
});

route('POST', '/login', async ({ body, ctx }) => {
  rateLimit('login:' + ctx.ip, 20, 15 * 60e3);
  const email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const ref = isEmail(email) ? await get(`emails/${email}`) : null;
  const u = ref ? await get(`users/${ref.userId}`) : null;
  const ok = verifyPassword(password, u ? u.pwHash : dummyHash());
  if (!u || !ok) throw new HttpError(401, 'Email or password is incorrect.');
  await createSession(ctx, u.id);
  return { ok: true };
});

route('POST', '/logout', async ({ req, ctx }) => {
  const token = sessionToken(req);
  if (token && /^[\w-]+$/.test(token)) await del(`sessions/${token}`);
  ctx.setCookie = cookie('', 0, ctx.secure);
  return { ok: true };
});

route('POST', '/forgot', async ({ body, ctx }) => {
  rateLimit('forgot:' + ctx.ip, 5, 15 * 60e3);
  const email = str(body.email, 200).toLowerCase();
  const ref = isEmail(email) ? await get(`emails/${email}`) : null;
  const u = ref ? await get(`users/${ref.userId}`) : null;
  if (u) {
    const token = newToken();
    await put(`resets/${token}`, { userId: u.id, expiresAt: Date.now() + 3600e3 });
    const link = `${APP_URL()}/#reset/${token}`;
    ctx.background(sendEmail({ to: u.email, subject: `Reset your ${APP_NAME()} password`,
      html: emailShell('Reset your password', `<p style="margin:0">Hi ${esc(u.name)}, tap the button below to choose a new password. The link expires in one hour. If you didn't ask for this, you can ignore this email.</p>`, 'Choose a new password', link),
      text: `Reset your password: ${link} (expires in 1 hour)` }));
  }
  return { ok: true }; // same answer either way, so emails can't be probed
});

route('POST', '/reset', async ({ body, ctx }) => {
  const token = str(body.token, 200), password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const r = /^[\w-]+$/.test(token) ? await get(`resets/${token}`) : null;
  if (!r || r.expiresAt < Date.now()) throw new HttpError(400, 'This reset link has expired. Please request a new one.');
  const u = await get(`users/${r.userId}`);
  if (!u) throw new HttpError(400, 'Account not found.');
  await put(`users/${u.id}`, { ...u, pwHash: hashPassword(password) });
  await del(`resets/${token}`);
  await createSession(ctx, u.id);
  return { ok: true };
});

route('GET', '/me', async ({ req }) => {
  const u = await currentUser(req);
  return { user: u ? publicUser(u) : null };
});

route('PATCH', '/me', async ({ req, body }) => {
  const u = await requireUser(req);
  const next = { ...u }; delete next.token;
  if (typeof body.notify === 'boolean') next.notify = body.notify;
  if (body.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) throw new HttpError(400, 'Name can’t be empty.');
    next.name = name;
  }
  await put(`users/${u.id}`, next);
  return { user: publicUser(next) };
});

route('GET', '/members', async ({ req }) => {
  await requireUser(req);
  const users = await listAll('users/');
  return { members: users.map((u) => ({ id: u.id, name: u.name, isAdmin: !!u.isAdmin, joined: u.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name)) };
});

route('GET', '/events', async ({ req }) => {
  await requireUser(req);
  const [events, names] = await Promise.all([listAll('events/'), nameMap()]);
  return { events: events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((e) => eventOut(e, names)) };
});

route('POST', '/events', async ({ req, body, ctx }) => {
  const u = await requireUser(req);
  const ev = { id: newId(), ...readEventBody(body), createdBy: u.id, pollId: null, createdAt: now() };
  await put(`events/${ev.id}`, ev);
  await notifyNewEvent(ctx, ev, u.name, false);
  return { event: eventOut(ev, { [u.id]: u.name }) };
});

route('PUT', '/events/:id', async ({ req, body, params }) => {
  const u = await requireUser(req);
  const ev = await get(`events/${validId(params.id)}`);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!canModify(u, ev.createdBy)) throw new HttpError(403, 'Only the person who added this event can edit it.');
  const next = { ...ev, ...readEventBody(body), updatedAt: now() };
  await put(`events/${ev.id}`, next);
  return { event: eventOut(next, await nameMap()) };
});

route('DELETE', '/events/:id', async ({ req, params }) => {
  const u = await requireUser(req);
  const ev = await get(`events/${validId(params.id)}`);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!canModify(u, ev.createdBy)) throw new HttpError(403, 'Only the person who added this event can delete it.');
  await del(`events/${ev.id}`);
  if (ev.pollId) { // re-open the poll it came from
    const p = await get(`polls/${ev.pollId}`);
    if (p) await put(`polls/${p.id}`, { ...p, status: 'open', eventId: null, scheduledOptionId: null });
  }
  return { ok: true };
});

route('GET', '/polls', async ({ req }) => {
  await requireUser(req);
  const [polls, names] = await Promise.all([listAll('polls/'), nameMap()]);
  polls.sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
  return { polls: await Promise.all(polls.map((p) => pollOut(p, names))) };
});

route('POST', '/polls', async ({ req, body, ctx }) => {
  const u = await requireUser(req);
  const title = str(body.title, 120);
  if (!title) throw new HttpError(400, 'Please add a title.');
  const seen = new Set(), options = [];
  for (const o of (Array.isArray(body.options) ? body.options : []).slice(0, 30)) {
    const date = str(o?.date, 10), time = str(o?.time, 5);
    if (!isDate(date) || !isTime(time) || seen.has(date + time)) continue;
    seen.add(date + time);
    options.push({ id: newId(), date, time });
  }
  if (options.length < 2) throw new HttpError(400, 'Add at least two date options for people to vote on.');
  options.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const poll = { id: newId(), title, description: str(body.description, 4000), location: str(body.location, 200), cost: parseCost(body.cost),
    options, status: 'open', eventId: null, scheduledOptionId: null, createdBy: u.id, createdAt: now() };
  await put(`polls/${poll.id}`, poll);
  await notifyNewPoll(ctx, poll, u.name);
  return { poll: await pollOut(poll, { [u.id]: u.name }) };
});

route('POST', '/polls/:id/vote', async ({ req, body, params }) => {
  const u = await requireUser(req);
  const poll = await get(`polls/${validId(params.id)}`);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (poll.status !== 'open') throw new HttpError(400, 'This poll is closed — a date has already been picked.');
  const key = `votes/${poll.id}/${u.id}`;
  const mine = (await get(key)) || { userId: u.id, answers: {} };
  const ids = new Set(poll.options.map((o) => o.id));
  for (const [optId, answer] of Object.entries(body?.votes || {})) {
    if (!ids.has(optId)) continue;
    if (answer === null || answer === '') delete mine.answers[optId];
    else if (['yes', 'maybe', 'no'].includes(answer)) mine.answers[optId] = answer;
  }
  mine.at = now();
  if (Object.keys(mine.answers).length) await put(key, mine); else await del(key);
  return { poll: await pollOut(poll, await nameMap()) };
});

route('POST', '/polls/:id/schedule', async ({ req, body, params, ctx }) => {
  const u = await requireUser(req);
  const poll = await get(`polls/${validId(params.id)}`);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!canModify(u, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll can pick the final date.');
  if (poll.status !== 'open') throw new HttpError(400, 'A date has already been picked for this poll.');
  const opt = poll.options.find((o) => o.id === body.optionId);
  if (!opt) throw new HttpError(400, 'Please choose one of the poll’s dates.');
  const ev = { id: newId(), title: poll.title, description: poll.description, date: opt.date, time: opt.time, cost: poll.cost,
    location: poll.location, createdBy: u.id, pollId: poll.id, createdAt: now() };
  await put(`events/${ev.id}`, ev);
  const next = { ...poll, status: 'scheduled', eventId: ev.id, scheduledOptionId: opt.id, scheduledAt: now() };
  await put(`polls/${poll.id}`, next);
  await notifyNewEvent(ctx, ev, u.name, true);
  const names = await nameMap();
  return { poll: await pollOut(next, names), event: eventOut(ev, names) };
});

route('DELETE', '/polls/:id', async ({ req, params }) => {
  const u = await requireUser(req);
  const poll = await get(`polls/${validId(params.id)}`);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!canModify(u, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll can delete it.');
  const { blobs } = await store().list({ prefix: `votes/${poll.id}/` });
  await Promise.all(blobs.map((b) => del(b.key)));
  await del(`polls/${poll.id}`);
  if (poll.eventId) {
    const ev = await get(`events/${poll.eventId}`);
    if (ev) await put(`events/${ev.id}`, { ...ev, pollId: null });
  }
  return { ok: true };
});

route('GET', '/email-log', async ({ req }) => {
  const u = await requireUser(req);
  if (!u.isAdmin) throw new HttpError(403, 'Admins only.');
  const log = (await listAll('emaillog/')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  return { configured: !!RESEND_API_KEY(), log };
});

// ---------- Handler ----------
export default async function handler(req, context = {}) {
  const url = new URL(req.url);
  const pending = [];
  const ctx = {
    ip: context.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '',
    secure: url.protocol === 'https:' || APP_URL().startsWith('https://'),
    setCookie: null,
    background(p) { if (typeof context.waitUntil === 'function') context.waitUntil(p); else pending.push(p); },
  };
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let status = 200, payload;
  try {
    if (req.method !== 'GET' && !(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Expected JSON.');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found.');
    let body = {};
    if (req.method !== 'GET') {
      const text = await req.text();
      if (text.length > 100_000) throw new HttpError(413, 'Request too large.');
      try { body = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
    }
    payload = await r.handler({ req, body, params: url.pathname.match(r.re).groups || {}, ctx });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    status = err.status || 500;
    payload = { error: err instanceof HttpError ? err.message : 'Something went wrong. Please try again.' };
  }
  if (pending.length) await Promise.allSettled(pending); // no waitUntil available: finish emails before responding
  if (ctx.setCookie) headers['Set-Cookie'] = ctx.setCookie;
  return new Response(JSON.stringify(payload), { status, headers });
}
