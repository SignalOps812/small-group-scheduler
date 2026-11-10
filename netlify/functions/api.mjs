// Small Group Scheduler — Netlify Function (all /api/* routes)
// Storage: Netlify Blobs · Passwords: scrypt · Email: Resend HTTP API
//
// Key layout (store "smallgroup"):
//   users/<uid>                    { id, name, email, pwHash, notify, groups: [gid], createdAt }
//   emails/<email>                 { userId }
//   sessions/<token>, resets/<token>
//   groups/<gid>                   { id, name, code, createdBy, createdAt }
//   codes/<code>                   { groupId }
//   names/<sha256(normalized name)> { groupId }   — keeps group names unique
//   g/<gid>/members/<uid>          { userId, role: 'organizer'|'member', joinedAt }
//   g/<gid>/events/<id>, g/<gid>/polls/<id>, g/<gid>/votes/<pollId>/<uid>, g/<gid>/emaillog/<ts>
//   g/<gid>/prayer/<id>             { id, title, description, createdBy, createdAt, updatedAt, lastActivity }
//   g/<gid>/prayerc/<prayerId>/<cid> { id, userId, text, at, editedAt }
//   g/<gid>/bring/<p|e>-<id>/<uid>  { target, userId, items: [{ item, category }], at }   — pitch-in sign-ups
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const env = (k, d = '') => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? d);
const APP_NAME = () => env('APP_NAME', 'Groups');
const APP_URL = () => (env('APP_URL') || env('URL') || 'http://localhost:8888').replace(/\/$/, '');
const RESEND_API_KEY = () => env('RESEND_API_KEY');
const EMAIL_FROM = () => env('EMAIL_FROM') || `${APP_NAME()} <onboarding@resend.dev>`;
const SESSION_DAYS = 60;

export const config = { path: '/api/*' };

// ---------- Storage ----------
// Create the store per request: Netlify gives each invocation a fresh, short-lived
// access token, so a store cached across invocations eventually fails with "Token expired".
let _store = null;
const store = () => (_store ||= getStore({ name: 'smallgroup', consistency: 'strong' }));
const get = (key) => store().get(key, { type: 'json' });
const put = (key, val) => store().setJSON(key, val);
const del = (key) => store().delete(key);
const keys = async (prefix) => (await store().list({ prefix })).blobs.map((b) => b.key);
async function listAll(prefix) {
  const vals = await Promise.all((await keys(prefix)).map((k) => get(k)));
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
const validId = (id) => { if (!/^[\w-]{1,40}$/.test(id)) throw new HttpError(404, 'Not found.'); return id; };
function parseCost(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new HttpError(400, 'Cost must be a positive number.');
  return Math.round(n * 100) / 100;
}
// "Men's  Breakfast" and "mens breakfast" count as the same name
const normName = (n) => String(n).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const nameKey = (n) => `names/${crypto.createHash('sha256').update(normName(n)).digest('hex').slice(0, 40)}`;
async function claimName(name, gid) {
  if (!normName(name)) throw new HttpError(400, 'Group names need at least one letter or number.');
  const k = nameKey(name);
  const taken = await get(k);
  if (taken && taken.groupId !== gid && (await get(`groups/${taken.groupId}`))) {
    throw new HttpError(409, 'There\u2019s already a group with that name. Try adding something to make it unique, like your church or town.');
  }
  return k;
}
// Optional phone: returns '' (none), an E.164 string (+18125551234), or throws.
function parsePhone(v) {
  const raw = str(v, 40);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  let e164;
  if (raw.trim().startsWith('+')) e164 = '+' + digits;
  else if (digits.length === 10) e164 = '+1' + digits;            // US/Canada without country code
  else if (digits.length === 11 && digits[0] === '1') e164 = '+' + digits;
  else e164 = '+' + digits;
  if (!/^\+[1-9]\d{7,14}$/.test(e164) || (e164.startsWith('+1') && e164.length !== 12)) {
    throw new HttpError(400, 'That phone number doesn\u2019t look right. Use a 10-digit number like (812) 555-0123.');
  }
  return e164;
}
// Each person's own email choices (all on by default); the group's settings still apply on top
const USER_NOTIFY_KEYS = ['event', 'scheduled', 'poll', 'prayer', 'prayerComment'];
const userPrefs = (u) => Object.fromEntries(USER_NOTIFY_KEYS.map((k) => [k, (u.notifyPrefs || {})[k] !== false]));
const userOut = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || '', notify: u.notify !== false, notifyPrefs: userPrefs(u), tourDone: !!u.tourDone });
const normCode = (c) => str(c, 60).toLowerCase().replace(/\s+/g, '-');
function checkCode(code) {
  if (!/^[a-z0-9][a-z0-9-]{2,22}[a-z0-9]$/.test(code)) {
    throw new HttpError(400, 'Group codes are 4–24 characters: letters, numbers and dashes.');
  }
  return code;
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
  return u ? { ...u, groups: u.groups || [] } : null;
}
async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) throw new HttpError(401, 'Please sign in.');
  return u;
}
async function saveUser(u) { const { token, ...rest } = u; await put(`users/${u.id}`, rest); }

// Membership check: returns { user, group, member }
async function requireMember(req, gid) {
  const user = await requireUser(req);
  validId(gid);
  const [group, member] = await Promise.all([get(`groups/${gid}`), get(`g/${gid}/members/${user.id}`)]);
  if (!group || !member) throw new HttpError(403, 'You’re not a member of this group.');
  return { user, group, member, organizer: member.role === 'organizer' };
}
const canModify = (m, ownerId) => m.organizer || m.user.id === ownerId;

// Optional features organizers can switch on/off per group
const FEATURE_DEFAULTS = { members: true, prayer: false };
const featuresOf = (g) => ({ ...FEATURE_DEFAULTS, ...(g.features || {}) });
function requireFeature(m, f) {
  if (!featuresOf(m.group)[f]) throw new HttpError(403, 'That feature is turned off for this group.');
}
// Which group emails go out; organizers control each type
const NOTIFY_DEFAULTS = { event: true, scheduled: true, poll: true, prayer: true, prayerComment: false };
const notifyOf = (g) => ({ ...NOTIFY_DEFAULTS, ...(g.notifications || {}) });
async function groupSummary(gid, uid) {
  const [g, m, memberKeys] = await Promise.all([get(`groups/${gid}`), get(`g/${gid}/members/${uid}`), keys(`g/${gid}/members/`)]);
  if (!g || !m) return null;
  return { id: g.id, name: g.name, code: g.code, role: m.role, memberCount: memberKeys.length, features: featuresOf(g), notifications: notifyOf(g), createdAt: g.createdAt };
}
async function myGroups(u) {
  return (await Promise.all(u.groups.map((gid) => groupSummary(gid, u.id)))).filter(Boolean);
}
async function addMember(u, gid, role) {
  await put(`g/${gid}/members/${u.id}`, { userId: u.id, role, joinedAt: now() });
  if (!u.groups.includes(gid)) { u.groups = [...u.groups, gid]; await saveUser(u); }
}

// Best-effort rate limiting (per function instance)
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
  if (arr.length > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ---------- One-time migration from the single-group version ----------
let migrated = false;
async function migrateLegacy() {
  if (migrated) return;
  if (await get('meta/v3')) { migrated = true; return; }
  if (!(await get('meta/v2'))) await migrateV2();
  if (!(await get('meta/v3'))) { // index existing group names (first one keeps a duplicated name)
    const groups = (await listAll('groups/')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const g of groups) { const k = nameKey(g.name); if (!(await get(k))) await put(k, { groupId: g.id }); }
    await put('meta/v3', { at: now() });
  }
  migrated = true;
}
async function migrateV2() {
  const [legacyEvents, legacyPolls, users] = await Promise.all([keys('events/'), keys('polls/'), listAll('users/')]);
  const legacyUsers = users.filter((u) => !u.groups);
  if (legacyUsers.length || legacyEvents.length || legacyPolls.length) {
    const gid = newId();
    let code = 'group-' + crypto.randomBytes(3).toString('hex');
    await put(`groups/${gid}`, { id: gid, name: APP_NAME(), code, createdBy: (legacyUsers.find((u) => u.isAdmin) || legacyUsers[0] || {}).id || null, createdAt: now() });
    await put(`codes/${code}`, { groupId: gid });
    for (const u of legacyUsers) {
      await put(`g/${gid}/members/${u.id}`, { userId: u.id, role: u.isAdmin ? 'organizer' : 'member', joinedAt: u.createdAt || now() });
      const { isAdmin, ...rest } = u;
      await put(`users/${u.id}`, { ...rest, groups: [gid] });
    }
    for (const k of legacyEvents) { const v = await get(k); if (v) await put(`g/${gid}/${k}`, v); await del(k); }
    for (const k of legacyPolls) { const v = await get(k); if (v) await put(`g/${gid}/${k}`, v); await del(k); }
    for (const k of await keys('votes/')) { const v = await get(k); if (v) await put(`g/${gid}/${k}`, v); await del(k); }
    for (const k of await keys('emaillog/')) await del(k);
  }
  await put('meta/v2', { at: now() });
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

function emailShell(label, heading, bodyHtml, ctaText, ctaUrl, footer) {
  return `<!doctype html><html><body style="margin:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1c1e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden">
    <tr><td style="padding:28px 28px 8px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8e8e93">${esc(label)}</td></tr>
    <tr><td style="padding:0 28px;font-size:24px;font-weight:700;line-height:1.25">${heading}</td></tr>
    <tr><td style="padding:16px 28px 8px;font-size:16px;line-height:1.5">${bodyHtml}</td></tr>
    <tr><td style="padding:16px 28px 30px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#007aff;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 22px;border-radius:12px">${esc(ctaText)}</a></td></tr>
  </table>
  <p style="font-size:12px;color:#8e8e93;margin:16px 0 0">${esc(footer)}</p>
  </td></tr></table></body></html>`;
}
const detailRows = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:6px 0 4px;font-size:15px">` +
  rows.filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:6px 0;color:#8e8e93;width:90px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;white-space:pre-line">${esc(v)}</td></tr>`).join('') + `</table>`;

async function logEmail(gid, subject, recipients, status, detail = '') {
  if (!gid) return;
  const at = now();
  try { await put(`g/${gid}/emaillog/${at}-${newId()}`, { subject, recipients, status, detail, at }); } catch {}
}
async function sendEmail({ to, subject, html, text, gid }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) return;
  const key = RESEND_API_KEY();
  if (!key) {
    console.log(`[email:not-configured] "${subject}" → ${recipients.length} recipient(s)`);
    return logEmail(gid, subject, recipients.length, 'skipped', 'RESEND_API_KEY is not set');
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
    await logEmail(gid, subject, recipients.length, 'sent');
  } catch (err) {
    console.error('[email] failed:', err.message);
    await logEmail(gid, subject, recipients.length, 'failed', err.message);
  }
}
async function notifyGroup(type, ctx, group, subject, heading, body, ctaText, ctaUrl, text, excludeId) {
  const memberIds = (await keys(`g/${group.id}/members/`)).map((k) => k.split('/').pop()).filter((id) => id !== excludeId);
  const users = await Promise.all(memberIds.map((id) => get(`users/${id}`)));
  const to = users.filter((u) => u && u.notify !== false && userPrefs(u)[type]).map((u) => u.email);
  const html = emailShell(group.name, heading, body, ctaText, ctaUrl,
    `You're receiving this as a member of ${group.name}. You can choose which emails you get from your profile.`);
  ctx.background(sendEmail({ to, subject: `[${group.name}] ${subject}`, html, text, gid: group.id }));
}
const deepLink = (gid, hash) => `${APP_URL()}/?g=${encodeURIComponent(gid)}#${hash}`;

function notifyNewEvent(ctx, group, ev, byName, viaPoll) {
  if (!notifyOf(group)[viaPoll ? 'scheduled' : 'event']) return;
  const when = `${fmtDate(ev.date)}${ev.time ? ' at ' + fmtTime(ev.time) : ''}`;
  const link = deepLink(group.id, `calendar/${ev.date}`);
  const intro = `<p style="margin:0 0 8px">${esc(byName)} ${viaPoll ? 'picked the final date from the poll' : 'added an event to the calendar'}.</p>` +
    (ev.pitchIn ? `<p style="margin:0 0 8px"><b>It\u2019s a pitch-in.</b> Open the event to see who\u2019s bringing what and add your dish.</p>` : '');
  return notifyGroup(viaPoll ? 'scheduled' : 'event', ctx, group,
    `${viaPoll ? 'Scheduled' : 'New event'}: ${ev.title} — ${when}`,
    `${viaPoll ? 'It’s on the calendar' : 'New event'}: ${esc(ev.title)}`,
    intro + detailRows([['When', when], ['Where', ev.location], ['Cost', fmtCost(ev.cost)], ['Details', ev.description]]),
    'Open calendar', link,
    `${byName} ${viaPoll ? 'scheduled' : 'added'} "${ev.title}" for ${when}.${ev.location ? '\nWhere: ' + ev.location : ''}${ev.description ? '\n\n' + ev.description : ''}\n\n${link}`);
}
function notifyNewPoll(ctx, group, poll, byName) {
  if (!notifyOf(group).poll) return;
  const link = deepLink(group.id, `polls/${poll.id}`);
  const list = poll.options.map((o) => `<li style="margin:2px 0">${esc(fmtDate(o.date))}${o.time ? ' · ' + esc(fmtTime(o.time)) : ''}</li>`).join('');
  return notifyGroup('poll', ctx, group,
    `New poll: ${poll.title} — please vote`,
    `Help pick a date: ${esc(poll.title)}`,
    `<p style="margin:0 0 8px">${esc(byName)} wants to find a time that works for everyone. Mark the dates you can make${poll.pitchIn ? ', and say what you\u2019ll bring to the pitch-in' : ''}.</p>` +
      detailRows([['Where', poll.location], ['Cost', fmtCost(poll.cost)], ['Details', poll.description]]) +
      `<p style="margin:10px 0 4px;color:#8e8e93;font-size:14px">Proposed times</p><ul style="margin:0;padding-left:20px">${list}</ul>`,
    'Vote now', link,
    `${byName} created a poll: "${poll.title}". Vote here: ${link}`);
}

function notifyNewPrayer(ctx, group, pr, byName) {
  if (!notifyOf(group).prayer) return;
  const link = deepLink(group.id, `prayer/${pr.id}`);
  return notifyGroup('prayer', ctx, group,
    `Prayer request: ${pr.title}`,
    `Prayer request: ${esc(pr.title)}`,
    `<p style="margin:0 0 8px">${esc(byName)} shared a prayer request with the group.</p>` +
      (pr.description ? `<p style="margin:0 0 8px;white-space:pre-line">${esc(pr.description)}</p>` : ''),
    'Open request', link,
    `${byName} shared a prayer request: "${pr.title}"${pr.description ? '\n\n' + pr.description : ''}\n\n${link}`);
}

function notifyPrayerComment(ctx, group, pr, comment, by) {
  if (!notifyOf(group).prayerComment) return;
  const link = deepLink(group.id, `prayer/${pr.id}`);
  const isUpdate = by.id === pr.createdBy;
  return notifyGroup('prayerComment', ctx, group,
    `${isUpdate ? 'Update' : 'New comment'}: ${pr.title}`,
    `${isUpdate ? 'Prayer update' : 'New comment'}: ${esc(pr.title)}`,
    `<p style="margin:0 0 8px">${esc(by.name)} ${isUpdate ? 'posted an update' : 'commented'}:</p><p style="margin:0 0 8px;white-space:pre-line">${esc(comment.text)}</p>`,
    'Open request', link,
    `${by.name} ${isUpdate ? 'posted an update on' : 'commented on'} "${pr.title}":\n\n${comment.text}\n\n${link}`, by.id);
}

// ---------- Data shaping ----------
async function nameMap(gid) {
  const ids = (await keys(`g/${gid}/members/`)).map((k) => k.split('/').pop());
  const users = await Promise.all(ids.map((id) => get(`users/${id}`)));
  const m = {};
  for (const u of users) if (u) m[u.id] = u.name;
  return m;
}
// ---------- Pitch-in ----------
const BRING_CATS = ['Main dish', 'Side dish', 'Salad', 'Bread', 'Dessert', 'Drinks', 'Supplies', 'Other'];
const bringPrefix = (gid, target) => `g/${gid}/bring/${target}/`;
const contribItems = (c) => (Array.isArray(c.items) ? c.items : c.item ? [{ item: c.item, category: c.category }] : []);
const contribOut = (c, names) => ({ userId: c.userId, name: names[c.userId] || 'Former member', items: contribItems(c), at: c.at });
async function contributions(gid, target, names) {
  return (await listAll(bringPrefix(gid, target))).sort((a, b) => a.at.localeCompare(b.at)).map((c) => contribOut(c, names));
}
async function saveContribution(gid, target, uid, body) {
  const key = bringPrefix(gid, target) + uid;
  const raw = Array.isArray(body?.items) ? body.items : [{ item: body?.item, category: body?.category }];
  const items = raw.slice(0, 15)
    .map((x) => ({ item: str(x?.item, 200), category: BRING_CATS.includes(x?.category) ? x.category : 'Other' }))
    .filter((x) => x.item);
  if (!items.length) { await del(key); return; }
  await put(key, { target, userId: uid, items, at: now() });
}
async function clearContributions(gid, target) {
  await Promise.all((await keys(bringPrefix(gid, target))).map((k) => del(k)));
}

const eventOut = (e, names, contribs) => ({ ...e, pitchIn: !!e.pitchIn, createdByName: names[e.createdBy] || 'Former member',
  ...(e.pitchIn ? { contributions: (contribs || []).map((c) => contribOut(c, names)).sort((a, b) => a.at.localeCompare(b.at)) } : {}) });
async function eventOutOne(gid, e, names) {
  return eventOut(e, names, e.pitchIn ? await listAll(bringPrefix(gid, `e-${e.id}`)) : []);
}
async function pollOut(gid, p, names) {
  const votes = await listAll(`g/${gid}/votes/${p.id}/`);
  const options = p.options.map((o) => ({
    ...o,
    votes: votes.filter((v) => v.answers[o.id]).map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', answer: v.answers[o.id], at: v.at })),
  }));
  const responders = votes.filter((v) => Object.keys(v.answers).length)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', at: v.at }));
  return { ...p, pitchIn: !!p.pitchIn, options, responders, createdByName: names[p.createdBy] || 'Former member',
    ...(p.pitchIn ? { contributions: await contributions(gid, `p-${p.id}`, names) } : {}) };
}
function readEventBody(body) {
  const title = str(body.title, 120), description = str(body.description, 4000), location = str(body.location, 200);
  const date = str(body.date, 10), time = str(body.time, 5);
  if (!title) throw new HttpError(400, 'Please add a title.');
  if (!isDate(date)) throw new HttpError(400, 'Please choose a date.');
  if (!isTime(time)) throw new HttpError(400, 'Please choose a valid time.');
  return { title, description, location, date, time, cost: parseCost(body.cost), pitchIn: !!body.pitchIn };
}

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp('^/api' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/config', () => ({ appName: APP_NAME() }));

// --- Accounts ---
route('POST', '/register', async ({ body, ctx }) => {
  rateLimit('reg:' + ctx.ip, 10, 15 * 60e3);
  const name = str(body.name, 80), email = str(body.email, 200).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (await get(`emails/${email}`)) throw new HttpError(409, 'An account with that email already exists. Try signing in.');
  const phone = parsePhone(body.phone);
  const user = { id: newId(), name, email, phone, pwHash: hashPassword(password), notify: true, groups: [], createdAt: now() };
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
      html: emailShell(APP_NAME(), 'Reset your password', `<p style="margin:0">Hi ${esc(u.name)}, tap the button below to choose a new password. The link expires in one hour. If you didn't ask for this, you can ignore this email.</p>`, 'Choose a new password', link, `Sent by ${APP_NAME()}.`),
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
  if (!u) return { user: null, groups: [] };
  return { user: userOut(u), groups: await myGroups(u) };
});

route('PATCH', '/me', async ({ req, body }) => {
  const u = await requireUser(req);
  if (typeof body.notify === 'boolean') u.notify = body.notify;
  if (typeof body.tourDone === 'boolean') u.tourDone = body.tourDone ? now() : null;
  if (body.notifyPrefs && typeof body.notifyPrefs === 'object') {
    const next = userPrefs(u);
    for (const k of USER_NOTIFY_KEYS) if (typeof body.notifyPrefs[k] === 'boolean') next[k] = body.notifyPrefs[k];
    u.notifyPrefs = next;
  }
  if (body.phone !== undefined) u.phone = parsePhone(body.phone);
  if (body.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) throw new HttpError(400, 'Name can’t be empty.');
    u.name = name;
  }
  await saveUser(u);
  return { user: userOut(u) };
});

// --- Groups ---
route('POST', '/groups', async ({ req, body }) => {
  const u = await requireUser(req);
  const name = str(body.name, 60);
  if (!name) throw new HttpError(400, 'Please give your group a name.');
  const code = checkCode(normCode(body.code));
  if (u.groups.length >= 25) throw new HttpError(400, 'You’ve reached the limit of 25 groups.');
  const gid = newId();
  const nk = await claimName(name, gid);
  if (await get(`codes/${code}`)) throw new HttpError(409, 'That code is already taken. Try another one.');
  const group = { id: gid, name, code, createdBy: u.id, createdAt: now() };
  await put(nk, { groupId: gid });
  await put(`groups/${group.id}`, group);
  await put(`codes/${code}`, { groupId: group.id });
  await addMember(u, group.id, 'organizer');
  return { group: await groupSummary(group.id, u.id) };
});

route('POST', '/groups/join', async ({ req, body, ctx }) => {
  const u = await requireUser(req);
  rateLimit('join:' + u.id, 10, 15 * 60e3);
  rateLimit('joinip:' + ctx.ip, 30, 15 * 60e3);
  const code = normCode(body.code);
  const ref = code ? await get(`codes/${code}`) : null;
  const group = ref ? await get(`groups/${ref.groupId}`) : null;
  if (!group) throw new HttpError(404, 'We couldn’t find a group with that code. Check it with your group leader.');
  if (await get(`g/${group.id}/members/${u.id}`)) return { group: await groupSummary(group.id, u.id), already: true };
  await addMember(u, group.id, 'member');
  return { group: await groupSummary(group.id, u.id) };
});

route('PATCH', '/groups/:gid', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  if (!m.organizer) throw new HttpError(403, 'Only organizers can change group settings.');
  const g = { ...m.group };
  if (body.features && typeof body.features === 'object') {
    const next = featuresOf(g);
    for (const k of Object.keys(FEATURE_DEFAULTS)) if (typeof body.features[k] === 'boolean') next[k] = body.features[k];
    g.features = next;
  }
  if (body.notifications && typeof body.notifications === 'object') {
    const next = notifyOf(g);
    for (const k of Object.keys(NOTIFY_DEFAULTS)) if (typeof body.notifications[k] === 'boolean') next[k] = body.notifications[k];
    g.notifications = next;
  }
  if (body.name !== undefined) {
    const name = str(body.name, 60);
    if (!name) throw new HttpError(400, 'Please give your group a name.');
    if (normName(name) !== normName(g.name)) {
      const nk = await claimName(name, g.id);
      await put(nk, { groupId: g.id });
      await del(nameKey(g.name));
    }
    g.name = name;
  }
  if (body.code !== undefined) {
    const code = checkCode(normCode(body.code));
    if (code !== g.code) {
      if (await get(`codes/${code}`)) throw new HttpError(409, 'That code is already taken. Try another one.');
      await put(`codes/${code}`, { groupId: g.id });
      await del(`codes/${g.code}`);
      g.code = code;
    }
  }
  await put(`groups/${g.id}`, g);
  return { group: await groupSummary(g.id, m.user.id) };
});

route('POST', '/groups/:gid/leave', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  if (m.organizer) {
    const members = await listAll(`g/${m.group.id}/members/`);
    const otherOrganizers = members.filter((x) => x.role === 'organizer' && x.userId !== m.user.id);
    if (!otherOrganizers.length && members.length > 1) {
      throw new HttpError(400, 'You’re the only organizer. Make someone else an organizer before you leave.');
    }
  }
  await del(`g/${m.group.id}/members/${m.user.id}`);
  m.user.groups = m.user.groups.filter((x) => x !== m.group.id);
  await saveUser(m.user);
  return { ok: true };
});

route('GET', '/groups/:gid/members', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const members = await listAll(`g/${m.group.id}/members/`);
  const users = await Promise.all(members.map((x) => get(`users/${x.userId}`)));
  // When the Members tab is off, only organizers see contact details
  const showContact = featuresOf(m.group).members || m.organizer;
  return { members: members.map((x, i) => users[i] && ({ id: x.userId, name: users[i].name, role: x.role, joined: x.joinedAt,
      ...(showContact ? { email: users[i].email, phone: users[i].phone || '' } : {}) }))
    .filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)) };
});

route('PATCH', '/groups/:gid/members/:uid', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  if (!m.organizer) throw new HttpError(403, 'Only organizers can change roles.');
  const target = await get(`g/${m.group.id}/members/${validId(params.uid)}`);
  if (!target) throw new HttpError(404, 'Member not found.');
  if (!['organizer', 'member'].includes(body.role)) throw new HttpError(400, 'Unknown role.');
  if (body.role === 'member' && target.userId === m.user.id) {
    const others = (await listAll(`g/${m.group.id}/members/`)).filter((x) => x.role === 'organizer' && x.userId !== m.user.id);
    if (!others.length) throw new HttpError(400, 'A group needs at least one organizer.');
  }
  await put(`g/${m.group.id}/members/${target.userId}`, { ...target, role: body.role });
  return { ok: true };
});

route('DELETE', '/groups/:gid/members/:uid', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  if (!m.organizer) throw new HttpError(403, 'Only organizers can remove members.');
  const uid = validId(params.uid);
  if (uid === m.user.id) throw new HttpError(400, 'Use Leave Group to remove yourself.');
  const target = await get(`g/${m.group.id}/members/${uid}`);
  if (!target) throw new HttpError(404, 'Member not found.');
  await del(`g/${m.group.id}/members/${uid}`);
  const u = await get(`users/${uid}`);
  if (u) await put(`users/${uid}`, { ...u, groups: (u.groups || []).filter((x) => x !== m.group.id) });
  return { ok: true };
});

route('GET', '/groups/:gid/email-log', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  if (!m.organizer) throw new HttpError(403, 'Organizers only.');
  const log = (await listAll(`g/${m.group.id}/emaillog/`)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  return { configured: !!RESEND_API_KEY(), log };
});

// --- Prayer requests ---
async function prayerOut(gid, p, names) {
  const comments = (await listAll(`g/${gid}/prayerc/${p.id}/`)).sort((a, b) => a.at.localeCompare(b.at))
    .map((c) => ({ ...c, name: names[c.userId] || 'Former member' }));
  return { ...p, createdByName: names[p.createdBy] || 'Former member', comments };
}
async function getPrayer(m, id) {
  const p = await get(`g/${m.group.id}/prayer/${validId(id)}`);
  if (!p) throw new HttpError(404, 'Prayer request not found.');
  return p;
}
function readPrayerBody(body) {
  const title = str(body.title, 120), description = str(body.description, 4000);
  if (!title) throw new HttpError(400, 'Please add a title.');
  return { title, description };
}

route('GET', '/groups/:gid/prayers', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const [list, names] = await Promise.all([listAll(`g/${m.group.id}/prayer/`), nameMap(m.group.id)]);
  list.sort((a, b) => (b.lastActivity || b.createdAt).localeCompare(a.lastActivity || a.createdAt));
  return { prayers: await Promise.all(list.map((p) => prayerOut(m.group.id, p, names))) };
});

route('POST', '/groups/:gid/prayers', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const t = now();
  const p = { id: newId(), ...readPrayerBody(body), createdBy: m.user.id, createdAt: t, lastActivity: t };
  await put(`g/${m.group.id}/prayer/${p.id}`, p);
  await notifyNewPrayer(ctx, m.group, p, m.user.name);
  return { prayer: await prayerOut(m.group.id, p, await nameMap(m.group.id)) };
});

route('PUT', '/groups/:gid/prayers/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const p = await getPrayer(m, params.id);
  if (!canModify(m, p.createdBy)) throw new HttpError(403, 'You can only edit your own prayer requests.');
  const next = { ...p, ...readPrayerBody(body), updatedAt: now() };
  await put(`g/${m.group.id}/prayer/${p.id}`, next);
  return { prayer: await prayerOut(m.group.id, next, await nameMap(m.group.id)) };
});

route('DELETE', '/groups/:gid/prayers/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const p = await getPrayer(m, params.id);
  if (!canModify(m, p.createdBy)) throw new HttpError(403, 'You can only remove your own prayer requests.');
  await Promise.all((await keys(`g/${m.group.id}/prayerc/${p.id}/`)).map((k) => del(k)));
  await del(`g/${m.group.id}/prayer/${p.id}`);
  return { ok: true };
});

route('POST', '/groups/:gid/prayers/:id/comments', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const p = await getPrayer(m, params.id);
  const text = str(body.text, 2000);
  if (!text) throw new HttpError(400, 'Write a comment first.');
  const c = { id: newId(), userId: m.user.id, text, at: now() };
  await put(`g/${m.group.id}/prayerc/${p.id}/${c.id}`, c);
  const next = { ...p, lastActivity: c.at };
  await put(`g/${m.group.id}/prayer/${p.id}`, next);
  await notifyPrayerComment(ctx, m.group, p, c, m.user);
  return { prayer: await prayerOut(m.group.id, next, await nameMap(m.group.id)) };
});

route('PUT', '/groups/:gid/prayers/:id/comments/:cid', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const p = await getPrayer(m, params.id);
  const key = `g/${m.group.id}/prayerc/${p.id}/${validId(params.cid)}`;
  const c = await get(key);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (!canModify(m, c.userId)) throw new HttpError(403, 'You can only edit your own comments.');
  const text = str(body.text, 2000);
  if (!text) throw new HttpError(400, 'A comment can\u2019t be empty.');
  await put(key, { ...c, text, editedAt: now() });
  return { prayer: await prayerOut(m.group.id, p, await nameMap(m.group.id)) };
});

route('DELETE', '/groups/:gid/prayers/:id/comments/:cid', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'prayer');
  const p = await getPrayer(m, params.id);
  const key = `g/${m.group.id}/prayerc/${p.id}/${validId(params.cid)}`;
  const c = await get(key);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (!canModify(m, c.userId)) throw new HttpError(403, 'You can only remove your own comments.');
  await del(key);
  return { prayer: await prayerOut(m.group.id, p, await nameMap(m.group.id)) };
});

// --- Events ---
route('GET', '/groups/:gid/events', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const [events, names, bring] = await Promise.all([listAll(`g/${m.group.id}/events/`), nameMap(m.group.id), listAll(`g/${m.group.id}/bring/`)]);
  const byTarget = {};
  for (const c of bring) (byTarget[c.target] ||= []).push(c);
  return { events: events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((e) => eventOut(e, names, byTarget[`e-${e.id}`])) };
});

route('POST', '/groups/:gid/events', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
  const ev = { id: newId(), ...readEventBody(body), createdBy: m.user.id, pollId: null, createdAt: now() };
  await put(`g/${m.group.id}/events/${ev.id}`, ev);
  await notifyNewEvent(ctx, m.group, ev, m.user.name, false);
  return { event: eventOut(ev, { [m.user.id]: m.user.name }, []) };
});

route('PUT', '/groups/:gid/events/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const key = `g/${m.group.id}/events/${validId(params.id)}`;
  const ev = await get(key);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!canModify(m, ev.createdBy)) throw new HttpError(403, 'Only the person who added this event can edit it.');
  const next = { ...ev, ...readEventBody(body), updatedAt: now() };
  await put(key, next);
  return { event: await eventOutOne(m.group.id, next, await nameMap(m.group.id)) };
});

route('DELETE', '/groups/:gid/events/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const key = `g/${m.group.id}/events/${validId(params.id)}`;
  const ev = await get(key);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!canModify(m, ev.createdBy)) throw new HttpError(403, 'Only the person who added this event can delete it.');
  await del(key);
  await clearContributions(m.group.id, `e-${ev.id}`);
  if (ev.pollId) { // re-open the poll it came from
    const pk = `g/${m.group.id}/polls/${ev.pollId}`;
    const p = await get(pk);
    if (p) await put(pk, { ...p, status: 'open', eventId: null, scheduledOptionId: null });
  }
  return { ok: true };
});

route('PUT', '/groups/:gid/events/:id/bring', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const ev = await get(`g/${m.group.id}/events/${validId(params.id)}`);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!ev.pitchIn) throw new HttpError(400, 'This event isn\u2019t a pitch-in.');
  await saveContribution(m.group.id, `e-${ev.id}`, m.user.id, body);
  return { event: await eventOutOne(m.group.id, ev, await nameMap(m.group.id)) };
});

// --- Polls ---
route('GET', '/groups/:gid/polls', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const [polls, names] = await Promise.all([listAll(`g/${m.group.id}/polls/`), nameMap(m.group.id)]);
  polls.sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
  return { polls: await Promise.all(polls.map((p) => pollOut(m.group.id, p, names))) };
});

route('POST', '/groups/:gid/polls', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
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
    options, pitchIn: !!body.pitchIn, status: 'open', eventId: null, scheduledOptionId: null, createdBy: m.user.id, createdAt: now() };
  await put(`g/${m.group.id}/polls/${poll.id}`, poll);
  await notifyNewPoll(ctx, m.group, poll, m.user.name);
  return { poll: await pollOut(m.group.id, poll, { [m.user.id]: m.user.name }) };
});

route('PUT', '/groups/:gid/polls/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const pk = `g/${m.group.id}/polls/${validId(params.id)}`;
  const poll = await get(pk);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll or a group organizer can edit it.');
  if (poll.status !== 'open') throw new HttpError(400, 'A date has already been picked for this poll. Edit the calendar event instead.');
  const title = str(body.title, 120);
  if (!title) throw new HttpError(400, 'Please add a title.');
  const existing = new Map(poll.options.map((o) => [o.id, o]));
  const seen = new Set(), options = [], cleared = new Set();
  for (const o of (Array.isArray(body.options) ? body.options : []).slice(0, 30)) {
    const date = str(o?.date, 10), time = str(o?.time, 5);
    if (!isDate(date) || !isTime(time) || seen.has(date + time)) continue;
    seen.add(date + time);
    const prev = typeof o.id === 'string' ? existing.get(o.id) : null;
    if (prev) {
      if (prev.date !== date || prev.time !== time) cleared.add(prev.id); // answered for a different time
      options.push({ id: prev.id, date, time });
    } else {
      options.push({ id: newId(), date, time });
    }
  }
  if (options.length < 2) throw new HttpError(400, 'Add at least two date options for people to vote on.');
  options.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const keep = new Set(options.map((o) => o.id));
  // Drop answers only for removed options and options whose date/time changed
  for (const k of await keys(`g/${m.group.id}/votes/${poll.id}/`)) {
    const v = await get(k);
    if (!v) continue;
    let changed = false;
    for (const optId of Object.keys(v.answers)) {
      if (!keep.has(optId) || cleared.has(optId)) { delete v.answers[optId]; changed = true; }
    }
    if (!changed) continue;
    if (Object.keys(v.answers).length) await put(k, v); else await del(k);
  }
  const next = { ...poll, title, description: str(body.description, 4000), location: str(body.location, 200),
    cost: parseCost(body.cost), options, pitchIn: !!body.pitchIn, updatedAt: now() };
  await put(pk, next);
  return { poll: await pollOut(m.group.id, next, await nameMap(m.group.id)) };
});

route('PUT', '/groups/:gid/polls/:id/bring', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const poll = await get(`g/${m.group.id}/polls/${validId(params.id)}`);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!poll.pitchIn) throw new HttpError(400, 'This poll isn\u2019t collecting pitch-in items.');
  if (poll.status !== 'open') throw new HttpError(400, 'A date has been picked — add what you\u2019re bringing on the calendar event instead.');
  await saveContribution(m.group.id, `p-${poll.id}`, m.user.id, body);
  return { poll: await pollOut(m.group.id, poll, await nameMap(m.group.id)) };
});

route('POST', '/groups/:gid/polls/:id/vote', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const poll = await get(`g/${m.group.id}/polls/${validId(params.id)}`);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (poll.status !== 'open') throw new HttpError(400, 'This poll is closed — a date has already been picked.');
  const key = `g/${m.group.id}/votes/${poll.id}/${m.user.id}`;
  const mine = (await get(key)) || { userId: m.user.id, answers: {} };
  const ids = new Set(poll.options.map((o) => o.id));
  for (const [optId, answer] of Object.entries(body?.votes || {})) {
    if (!ids.has(optId)) continue;
    if (answer === null || answer === '') delete mine.answers[optId];
    else if (['yes', 'maybe', 'no'].includes(answer)) mine.answers[optId] = answer;
  }
  mine.at = now();
  if (Object.keys(mine.answers).length) await put(key, mine); else await del(key);
  return { poll: await pollOut(m.group.id, poll, await nameMap(m.group.id)) };
});

route('POST', '/groups/:gid/polls/:id/schedule', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
  const pk = `g/${m.group.id}/polls/${validId(params.id)}`;
  const poll = await get(pk);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll can pick the final date.');
  if (poll.status !== 'open') throw new HttpError(400, 'A date has already been picked for this poll.');
  const opt = poll.options.find((o) => o.id === body.optionId);
  if (!opt) throw new HttpError(400, 'Please choose one of the poll’s dates.');
  const ev = { id: newId(), title: poll.title, description: poll.description, date: opt.date, time: opt.time, cost: poll.cost,
    location: poll.location, pitchIn: !!poll.pitchIn, createdBy: m.user.id, pollId: poll.id, createdAt: now() };
  await put(`g/${m.group.id}/events/${ev.id}`, ev);
  if (poll.pitchIn) { // carry everyone's pitch-in items over to the calendar event
    for (const c of await listAll(bringPrefix(m.group.id, `p-${poll.id}`))) {
      await put(bringPrefix(m.group.id, `e-${ev.id}`) + c.userId, { ...c, target: `e-${ev.id}` });
    }
  }
  const next = { ...poll, status: 'scheduled', eventId: ev.id, scheduledOptionId: opt.id, scheduledAt: now() };
  await put(pk, next);
  await notifyNewEvent(ctx, m.group, ev, m.user.name, true);
  const names = await nameMap(m.group.id);
  return { poll: await pollOut(m.group.id, next, names), event: await eventOutOne(m.group.id, ev, names) };
});

route('DELETE', '/groups/:gid/polls/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const pk = `g/${m.group.id}/polls/${validId(params.id)}`;
  const poll = await get(pk);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll can delete it.');
  await Promise.all((await keys(`g/${m.group.id}/votes/${poll.id}/`)).map((k) => del(k)));
  await clearContributions(m.group.id, `p-${poll.id}`);
  await del(pk);
  if (poll.eventId) {
    const ek = `g/${m.group.id}/events/${poll.eventId}`;
    const ev = await get(ek);
    if (ev) await put(ek, { ...ev, pollId: null });
  }
  return { ok: true };
});

// ---------- Handler ----------
export default async function handler(req, context = {}) {
  _store = null; // fresh store (and token) for every request
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
    if (!['GET', 'DELETE'].includes(req.method) && !(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Expected JSON.');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Not found.');
    await migrateLegacy();
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
