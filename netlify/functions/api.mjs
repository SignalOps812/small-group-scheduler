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
//   g/<gid>/topics/<id>             discussion { id, title, body, createdBy, createdAt, lastActivity, lastBy, commentCount, lastComment }
//   g/<gid>/topicc/<topicId>/<cid>  { id, userId, text, at, editedAt } · g/<gid>/topicread/<uid> { topicId: lastReadAt }
//   g/<gid>/meals/<id>              meal train { id, recipient, start, end, days, dropStart/End, tz, address, coordinators, token, status, … }
//   g/<gid>/mealslots/<id>/<date>   { date, name, email, phone, dish, note, userId|null, manage, at, remindedAt }
//   mtpub/<token> → { gid, mtid }   public sign-up link · mtmanage/<token> → { gid, mtid, date } volunteer's change/cancel link
//   mtactive/<gid>/<mtid>           trains the hourly reminder job checks
//   g/<gid>/bring/<p|e>-<id>/<uid>  { target, userId, items: [{ item, category }], at }   — pitch-in sign-ups
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
let _store = null, _storeName = 'smallgroup';
// Previews and branch deploys get their own data so test code can never touch the live site's.
// Anything else (including production and unknown values) uses the live store.
function useStoreFor(context) {
  const c = context?.deploy?.context || process.env.CONTEXT || '';
  _storeName = ['deploy-preview', 'branch-deploy', 'dev'].includes(c) ? `smallgroup-${c}` : 'smallgroup';
  _store = null;
}
const store = () => (_store ||= getStore({ name: _storeName, consistency: 'strong' }));
const backupStore = () => getStore({ name: `${_storeName}-backups`, consistency: 'strong' });

// ---------- Encryption at rest ----------
// Prayer requests and discussions are sealed with AES-256-GCM before they're stored, using a key
// derived from the DATA_ENCRYPTION_KEY setting (kept in Netlify, never in the data or the code).
// Each value is bound to its storage key, so encrypted text can't be moved to another record.
// Older plain-text records still read fine and are converted once a key is set.
const SEALED = [
  [/^g\/[^/]+\/prayer\/[^/]+$/, ['title', 'description']],
  [/^g\/[^/]+\/prayerc\/[^/]+\/[^/]+$/, ['text']],
  [/^g\/[^/]+\/topics\/[^/]+$/, ['title', 'body', 'lastComment']],
  [/^g\/[^/]+\/topicc\/[^/]+\/[^/]+$/, ['text']],
];
const sealedFields = (key) => SEALED.find(([re]) => re.test(key))?.[1] || null;
let _dataKey;
function dataKey() {
  if (_dataKey !== undefined) return _dataKey;
  const secret = env('DATA_ENCRYPTION_KEY');
  _dataKey = secret ? Buffer.from(crypto.hkdfSync('sha256', secret, 'groups-app', 'data-encryption-v1', 32)) : null;
  return _dataKey;
}
const keyFingerprint = () => (dataKey() ? crypto.createHash('sha256').update(dataKey()).digest('hex').slice(0, 12) : null);
function seal(text, aad) {
  const k = dataKey();
  if (!k || typeof text !== 'string' || !text || text.startsWith('enc1:')) return text;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(val, aad) {
  if (typeof val !== 'string' || !val.startsWith('enc1:')) return val;
  const k = dataKey();
  if (!k) return '[Encrypted \u2014 the site\u2019s encryption key isn\u2019t set]';
  try {
    const raw = Buffer.from(val.slice(5), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad)); d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (err) {
    console.error('[decrypt] failed for', aad, err.message);
    return '[Can\u2019t decrypt \u2014 the encryption key has changed]';
  }
}
function transform(key, val, fn) {
  const fields = val && typeof val === 'object' && sealedFields(key);
  if (!fields) return val;
  const out = { ...val };
  for (const f of fields) if (typeof out[f] === 'string') out[f] = fn(out[f], `${key}#${f}`);
  return out;
}
const get = async (key) => transform(key, await store().get(key, { type: 'json' }), unseal);
const put = (key, val) => store().setJSON(key, transform(key, val, seal));
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
const USER_NOTIFY_KEYS = ['event', 'scheduled', 'poll', 'prayer', 'prayerComment', 'meal', 'topic', 'topicComment'];
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
const FEATURE_DEFAULTS = { members: true, prayer: false, meals: false, topics: true };
const featuresOf = (g) => ({ ...FEATURE_DEFAULTS, ...(g.features || {}) });
function requireFeature(m, f) {
  if (!featuresOf(m.group)[f]) throw new HttpError(403, 'That feature is turned off for this group.');
}
// Which group emails go out; organizers control each type
const NOTIFY_DEFAULTS = { event: true, scheduled: true, poll: true, prayer: true, prayerComment: false, meal: true, topic: true, topicComment: false };
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
// Encrypt any plain-text prayer/discussion records once a key is configured (runs once per key)
let encMigrated = false;
async function migrateEncryption() {
  if (encMigrated || !dataKey()) return;
  const flag = `meta/enc-${keyFingerprint()}`;
  if (await store().get(flag)) { encMigrated = true; return; }
  let n = 0;
  for (const k of await keys('g/')) {
    if (!sealedFields(k)) continue;
    const raw = await store().get(k, { type: 'json' });
    if (!raw || !sealedFields(k).some((f) => typeof raw[f] === 'string' && raw[f] && !raw[f].startsWith('enc1:'))) continue;
    await put(k, raw); n++;
  }
  await store().setJSON(flag, { at: now(), records: n });
  console.log(`[encryption] sealed ${n} existing records`);
  encMigrated = true;
}
// Older email-log entries kept full subjects (with prayer and discussion titles); rewrite them generically once
let logScrubbed = false;
async function scrubEmailLog() {
  if (logScrubbed) return;
  if (await store().get('meta/emaillog-scrub-v1')) { logScrubbed = true; return; }
  const rules = [[/\] Prayer request: .*/, '] Prayer request'], [/\] (Update|New comment): .*/, '] Prayer request update'], [/\] New topic: .*/, '] New discussion topic'], [/\] Re: .*/, '] Discussion reply']];
  let n = 0;
  for (const k of await keys('g/')) {
    if (!/\/emaillog\//.test(k)) continue;
    const e = await store().get(k, { type: 'json' });
    if (!e?.subject) continue;
    const rule = rules.find(([re]) => re.test(e.subject));
    if (rule) { await store().setJSON(k, { ...e, subject: e.subject.replace(rule[0], rule[1]) }); n++; }
  }
  await store().setJSON('meta/emaillog-scrub-v1', { at: now(), entries: n });
  logScrubbed = true;
}
async function migrateLegacy() {
  await migrateEncryption();
  await scrubEmailLog();
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
// Time zones: times are wall-clock times in an IANA zone ('' = older items with no zone)
const validTz = (v) => {
  const t = typeof v === 'string' ? v.trim().slice(0, 64) : '';
  if (!t) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } catch { return ''; }
};
function tzOffset(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ts;
}
function zonedInstant(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - tzOffset(t, tz);
  return new Date(t);
}
// "7:00 PM EST" — emails always name the zone since we don't know where the reader is
function fmtTimeTz(date, time, tz) {
  if (!time) return '';
  if (!tz) return fmtTime(time);
  try {
    const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(zonedInstant(date, time, tz)).find((x) => x.type === 'timeZoneName')?.value;
    return `${fmtTime(time)}${abbr ? ' ' + abbr : ''}`;
  } catch { return fmtTime(time); }
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
async function sendEmail({ to, subject, html, text, gid, logAs }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) return;
  const key = RESEND_API_KEY();
  if (!key) {
    console.log(`[email:not-configured] "${subject}" → ${recipients.length} recipient(s)`);
    return logEmail(gid, logAs || subject, recipients.length, 'skipped', 'RESEND_API_KEY is not set');
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
    await logEmail(gid, logAs || subject, recipients.length, 'sent');
  } catch (err) {
    console.error('[email] failed:', err.message);
    await logEmail(gid, logAs || subject, recipients.length, 'failed', err.message);
  }
}
async function notifyGroup(type, ctx, group, subject, heading, body, ctaText, ctaUrl, text, excludeId) {
  const memberIds = (await keys(`g/${group.id}/members/`)).map((k) => k.split('/').pop()).filter((id) => id !== excludeId);
  const users = await Promise.all(memberIds.map((id) => get(`users/${id}`)));
  const to = users.filter((u) => u && u.notify !== false && userPrefs(u)[type]).map((u) => u.email);
  const html = emailShell(group.name, heading, body, ctaText, ctaUrl,
    `You're receiving this as a member of ${group.name}. You can choose which emails you get from your profile.`);
  // Sensitive emails are logged without their subject, so prayer and discussion titles never sit in the log unencrypted
  const SENSITIVE = { prayer: 'Prayer request', prayerComment: 'Prayer request update', topic: 'New discussion topic', topicComment: 'Discussion reply' };
  ctx.background(sendEmail({ to, subject: `[${group.name}] ${subject}`, html, text, gid: group.id, logAs: SENSITIVE[type] ? `[${group.name}] ${SENSITIVE[type]}` : undefined }));
}
const deepLink = (gid, hash) => `${APP_URL()}/?g=${encodeURIComponent(gid)}#${hash}`;

function notifyNewEvent(ctx, group, ev, byName, viaPoll) {
  if (!notifyOf(group)[viaPoll ? 'scheduled' : 'event']) return;
  const when = `${fmtDate(ev.date)}${ev.time ? ' at ' + fmtTimeTz(ev.date, ev.time, ev.tz) : ''}`;
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
  const type = pollType(poll);
  const anonNote = poll.anonymous ? `<p style="margin:10px 0 0;color:#8e8e93;font-size:14px">Responses are anonymous.</p>` : '';
  if (type === 'choice') {
    const list = poll.options.map((o) => `<li style="margin:2px 0">${esc(o.text)}</li>`).join('');
    return notifyGroup('poll', ctx, group, `New poll: ${poll.title}`, esc(poll.title),
      `<p style="margin:0 0 8px">${esc(byName)} asked the group${poll.multi ? ' (pick as many as you like)' : ''}:</p>${poll.description ? `<p style="margin:0 0 8px;white-space:pre-line">${esc(poll.description)}</p>` : ''}<ul style="margin:0;padding-left:20px">${list}</ul>${anonNote}`,
      'Answer now', link, `${byName} asked: "${poll.title}". Answer here: ${link}`);
  }
  if (type === 'pitchin') {
    return notifyGroup('poll', ctx, group, `Pitch-in sign-up: ${poll.title}`, `What will you bring? ${esc(poll.title)}`,
      `<p style="margin:0 0 8px">${esc(byName)} started a pitch-in sign-up. Add what you’re bringing so we don’t end up with five desserts.</p>${detailRows([['Where', poll.location], ['Details', poll.description]])}${anonNote}`,
      'Sign up', link, `${byName} started a pitch-in sign-up: "${poll.title}". Sign up here: ${link}`);
  }
  const list = poll.options.map((o) => `<li style="margin:2px 0">${esc(fmtDate(o.date))}${o.time ? ' · ' + esc(fmtTimeTz(o.date, o.time, o.tz)) : ''}</li>`).join('');
  return notifyGroup('poll', ctx, group,
    `New poll: ${poll.title} — please vote`,
    `Help pick a date: ${esc(poll.title)}`,
    `<p style="margin:0 0 8px">${esc(byName)} wants to find a time that works for everyone. Mark the dates you can make${poll.pitchIn ? ', and say what you\u2019ll bring to the pitch-in' : ''}.</p>` +
      detailRows([['Where', poll.location], ['Cost', fmtCost(poll.cost)], ['Details', poll.description]]) +
      `<p style="margin:10px 0 4px;color:#8e8e93;font-size:14px">Proposed times</p><ul style="margin:0;padding-left:20px">${list}</ul>${anonNote}`,
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
// Viewer-aware: anonymous sign-ups never carry who they're from, except a "mine" flag for the viewer
const contribOut = (c, names, viewer, anon) => anon
  ? { items: contribItems(c), at: c.at, mine: c.userId === viewer }
  : { userId: c.userId, name: names[c.userId] || 'Former member', items: contribItems(c), at: c.at, mine: c.userId === viewer };
async function contributions(gid, target, names, viewer, anon) {
  return (await listAll(bringPrefix(gid, target))).sort((a, b) => a.at.localeCompare(b.at)).map((c) => contribOut(c, names, viewer, anon));
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

const eventOut = (e, names, contribs, viewer) => ({ ...e, pitchIn: !!e.pitchIn, bringAnon: !!e.bringAnon, createdByName: names[e.createdBy] || 'Former member',
  ...(e.pitchIn ? { contributions: (contribs || []).map((c) => contribOut(c, names, viewer, !!e.bringAnon)).sort((a, b) => a.at.localeCompare(b.at)) } : {}) });
async function eventOutOne(gid, e, names, viewer) {
  return eventOut(e, names, e.pitchIn ? await listAll(bringPrefix(gid, `e-${e.id}`)) : [], viewer);
}
const POLL_TYPES = ['dates', 'pitchin', 'choice'];
const pollType = (p) => (POLL_TYPES.includes(p.type) ? p.type : 'dates');
// Shapes a poll for one viewer. Anonymous polls report totals and the viewer's own answers — never who chose what.
async function pollOut(gid, p, names, viewer) {
  const type = pollType(p), anon = !!p.anonymous;
  const votes = type === 'pitchin' ? [] : await listAll(`g/${gid}/votes/${p.id}/`);
  const mineV = votes.find((v) => v.userId === viewer);
  const options = (p.options || []).map((o) => {
    const vs = votes.filter((v) => v.answers[o.id]);
    return {
      ...o,
      mine: mineV?.answers[o.id] || null,
      votes: anon ? vs.map((v) => ({ answer: v.answers[o.id] })) : vs.map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', answer: v.answers[o.id], at: v.at })),
    };
  });
  let responders = [], responderCount = 0, responded = false, contribs;
  if (type === 'pitchin' || p.pitchIn) contribs = await contributions(gid, `p-${p.id}`, names, viewer, anon);
  if (type === 'pitchin') {
    responderCount = contribs.length; responded = contribs.some((c) => c.mine);
    if (!anon) responders = contribs.map((c) => ({ userId: c.userId, name: c.name, at: c.at }));
  } else {
    const r = votes.filter((v) => Object.keys(v.answers).length).sort((a, b) => a.at.localeCompare(b.at));
    responderCount = r.length; responded = r.some((v) => v.userId === viewer);
    if (!anon) responders = r.map((v) => ({ userId: v.userId, name: names[v.userId] || 'Former member', at: v.at }));
  }
  return { ...p, type, anonymous: anon, multi: !!p.multi, pitchIn: type === 'pitchin' || !!p.pitchIn, options, responders, responderCount, responded,
    createdByName: names[p.createdBy] || 'Former member', ...(contribs ? { contributions: contribs } : {}) };
}
function readEventBody(body) {
  const title = str(body.title, 120), description = str(body.description, 4000), location = str(body.location, 200);
  const date = str(body.date, 10), time = str(body.time, 5);
  if (!title) throw new HttpError(400, 'Please add a title.');
  if (!isDate(date)) throw new HttpError(400, 'Please choose a date.');
  if (!isTime(time)) throw new HttpError(400, 'Please choose a valid time.');
  return { title, description, location, date, time, tz: time ? validTz(body.tz) : '', cost: parseCost(body.cost), pitchIn: !!body.pitchIn };
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
  return { user: { ...userOut(u), isAdmin: isAdmin(u) }, groups: await myGroups(u) };
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

// ---------- Backups ----------
// Snapshots copy the stored data exactly as it sits (prayer requests and discussions stay encrypted)
// into a separate "<store>-backups" store. Sign-in sessions and reset links aren't backed up.
const BACKUP_SKIP = /^(sessions|resets|admin)\//; // admin/ holds the Google Drive connection — never backed up or overwritten
const KEEP = { nightly: 30, manual: 20, 'before-restore': 10, imported: 10 };
const snapName = (reason, count) => `snap/${new Date().toISOString().replace(/[:.]/g, '-')}__${reason}__${count}.json`;
const parseSnap = (k) => {
  const m = /^snap\/(.+?)__([\w-]+)__(\d+)\.json$/.exec(k);
  if (!m) return null;
  const iso = m[1].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z');
  return { key: k, at: iso, reason: m[2], records: Number(m[3]) };
};
async function createSnapshot(reason) {
  const data = {};
  for (const k of await keys('')) {
    if (BACKUP_SKIP.test(k)) continue;
    const raw = await store().get(k); // raw text: sealed fields stay sealed
    if (raw !== null && raw !== undefined) data[k] = raw;
  }
  const count = Object.keys(data).length;
  const name = snapName(reason, count);
  await backupStore().set(name, JSON.stringify({ app: 'groups', version: 1, createdAt: now(), reason, store: _storeName, keyFingerprint: keyFingerprint(), count, data }));
  await pruneSnapshots();
  return parseSnap(name);
}
async function listSnapshots() {
  const { blobs } = await backupStore().list({ prefix: 'snap/' });
  return blobs.map((b) => parseSnap(b.key)).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
}
async function pruneSnapshots() {
  const all = await listSnapshots();
  for (const [reason, keep] of Object.entries(KEEP)) {
    for (const s of all.filter((x) => x.reason === reason).slice(keep)) await backupStore().delete(s.key);
  }
}
function readSnapshot(text) {
  let snap;
  try { snap = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new HttpError(400, 'That file isn’t a valid backup.'); }
  if (!snap || snap.app !== 'groups' || typeof snap.data !== 'object') throw new HttpError(400, 'That file isn’t a Groups backup.');
  return snap;
}
// Replace the live data with a snapshot. A safety snapshot is taken first so a restore can be undone.
async function restoreSnapshot(snap) {
  if (snap.keyFingerprint && keyFingerprint() && snap.keyFingerprint !== keyFingerprint())
    throw new HttpError(400, 'This backup was made with a different encryption key, so its prayer requests and discussions couldn’t be read. Restore it with the original key in place.');
  const safety = await createSnapshot('before-restore');
  const wanted = new Set(Object.keys(snap.data).filter((k) => !BACKUP_SKIP.test(k)));
  for (const k of await keys('')) if (!BACKUP_SKIP.test(k) && !wanted.has(k)) await store().delete(k);
  for (const k of wanted) await store().set(k, typeof snap.data[k] === 'string' ? snap.data[k] : JSON.stringify(snap.data[k]));
  encMigrated = false; migrated = false; // re-check migrations against the restored data
  return { restored: wanted.size, safety };
}
export async function runNightlyBackup(context) {
  useStoreFor(context);
  const s = await createSnapshot('nightly');
  console.log(`[backup] nightly snapshot: ${s.records} records → ${s.key}`);
  const text = await backupStore().get(s.key);
  const up = await uploadToDrive(packBackupFile(text), backupFileName(JSON.parse(text)));
  if (up) console.log(`[backup] copied to Google Drive: ${up.name}`);
  return s;
}

// Site admins are the accounts listed in the ADMIN_EMAILS setting (comma-separated)
const adminEmails = () => env('ADMIN_EMAILS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => !!u && adminEmails().includes(String(u.email).toLowerCase());
async function requireAdmin(req) {
  const u = await requireUser(req);
  if (!isAdmin(u)) throw new HttpError(403, 'Only site admins can manage backups.');
  return u;
}
route('GET', '/admin/backups', async ({ req }) => {
  await requireAdmin(req);
  return { snapshots: await listSnapshots(), encryption: { enabled: !!dataKey(), fingerprint: keyFingerprint() }, store: _storeName, drive: await driveStatus() };
});
route('POST', '/admin/backups', async ({ req }) => {
  await requireAdmin(req);
  rateLimit('backup:' + 'admin', 20, 60 * 60e3);
  return { snapshot: await createSnapshot('manual'), snapshots: await listSnapshots() };
});
route('GET', '/admin/backups/download', async ({ req }) => {
  await requireAdmin(req);
  const key = new URL(req.url).searchParams.get('key') || '';
  if (!parseSnap(key)) throw new HttpError(404, 'Backup not found.');
  const text = await backupStore().get(key);
  if (!text) throw new HttpError(404, 'Backup not found.');
  const snap = JSON.parse(text);
  return { name: backupFileName(snap), file: JSON.parse(packBackupFile(text)) };
});
route('POST', '/admin/backups/restore', async ({ req, body }) => {
  await requireAdmin(req);
  if (body.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm.');
  let snap;
  if (body.key) {
    if (!parseSnap(body.key)) throw new HttpError(404, 'Backup not found.');
    const text = await backupStore().get(body.key);
    if (!text) throw new HttpError(404, 'Backup not found.');
    snap = readSnapshot(text);
  } else if (body.snapshot) {
    snap = readSnapshot(unpackBackupFile(typeof body.snapshot === 'string' ? JSON.parse(body.snapshot) : body.snapshot));
    await backupStore().set(snapName('imported', Object.keys(snap.data).length), JSON.stringify(snap)); // keep the uploaded copy too
    await pruneSnapshots();
  } else throw new HttpError(400, 'Choose a backup to restore.');
  const r = await restoreSnapshot(snap);
  return { ...r, snapshots: await listSnapshots() };
});

// ---------- Backup files (encrypted, compressed) ----------
// Files that leave Netlify (downloads, Google Drive) are gzip-compressed and sealed with AES-256-GCM
// using a key derived from DATA_ENCRYPTION_KEY, so a copy in an inbox or a Drive is unreadable on its own.
function fileKey() {
  const secret = env('DATA_ENCRYPTION_KEY');
  return secret ? Buffer.from(crypto.hkdfSync('sha256', secret, 'groups-app', 'backup-file-v1', 32)) : null;
}
function packBackupFile(snapText) {
  const k = fileKey(), meta = JSON.parse(snapText);
  if (!k) return snapText; // no key configured: plain snapshot (sealed fields would be plain too)
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from('groups-backup-v1'));
  const ct = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(snapText))), c.final()]);
  return JSON.stringify({ app: 'groups', format: 'encrypted-v1', createdAt: meta.createdAt, reason: meta.reason, count: meta.count,
    keyFingerprint: keyFingerprint(), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: ct.toString('base64') });
}
function unpackBackupFile(obj) {
  if (obj?.format !== 'encrypted-v1') return obj;
  const k = fileKey();
  if (!k) throw new HttpError(400, 'This backup is encrypted. Set the original DATA_ENCRYPTION_KEY first, then restore it.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(obj.iv, 'base64'));
    d.setAAD(Buffer.from('groups-backup-v1')); d.setAuthTag(Buffer.from(obj.tag, 'base64'));
    return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(obj.data, 'base64')), d.final()])).toString('utf8'));
  } catch { throw new HttpError(400, 'This backup was encrypted with a different key, so it can’t be opened.'); }
}

// ---------- Google Drive (off-site copies) ----------
// The admin connects their own Google account once (scope: drive.file — the app can only see files it
// creates). The refresh token is stored sealed with the data key. Nightly backups are uploaded to a
// "Groups Backups" folder and the newest 30 are kept.
const GDRIVE_KEEP = 30;
const gConfigured = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
const gRedirect = () => `${APP_URL()}/api/admin/gdrive/callback`;
async function gState() { return (await store().get('admin/gdrive', { type: 'json' })) || null; }
async function gSave(st) {
  await store().setJSON('admin/gdrive', { ...st, refresh: st.refresh && !st.refresh.startsWith('enc1:') ? seal(st.refresh, 'admin/gdrive#refresh') : st.refresh });
}
async function gAccessToken(st) {
  const refresh = unseal(st.refresh, 'admin/gdrive#refresh');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), refresh_token: refresh, grant_type: 'refresh_token' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error === 'invalid_grant' ? 'Google access was revoked or expired — reconnect Google Drive.' : `Google sign-in failed (${j.error || r.status}).`);
  return j.access_token;
}
async function gApi(token, url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive error: ${j.error?.message || r.status}`);
  return j;
}
async function gEnsureFolder(token, st) {
  if (st.folderId) {
    try { const f = await gApi(token, `https://www.googleapis.com/drive/v3/files/${st.folderId}?fields=id,trashed`); if (!f.trashed) return st.folderId; } catch {}
  }
  const f = await gApi(token, 'https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${APP_NAME()} Backups`, mimeType: 'application/vnd.google-apps.folder' }) });
  return f.id;
}
async function uploadToDrive(fileText, name) {
  const st = await gState();
  if (!st?.refresh || !gConfigured()) return null;
  try {
    const token = await gAccessToken(st);
    const folderId = await gEnsureFolder(token, st);
    const boundary = 'groups' + crypto.randomBytes(8).toString('hex');
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${fileText}\r\n--${boundary}--`;
    const up = await gApi(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    // keep the newest backups only
    const list = await gApi(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&orderBy=createdTime desc&fields=files(id,name)&pageSize=200`);
    for (const f of (list.files || []).slice(GDRIVE_KEEP)) await gApi(token, `https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' });
    await gSave({ ...st, folderId, lastUploadAt: now(), lastFile: up.name, lastError: null, lastErrorAt: null });
    return up;
  } catch (err) {
    console.error('[gdrive] upload failed:', err.message);
    const first = !st.lastError;
    await gSave({ ...st, lastError: err.message, lastErrorAt: now() });
    if (first) { // tell the admins once per run of failures
      const to = adminEmails();
      if (to.length) await sendEmail({ to, subject: `${APP_NAME()}: Google Drive backup failed`, text: `The backup copy to Google Drive failed: ${err.message}\n\nOpen ${APP_URL()}/#backups to check the connection.`,
        html: emailShell(APP_NAME(), 'Google Drive backup failed', `<p style="margin:0">${esc(err.message)}</p><p style="margin:8px 0 0">Backups are still being saved on Netlify. Open Site Backups to reconnect Google Drive.</p>`, 'Open Site Backups', `${APP_URL()}/#backups`, 'You’re receiving this as a site admin.') });
    }
    return null;
  }
}
async function driveStatus() {
  const st = await gState();
  return { configured: gConfigured(), connected: !!st?.refresh, account: st?.account || '', folderUrl: st?.folderId ? `https://drive.google.com/drive/folders/${st.folderId}` : '',
    lastUploadAt: st?.lastUploadAt || null, lastFile: st?.lastFile || '', lastError: st?.lastError || null, lastErrorAt: st?.lastErrorAt || null };
}
const backupFileName = (snap) => `${APP_NAME().toLowerCase()}-backup-${snap.createdAt.slice(0, 16).replace(/[:T]/g, '-')}.json`;

// Netlify hides secret values, so the admin needs a way to save the key off-site. Requires the admin's password again.
route('POST', '/admin/encryption-key', async ({ req, body, ctx }) => {
  const u = await requireAdmin(req);
  rateLimit('keyreveal:' + u.id, 5, 15 * 60e3);
  if (!verifyPassword(String(body.password || ''), u.pwHash)) throw new HttpError(403, 'That password isn\u2019t right.');
  const key = env('DATA_ENCRYPTION_KEY');
  if (!key) throw new HttpError(400, 'No encryption key is set.');
  console.log(`[security] recovery key viewed by ${u.id}`);
  return { key, fingerprint: keyFingerprint() };
});
route('GET', '/admin/gdrive/connect', async ({ req }) => {
  const u = await requireAdmin(req);
  if (!gConfigured()) throw new HttpError(400, 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify first.');
  if (!dataKey()) throw new HttpError(400, 'Set up DATA_ENCRYPTION_KEY first, so the Google connection can be stored encrypted.');
  const state = newToken();
  await store().setJSON(`admin/gdrive-state/${state}`, { userId: u.id, expiresAt: Date.now() + 15 * 60e3 });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: gRedirect(), response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file openid email', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return { url };
});
route('GET', '/admin/gdrive/callback', async ({ req }) => {
  const q = new URL(req.url).searchParams, back = (s) => ({ __redirect: `${APP_URL()}/#backups?drive=${s}` });
  const state = q.get('state') || '';
  const pending = /^[\w-]{20,64}$/.test(state) ? await store().get(`admin/gdrive-state/${state}`, { type: 'json' }) : null;
  if (pending) await store().delete(`admin/gdrive-state/${state}`);
  if (!pending || pending.expiresAt < Date.now()) return back('expired');
  const u = await requireAdmin(req); // the same signed-in admin who started it
  if (u.id !== pending.userId) return back('error');
  if (q.get('error') || !q.get('code')) return back('cancelled');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: q.get('code'), client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: gRedirect(), grant_type: 'authorization_code' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) { console.error('[gdrive] token exchange failed', j.error); return back('error'); }
  let account = '';
  try { account = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch {}
  const prev = (await gState()) || {};
  await gSave({ refresh: j.refresh_token, account, connectedAt: now(), connectedBy: u.id, folderId: prev.folderId || null });
  return back('connected');
});
route('POST', '/admin/gdrive/disconnect', async ({ req }) => {
  await requireAdmin(req);
  const st = await gState();
  if (st?.refresh) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(unseal(st.refresh, 'admin/gdrive#refresh')), { method: 'POST' }); } catch {} }
  await store().delete('admin/gdrive');
  return { drive: await driveStatus() };
});
route('POST', '/admin/gdrive/upload', async ({ req }) => {
  await requireAdmin(req);
  rateLimit('gdrive-upload', 10, 60 * 60e3);
  const s = await createSnapshot('manual');
  const text = await backupStore().get(s.key);
  const up = await uploadToDrive(packBackupFile(text), backupFileName(JSON.parse(text)));
  const drive = await driveStatus();
  if (!up) throw new HttpError(502, drive.lastError || 'Google Drive isn’t connected.');
  return { drive, snapshots: await listSnapshots() };
});

// --- Discussion topics ---
// Unread = something new since you last opened the topic, posted by someone other than you.
const topicReadKey = (gid, uid) => `g/${gid}/topicread/${uid}`;
const isUnread = (t, reads, uid) => t.lastBy !== uid && (!reads[t.id] || reads[t.id] < t.lastActivity);
async function getTopic(m, id) {
  const t = await get(`g/${m.group.id}/topics/${validId(id)}`);
  if (!t) throw new HttpError(404, 'Topic not found.');
  return t;
}
function readTopicBody(body) {
  const title = str(body.title, 160), text = str(body.body, 6000);
  if (!title) throw new HttpError(400, 'Please give the topic a title.');
  return { title, body: text };
}
async function topicFull(m, t, names) {
  const comments = (await listAll(`g/${m.group.id}/topicc/${t.id}/`)).sort((a, b) => a.at.localeCompare(b.at))
    .map((c) => ({ ...c, name: names[c.userId] || 'Former member' }));
  return { ...t, createdByName: names[t.createdBy] || 'Former member', comments, unread: false };
}
async function markTopicRead(m, t) {
  const key = topicReadKey(m.group.id, m.user.id);
  const reads = (await get(key)) || {};
  reads[t.id] = now();
  await put(key, reads);
}
function notifyTopic(ctx, group, t, byName, byId, comment) {
  const type = comment ? 'topicComment' : 'topic';
  if (!notifyOf(group)[type]) return;
  const link = deepLink(group.id, `topics/${t.id}`);
  return notifyGroup(type, ctx, group,
    comment ? `Re: ${t.title}` : `New topic: ${t.title}`,
    comment ? `${esc(byName)} replied in “${esc(t.title)}”` : esc(t.title),
    comment ? `<p style="margin:0;white-space:pre-line">${esc(comment.text)}</p>`
      : `<p style="margin:0 0 8px">${esc(byName)} started a discussion.</p>${t.body ? `<p style="margin:0;white-space:pre-line">${esc(t.body)}</p>` : ''}`,
    comment ? 'Reply' : 'Join the discussion', link,
    `${comment ? `${byName} replied in "${t.title}":\n\n${comment.text}` : `${byName} started a discussion: "${t.title}"${t.body ? '\n\n' + t.body : ''}`}\n\n${link}`, byId);
}

route('GET', '/groups/:gid/topics', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const [list, names, reads] = await Promise.all([listAll(`g/${m.group.id}/topics/`), nameMap(m.group.id), get(topicReadKey(m.group.id, m.user.id))]);
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { topics: list.map((t) => ({ ...t, createdByName: names[t.createdBy] || 'Former member', lastByName: t.lastBy ? names[t.lastBy] || 'Former member' : '',
    unread: isUnread(t, reads || {}, m.user.id) })) };
});
route('GET', '/groups/:gid/topics/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  await markTopicRead(m, t);
  return { topic: await topicFull(m, t, await nameMap(m.group.id)) };
});
route('POST', '/groups/:gid/topics', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const at = now();
  const t = { id: newId(), ...readTopicBody(body), createdBy: m.user.id, createdAt: at, lastActivity: at, lastBy: m.user.id, commentCount: 0, lastComment: '' };
  await put(`g/${m.group.id}/topics/${t.id}`, t);
  await markTopicRead(m, t);
  await notifyTopic(ctx, m.group, t, m.user.name, m.user.id);
  return { topic: await topicFull(m, t, { [m.user.id]: m.user.name }) };
});
route('PUT', '/groups/:gid/topics/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  if (!canModify(m, t.createdBy)) throw new HttpError(403, 'Only the person who started this topic or an organizer can edit it.');
  const next = { ...t, ...readTopicBody(body), updatedAt: now() };
  await put(`g/${m.group.id}/topics/${t.id}`, next);
  return { topic: await topicFull(m, next, await nameMap(m.group.id)) };
});
route('DELETE', '/groups/:gid/topics/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  if (!canModify(m, t.createdBy)) throw new HttpError(403, 'Only the person who started this topic or an organizer can delete it.');
  await Promise.all((await keys(`g/${m.group.id}/topicc/${t.id}/`)).map((k) => del(k)));
  await del(`g/${m.group.id}/topics/${t.id}`);
  return { ok: true };
});
async function refreshTopicSummary(m, t) { // keep the list view's counts and preview in step with the comments
  const comments = (await listAll(`g/${m.group.id}/topicc/${t.id}/`)).sort((a, b) => a.at.localeCompare(b.at));
  const last = comments[comments.length - 1];
  const next = { ...t, commentCount: comments.length, lastComment: last ? last.text.slice(0, 160) : '', lastCommentBy: last ? last.userId : null };
  await put(`g/${m.group.id}/topics/${t.id}`, next);
  return next;
}
route('POST', '/groups/:gid/topics/:id/comments', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  const text = str(body.text, 4000);
  if (!text) throw new HttpError(400, 'Write a comment first.');
  const c = { id: newId(), userId: m.user.id, text, at: now() };
  await put(`g/${m.group.id}/topicc/${t.id}/${c.id}`, c);
  const next = await refreshTopicSummary(m, { ...t, lastActivity: c.at, lastBy: m.user.id });
  await markTopicRead(m, next);
  await notifyTopic(ctx, m.group, next, m.user.name, m.user.id, c);
  return { topic: await topicFull(m, next, await nameMap(m.group.id)) };
});
route('PUT', '/groups/:gid/topics/:id/comments/:cid', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  const key = `g/${m.group.id}/topicc/${t.id}/${validId(params.cid)}`;
  const c = await get(key);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (!canModify(m, c.userId)) throw new HttpError(403, 'You can only edit your own comments.');
  const text = str(body.text, 4000);
  if (!text) throw new HttpError(400, 'A comment can’t be empty.');
  await put(key, { ...c, text, editedAt: now() });
  const next = await refreshTopicSummary(m, t);
  return { topic: await topicFull(m, next, await nameMap(m.group.id)) };
});
route('DELETE', '/groups/:gid/topics/:id/comments/:cid', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'topics');
  const t = await getTopic(m, params.id);
  const key = `g/${m.group.id}/topicc/${t.id}/${validId(params.cid)}`;
  const c = await get(key);
  if (!c) throw new HttpError(404, 'Comment not found.');
  if (!canModify(m, c.userId)) throw new HttpError(403, 'You can only remove your own comments.');
  await del(key);
  const next = await refreshTopicSummary(m, t);
  return { topic: await topicFull(m, next, await nameMap(m.group.id)) };
});

// --- Meal trains ---
// A train lives in a group; anyone with its public link can sign up for a date without an account.
const MT_MAX_DAYS = 120;
const validTok = (t) => { if (!/^[\w-]{20,64}$/.test(t || '')) throw new HttpError(404, 'This link isn’t valid. Ask the coordinator for a new one.'); return t; };
const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekdayOf = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const todayIn = (tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
function trainDates(t) {
  const out = [];
  for (let d = t.start, i = 0; d <= t.end && i < MT_MAX_DAYS + 1; d = addDays(d, 1), i++) if (t.days.includes(weekdayOf(d))) out.push(d);
  return out;
}
const forWhom = (t) => t.recipient.replace(/^The\s/, 'the '); // "a meal for the Johnson family"
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Someone';
const mtSlotKey = (gid, id, date) => `g/${gid}/mealslots/${id}/${date}`;
async function mtSlots(gid, id) { return (await listAll(`g/${gid}/mealslots/${id}/`)).sort((a, b) => a.date.localeCompare(b.date)); }
const canManageTrain = (m, t) => m.organizer || (t.coordinators || []).includes(m.user.id) || t.createdBy === m.user.id;
const dropWindow = (t, date) => !t.dropStart ? '' : `${fmtTimeTz(date, t.dropStart, t.tz)}${t.dropEnd ? ' – ' + fmtTimeTz(date, t.dropEnd, t.tz) : ''}`;
const manageLink = (s) => `${APP_URL()}/m/manage/${s.manage}`;
const publicLink = (t) => `${APP_URL()}/m/${t.token}`;

function readTrainBody(body) {
  const title = str(body.title, 100), recipient = str(body.recipient, 100);
  if (!recipient) throw new HttpError(400, 'Who are the meals for?');
  const start = str(body.start, 10), end = str(body.end, 10);
  if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'Choose a start and end date.');
  if (end < start) throw new HttpError(400, 'The end date is before the start date.');
  if ((Date.parse(end) - Date.parse(start)) / 864e5 > MT_MAX_DAYS) throw new HttpError(400, `A meal train can run up to ${MT_MAX_DAYS} days.`);
  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) throw new HttpError(400, 'Pick at least one day of the week.');
  const dropStart = str(body.dropStart, 5), dropEnd = str(body.dropEnd, 5);
  if (!isTime(dropStart) || !isTime(dropEnd)) throw new HttpError(400, 'Please choose a valid drop-off time.');
  const t = {
    title: title || `Meals for ${recipient.replace(/^The\s/, 'the ')}`, recipient, note: str(body.note, 2000),
    start, end, days, dropStart, dropEnd: dropStart ? dropEnd : '', tz: validTz(body.tz) || 'America/New_York',
    headcount: str(body.headcount, 120), dietary: str(body.dietary, 1000), instructions: str(body.instructions, 1000),
    address: str(body.address, 300), contactPhone: str(body.contactPhone, 40),
    showDishes: body.showDishes !== false,
    coordinators: Array.isArray(body.coordinators) ? body.coordinators.filter((x) => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)).slice(0, 10) : [],
  };
  if (!trainDates(t).length) throw new HttpError(400, 'Those dates don’t include any of the chosen days.');
  return t;
}
// What anyone with the public link may see — never the address, phone or volunteers' contact info
function publicTrainOut(t, slots, groupName) {
  const by = Object.fromEntries(slots.map((s) => [s.date, s]));
  const today = todayIn(t.tz);
  return {
    title: t.title, recipient: t.recipient, note: t.note, groupName,
    dropStart: t.dropStart, dropEnd: t.dropEnd, tz: t.tz, headcount: t.headcount, dietary: t.dietary, instructions: t.instructions,
    status: t.status, showDishes: t.showDishes, hasAddress: !!t.address,
    dates: trainDates(t).map((d) => ({ date: d, past: d < today, taken: !!by[d], name: by[d] ? firstName(by[d].name) : '', dish: by[d] && t.showDishes ? by[d].dish : '' })),
  };
}
// Details a volunteer gets once they're signed up
const volunteerDetails = (t) => ({ address: t.address, contactPhone: t.contactPhone });
function memberTrainOut(m, t, slots) {
  const manage = canManageTrain(m, t), mine = slots.some((s) => s.userId === m.user.id);
  return {
    ...t, token: t.token, canManage: manage,
    address: manage || mine ? t.address : '', contactPhone: manage || mine ? t.contactPhone : '',
    publicUrl: publicLink(t),
    dates: trainDates(t),
    slots: slots.map((s) => ({
      date: s.date, name: s.name, dish: s.dish, mine: s.userId === m.user.id, member: !!s.userId, at: s.at,
      ...(manage || s.userId === m.user.id ? { email: s.email, phone: s.phone || '', note: s.note || '' } : {}),
    })),
  };
}
async function getTrain(gid, id) {
  const t = await get(`g/${gid}/meals/${validId(id)}`);
  if (!t) throw new HttpError(404, 'Meal train not found.');
  return t;
}
async function trainFromPublic(token) {
  const ref = await get(`mtpub/${validTok(token)}`);
  if (!ref) throw new HttpError(404, 'This meal train link isn’t active anymore. Ask the coordinator for a new one.');
  const [t, group] = await Promise.all([get(`g/${ref.gid}/meals/${ref.mtid}`), get(`groups/${ref.gid}`)]);
  if (!t || !group || !featuresOf(group).meals) throw new HttpError(404, 'This meal train isn’t available anymore.');
  return { t, group };
}
async function slotFromManage(token) {
  const ref = await get(`mtmanage/${validTok(token)}`);
  if (!ref) throw new HttpError(404, 'This sign-up link isn’t valid anymore — the sign-up may have been cancelled.');
  const [t, group, slot] = await Promise.all([get(`g/${ref.gid}/meals/${ref.mtid}`), get(`groups/${ref.gid}`), get(mtSlotKey(ref.gid, ref.mtid, ref.date))]);
  if (!t || !group || !slot || slot.manage !== token) throw new HttpError(404, 'This sign-up isn’t active anymore.');
  return { t, group, slot };
}
function readVolunteer(body, needContact) {
  const name = str(body.name, 80), email = str(body.email, 200).toLowerCase(), phone = str(body.phone, 40), dish = str(body.dish, 160), note = str(body.note, 500);
  if (needContact) {
    if (!name) throw new HttpError(400, 'Please enter your name.');
    if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email so we can send you the details.');
  }
  if (!dish) throw new HttpError(400, 'What are you planning to bring? (“Not sure yet” is fine.)');
  return { name, email, phone, dish, note };
}
function checkDateOpen(t, date, slotTaken) {
  if (t.status !== 'open') throw new HttpError(400, 'Sign-ups for this meal train are closed.');
  if (!isDate(date) || !trainDates(t).includes(date)) throw new HttpError(400, 'Please choose one of the meal train’s dates.');
  if (date < todayIn(t.tz)) throw new HttpError(400, 'That date has already passed.');
  if (slotTaken) throw new HttpError(409, 'Someone just signed up for that date. Please pick another.');
}
async function createSlot(ctx, group, t, date, v, userId) {
  checkDateOpen(t, date, await get(mtSlotKey(group.id, t.id, date)));
  const slot = { date, ...v, userId: userId || null, manage: newToken(), at: now() };
  await put(mtSlotKey(group.id, t.id, date), slot);
  await put(`mtmanage/${slot.manage}`, { gid: group.id, mtid: t.id, date });
  volunteerEmail(ctx, group, t, slot, 'confirm');
  ctx.background(coordinatorEmail(ctx, group, t, slot, 'signup'));
  return slot;
}
async function moveSlot(ctx, group, t, slot, changes) {
  const next = { ...slot, ...changes, updatedAt: now() };
  if (changes.date && changes.date !== slot.date) {
    checkDateOpen(t, changes.date, await get(mtSlotKey(group.id, t.id, changes.date)));
    next.remindedAt = null;
    await put(mtSlotKey(group.id, t.id, next.date), next);
    await del(mtSlotKey(group.id, t.id, slot.date));
    await put(`mtmanage/${slot.manage}`, { gid: group.id, mtid: t.id, date: next.date });
    volunteerEmail(ctx, group, t, next, 'moved');
    ctx.background(coordinatorEmail(ctx, group, t, next, 'moved', slot.date));
  } else {
    await put(mtSlotKey(group.id, t.id, slot.date), next);
  }
  return next;
}
async function removeSlot(ctx, group, t, slot, why) { // why: 'self' | 'coordinator' | 'train'
  await del(mtSlotKey(group.id, t.id, slot.date));
  await del(`mtmanage/${slot.manage}`);
  if (why !== 'self' && slot.date >= todayIn(t.tz)) volunteerEmail(ctx, group, t, slot, why === 'train' ? 'train-cancelled' : 'removed');
  if (why === 'self') ctx.background(coordinatorEmail(ctx, group, t, slot, 'cancel'));
}

// ---- Meal train emails ----
function mealDetailsHtml(t, slot, withAddress) {
  return detailRows([
    ['When', `${fmtDate(slot.date)}${t.dropStart ? '\n' + dropWindow(t, slot.date) : ''}`],
    ['Where', withAddress ? t.address : ''], ['Contact', withAddress ? t.contactPhone : ''],
    ['Bringing', slot.dish], ['Serving', t.headcount], ['Allergies', t.dietary], ['Drop-off', t.instructions], ['About', t.note],
  ]);
}
function volunteerEmail(ctx, group, t, slot, kind) {
  if (!slot.email) return;
  const when = fmtDate(slot.date);
  const subj = {
    confirm: `You’re signed up: meal for ${forWhom(t)} on ${when}`,
    moved: `Updated: meal for ${forWhom(t)} on ${when}`,
    remind: `Reminder: your meal for ${forWhom(t)} is tomorrow`,
    removed: `Your meal sign-up for ${when} was cancelled`,
    'train-cancelled': `Meal train for ${forWhom(t)} was cancelled`,
  }[kind];
  const gone = kind === 'removed' || kind === 'train-cancelled';
  const intro = {
    confirm: `Thank you, ${esc(firstName(slot.name))}! You’re bringing a meal to <b>${esc(forWhom(t))}</b>. Here are the details:`,
    moved: `Your sign-up moved to <b>${esc(when)}</b>. Here are the updated details:`,
    remind: `Just a reminder that you’re bringing a meal to <b>${esc(forWhom(t))}</b> tomorrow. Thank you!`,
    removed: `The coordinator cancelled your sign-up for <b>${esc(when)}</b> on the meal train for ${esc(forWhom(t))}. You don’t need to bring anything that day. If that’s a surprise, reach out to the coordinator.`,
    'train-cancelled': `The meal train for <b>${esc(forWhom(t))}</b> has been cancelled, so you don’t need to bring your meal on ${esc(when)}. Thank you for signing up.`,
  }[kind];
  const html = emailShell(`${t.title}`, esc(subj), `<p style="margin:0 0 8px">${intro}</p>${gone ? '' : mealDetailsHtml(t, slot, true)}`,
    gone ? 'Open meal train' : 'View or change your sign-up', gone ? publicLink(t) : manageLink(slot),
    `You signed up through ${group.name}’s meal train on ${APP_NAME()}.`);
  const text = `${subj}\n\n${gone ? '' : `When: ${when}${t.dropStart ? ', ' + dropWindow(t, slot.date) : ''}\n${t.address ? 'Where: ' + t.address + '\n' : ''}Bringing: ${slot.dish}\n${t.dietary ? 'Allergies & food notes: ' + t.dietary + '\n' : ''}\nChange or cancel: ${manageLink(slot)}`}`;
  ctx.background(sendEmail({ to: slot.email, subject: subj, html, text, gid: group.id }));
}
async function coordinatorEmail(ctx, group, t, slot, kind, fromDate) {
  const ids = [...new Set([t.createdBy, ...(t.coordinators || [])])];
  const users = (await Promise.all(ids.map((id) => get(`users/${id}`)))).filter((u) => u && u.notify !== false && u.id !== slot.userId);
  if (!users.length) return;
  const when = fmtDate(slot.date);
  const subj = { signup: `${slot.name} signed up for ${when}`, cancel: `${slot.name} cancelled ${when}`, moved: `${slot.name} moved to ${when}` }[kind] + ` · ${t.title}`;
  const body = `<p style="margin:0 0 8px">${esc(slot.name)} ${kind === 'signup' ? 'signed up to bring a meal' : kind === 'cancel' ? 'cancelled their meal' : `moved their meal from ${esc(fmtDate(fromDate))}`}.</p>` +
    detailRows([['Date', when], ['Bringing', kind === 'cancel' ? '' : slot.dish], ['Email', slot.email], ['Phone', slot.phone], ['Note', slot.note]]);
  const html = emailShell(group.name, esc(subj.split(' · ')[0]), body, 'Open meal train', deepLink(group.id, `meals/${t.id}`), `You’re a coordinator of ${t.title}.`);
  return sendEmail({ to: users.map((u) => u.email), subject: `[${group.name}] ${subj}`, html, text: `${subj}\n${deepLink(group.id, `meals/${t.id}`)}`, gid: group.id });
}
function notifyNewTrain(ctx, group, t, byName, byId) {
  if (!notifyOf(group).meal) return;
  const range = `${fmtDate(t.start).replace(/, \d{4}$/, '')} – ${fmtDate(t.end)}`;
  return notifyGroup('meal', ctx, group, `Meal train: ${t.recipient}`, `Meal train for ${esc(t.recipient)}`,
    `<p style="margin:0 0 8px">${esc(byName)} started a meal train. Pick a day to bring a meal.</p>${detailRows([['Dates', range], ['Drop-off', t.dropStart ? dropWindow(t, t.start) : ''], ['Allergies', t.dietary], ['Details', t.note]])}`,
    'Sign up for a day', deepLink(group.id, `meals/${t.id}`),
    `${byName} started a meal train for ${t.recipient} (${range}). Sign up: ${deepLink(group.id, `meals/${t.id}`)}`, byId);
}

// ---- Group routes ----
route('GET', '/groups/:gid/meals', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const list = await listAll(`g/${m.group.id}/meals/`);
  const out = await Promise.all(list.map(async (t) => memberTrainOut(m, t, await mtSlots(m.group.id, t.id))));
  out.sort((a, b) => (a.status === b.status ? b.start.localeCompare(a.start) : a.status === 'open' ? -1 : 1));
  return { trains: out };
});
route('POST', '/groups/:gid/meals', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = { id: newId(), ...readTrainBody(body), status: 'open', token: newToken(), createdBy: m.user.id, createdAt: now() };
  if (!t.coordinators.includes(m.user.id)) t.coordinators.unshift(m.user.id);
  await put(`g/${m.group.id}/meals/${t.id}`, t);
  await put(`mtpub/${t.token}`, { gid: m.group.id, mtid: t.id });
  await put(`mtactive/${m.group.id}/${t.id}`, { gid: m.group.id, mtid: t.id });
  await notifyNewTrain(ctx, m.group, t, m.user.name, m.user.id);
  return { train: memberTrainOut(m, t, []) };
});
route('PUT', '/groups/:gid/meals/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  if (!canManageTrain(m, t)) throw new HttpError(403, 'Only this meal train’s coordinators or a group organizer can edit it.');
  const next = { ...t, ...readTrainBody(body), updatedAt: now() };
  if (!next.coordinators.length) next.coordinators = [t.createdBy];
  const slots = await mtSlots(m.group.id, t.id), dates = new Set(trainDates(next));
  const orphan = slots.find((s) => !dates.has(s.date));
  if (orphan) throw new HttpError(400, `${orphan.name} is signed up for ${fmtDate(orphan.date)}. Keep that date, or remove their sign-up first.`);
  if (typeof body.status === 'string' && ['open', 'closed'].includes(body.status)) next.status = body.status;
  await put(`g/${m.group.id}/meals/${t.id}`, next);
  return { train: memberTrainOut(m, next, slots) };
});
route('POST', '/groups/:gid/meals/:id/status', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  if (!canManageTrain(m, t)) throw new HttpError(403, 'Only coordinators can do that.');
  const next = { ...t, status: body.status === 'closed' ? 'closed' : 'open', updatedAt: now() };
  await put(`g/${m.group.id}/meals/${t.id}`, next);
  return { train: memberTrainOut(m, next, await mtSlots(m.group.id, t.id)) };
});
route('POST', '/groups/:gid/meals/:id/new-link', async ({ req, params }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  if (!canManageTrain(m, t)) throw new HttpError(403, 'Only coordinators can do that.');
  const next = { ...t, token: newToken(), updatedAt: now() };
  await put(`mtpub/${next.token}`, { gid: m.group.id, mtid: t.id });
  await del(`mtpub/${t.token}`);
  await put(`g/${m.group.id}/meals/${t.id}`, next);
  return { train: memberTrainOut(m, next, await mtSlots(m.group.id, t.id)) };
});
route('DELETE', '/groups/:gid/meals/:id', async ({ req, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  if (!canManageTrain(m, t)) throw new HttpError(403, 'Only coordinators can delete this meal train.');
  for (const s of await mtSlots(m.group.id, t.id)) await removeSlot(ctx, m.group, t, s, 'train');
  await Promise.all([del(`mtpub/${t.token}`), del(`mtactive/${m.group.id}/${t.id}`), del(`g/${m.group.id}/meals/${t.id}`)]);
  return { ok: true };
});
// A member signs up in the app with their account details
route('POST', '/groups/:gid/meals/:id/signup', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  const v = readVolunteer(body, false);
  await createSlot(ctx, m.group, t, str(body.date, 10), { ...v, name: m.user.name, email: m.user.email, phone: m.user.phone || '' }, m.user.id);
  return { train: memberTrainOut(m, t, await mtSlots(m.group.id, t.id)) };
});
route('PUT', '/groups/:gid/meals/:id/slots/:date', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  const slot = isDate(params.date) && await get(mtSlotKey(m.group.id, t.id, params.date));
  if (!slot) throw new HttpError(404, 'Sign-up not found.');
  if (slot.userId !== m.user.id) throw new HttpError(403, 'You can only change your own sign-up.');
  const v = readVolunteer({ ...slot, ...body }, false);
  await moveSlot(ctx, m.group, t, slot, { dish: v.dish, note: v.note, ...(body.date && body.date !== slot.date ? { date: str(body.date, 10) } : {}) });
  return { train: memberTrainOut(m, t, await mtSlots(m.group.id, t.id)) };
});
route('DELETE', '/groups/:gid/meals/:id/slots/:date', async ({ req, params, ctx }) => {
  const m = await requireMember(req, params.gid); requireFeature(m, 'meals');
  const t = await getTrain(m.group.id, params.id);
  const slot = isDate(params.date) && await get(mtSlotKey(m.group.id, t.id, params.date));
  if (!slot) throw new HttpError(404, 'Sign-up not found.');
  const own = slot.userId === m.user.id;
  if (!own && !canManageTrain(m, t)) throw new HttpError(403, 'You can only cancel your own sign-up.');
  await removeSlot(ctx, m.group, t, slot, own ? 'self' : 'coordinator');
  return { train: memberTrainOut(m, t, await mtSlots(m.group.id, t.id)) };
});

// ---- Public routes (no account) ----
route('GET', '/public/meals/:token', async ({ params }) => {
  const { t, group } = await trainFromPublic(params.token);
  return { train: publicTrainOut(t, await mtSlots(group.id, t.id), group.name) };
});
route('POST', '/public/meals/:token/signup', async ({ body, params, ctx }) => {
  rateLimit('mt:' + ctx.ip, 12, 15 * 60e3);
  if (str(body.website, 200)) throw new HttpError(400, 'Something went wrong. Please try again.'); // honeypot for bots
  const { t, group } = await trainFromPublic(params.token);
  const slot = await createSlot(ctx, group, t, str(body.date, 10), readVolunteer(body, true), null);
  return { manage: slot.manage, slot: { date: slot.date, name: slot.name, dish: slot.dish, note: slot.note, email: slot.email, phone: slot.phone },
    details: volunteerDetails(t), train: publicTrainOut(t, await mtSlots(group.id, t.id), group.name) };
});
const manageOut = async (t, group, slot) => ({ token: t.token, slot: { date: slot.date, name: slot.name, dish: slot.dish, note: slot.note || '', email: slot.email, phone: slot.phone || '' },
  details: volunteerDetails(t), train: publicTrainOut(t, await mtSlots(group.id, t.id), group.name) });
route('GET', '/public/meal-signup/:token', async ({ params }) => {
  const { t, group, slot } = await slotFromManage(params.token);
  return manageOut(t, group, slot);
});
route('PUT', '/public/meal-signup/:token', async ({ body, params, ctx }) => {
  rateLimit('mtm:' + ctx.ip, 30, 15 * 60e3);
  const { t, group, slot } = await slotFromManage(params.token);
  const v = readVolunteer({ ...slot, ...body }, true);
  const next = await moveSlot(ctx, group, t, slot, { name: v.name, email: v.email, phone: v.phone, dish: v.dish, note: v.note, ...(body.date && body.date !== slot.date ? { date: str(body.date, 10) } : {}) });
  return manageOut(t, group, next);
});
route('DELETE', '/public/meal-signup/:token', async ({ params, ctx }) => {
  const { t, group, slot } = await slotFromManage(params.token);
  await removeSlot(ctx, group, t, slot, 'self');
  return { ok: true, token: t.token };
});

// ---- Day-before reminders (run hourly by the meal-reminders scheduled function) ----
export async function runMealReminders(context) {
  useStoreFor(context);
  const pending = [], ctx = { background: (p) => pending.push(p) };
  let sent = 0;
  for (const key of await keys('mtactive/')) {
    const ref = await get(key);
    const t = ref && await get(`g/${ref.gid}/meals/${ref.mtid}`);
    const group = t && await get(`groups/${ref.gid}`);
    if (!t || !group) { await del(key); continue; }
    const today = todayIn(t.tz);
    if (t.end < addDays(today, -1)) { await del(key); continue; } // finished
    if (!featuresOf(group).meals) continue;
    let hour = 12;
    try { hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: t.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date())); } catch {}
    if (hour < 9) continue; // send the day before, from 9 AM local
    const tomorrow = addDays(today, 1);
    const slot = await get(mtSlotKey(group.id, t.id, tomorrow));
    if (!slot || slot.remindedAt) continue;
    if (Date.now() - Date.parse(slot.updatedAt || slot.at) < 6 * 3600e3) { await put(mtSlotKey(group.id, t.id, tomorrow), { ...slot, remindedAt: now() }); continue; } // just signed up — confirmation covers it
    volunteerEmail(ctx, group, t, slot, 'remind');
    await put(mtSlotKey(group.id, t.id, tomorrow), { ...slot, remindedAt: now() });
    sent++;
  }
  await Promise.allSettled(pending);
  return sent;
}

// --- Events ---
route('GET', '/groups/:gid/events', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const [events, names, bring] = await Promise.all([listAll(`g/${m.group.id}/events/`), nameMap(m.group.id), listAll(`g/${m.group.id}/bring/`)]);
  const byTarget = {};
  for (const c of bring) (byTarget[c.target] ||= []).push(c);
  return { events: events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((e) => eventOut(e, names, byTarget[`e-${e.id}`], m.user.id)) };
});

route('POST', '/groups/:gid/events', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
  const ev = { id: newId(), ...readEventBody(body), createdBy: m.user.id, pollId: null, createdAt: now() };
  await put(`g/${m.group.id}/events/${ev.id}`, ev);
  await notifyNewEvent(ctx, m.group, ev, m.user.name, false);
  return { event: eventOut(ev, { [m.user.id]: m.user.name }, [], m.user.id) };
});

route('PUT', '/groups/:gid/events/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const key = `g/${m.group.id}/events/${validId(params.id)}`;
  const ev = await get(key);
  if (!ev) throw new HttpError(404, 'Event not found.');
  if (!canModify(m, ev.createdBy)) throw new HttpError(403, 'Only the person who added this event can edit it.');
  const next = { ...ev, ...readEventBody(body), updatedAt: now() };
  await put(key, next);
  return { event: await eventOutOne(m.group.id, next, await nameMap(m.group.id), m.user.id) };
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
  return { event: await eventOutOne(m.group.id, ev, await nameMap(m.group.id), m.user.id) };
});

// --- Polls ---
// Three kinds: 'dates' (vote Yes/Maybe/No on dates, then schedule one), 'pitchin' (food sign-up),
// 'choice' (general multiple choice). Any kind can collect anonymous responses.
function readDateOptions(body, existing) {
  const seen = new Set(), options = [], cleared = new Set();
  for (const o of (Array.isArray(body.options) ? body.options : []).slice(0, 30)) {
    const date = str(o?.date, 10), time = str(o?.time, 5), tz = time ? validTz(o?.tz) : '';
    if (!isDate(date) || !isTime(time) || seen.has(date + time + tz)) continue;
    seen.add(date + time + tz);
    const prev = existing && typeof o.id === 'string' ? existing.get(o.id) : null;
    if (prev) {
      // answered for a different time (a zone added to an older option doesn't count as a change)
      if (prev.date !== date || prev.time !== time || (prev.tz && prev.tz !== tz)) cleared.add(prev.id);
      options.push({ id: prev.id, date, time, tz });
    } else options.push({ id: newId(), date, time, tz });
  }
  if (options.length < 2) throw new HttpError(400, 'Add at least two date options for people to vote on.');
  options.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { options, cleared };
}
function readChoiceOptions(body, existing) {
  const seen = new Set(), options = [], cleared = new Set();
  for (const o of (Array.isArray(body.options) ? body.options : []).slice(0, 20)) {
    const text = str(o?.text, 200), k = text.toLowerCase();
    if (!text || seen.has(k)) continue;
    seen.add(k);
    const prev = existing && typeof o.id === 'string' ? existing.get(o.id) : null;
    if (prev) {
      if (prev.text.toLowerCase() !== k) cleared.add(prev.id); // reworded into a different answer
      options.push({ id: prev.id, text });
    } else options.push({ id: newId(), text });
  }
  if (options.length < 2) throw new HttpError(400, 'Add at least two answers for people to choose from.');
  return { options, cleared };
}
async function getPoll(m, id) {
  const pk = `g/${m.group.id}/polls/${validId(id)}`;
  const poll = await get(pk);
  if (!poll) throw new HttpError(404, 'Poll not found.');
  return { pk, poll };
}
// Move a pitch-in poll's sign-ups onto a calendar event (merging with anything already there), then retire the poll
async function linkPitchinToEvent(m, poll, eventId) {
  const ek = `g/${m.group.id}/events/${validId(eventId)}`;
  const ev = await get(ek);
  if (!ev) throw new HttpError(404, 'That event no longer exists.');
  for (const c of await listAll(bringPrefix(m.group.id, `p-${poll.id}`))) {
    const key = bringPrefix(m.group.id, `e-${ev.id}`) + c.userId;
    const prev = await get(key);
    const items = [...(prev ? contribItems(prev) : []), ...contribItems(c)].slice(0, 15);
    await put(key, { target: `e-${ev.id}`, userId: c.userId, items, at: prev?.at || c.at });
  }
  const next = { ...ev, pitchIn: true, bringAnon: !!ev.bringAnon || !!poll.anonymous, description: ev.description || poll.description || '', updatedAt: now() };
  await put(ek, next);
  await clearContributions(m.group.id, `p-${poll.id}`);
  await del(`g/${m.group.id}/polls/${poll.id}`);
  return next;
}

route('GET', '/groups/:gid/polls', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const [polls, names] = await Promise.all([listAll(`g/${m.group.id}/polls/`), nameMap(m.group.id)]);
  polls.sort((a, b) => (b.status === 'open') - (a.status === 'open') || b.createdAt.localeCompare(a.createdAt));
  return { polls: await Promise.all(polls.map((p) => pollOut(m.group.id, p, names, m.user.id))) };
});

route('POST', '/groups/:gid/polls', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
  const type = POLL_TYPES.includes(body.type) ? body.type : 'dates';
  const title = str(body.title, 160);
  if (!title) throw new HttpError(400, type === 'choice' ? 'Please add a question.' : 'Please add a title.');
  const base = { id: newId(), type, title, description: str(body.description, 4000), anonymous: !!body.anonymous, status: 'open',
    createdBy: m.user.id, createdAt: now() };
  let poll;
  if (type === 'dates') {
    poll = { ...base, location: str(body.location, 200), cost: parseCost(body.cost), options: readDateOptions(body).options,
      pitchIn: !!body.pitchIn, eventId: null, scheduledOptionId: null };
  } else if (type === 'choice') {
    poll = { ...base, options: readChoiceOptions(body).options, multi: !!body.multi };
  } else {
    // Pitch-in: if they picked an event, the sign-up lives on that event instead of a separate poll
    if (body.eventId) {
      const ek = `g/${m.group.id}/events/${validId(str(body.eventId, 40))}`;
      const ev = await get(ek);
      if (!ev) throw new HttpError(404, 'That event no longer exists.');
      const next = { ...ev, pitchIn: true, bringAnon: !!ev.bringAnon || !!body.anonymous, description: ev.description || base.description, updatedAt: now() };
      await put(ek, next);
      return { event: await eventOutOne(m.group.id, next, await nameMap(m.group.id), m.user.id), linked: true };
    }
    poll = { ...base, location: str(body.location, 200), options: [], pitchIn: true, eventId: null };
  }
  await put(`g/${m.group.id}/polls/${poll.id}`, poll);
  await notifyNewPoll(ctx, m.group, poll, m.user.name);
  return { poll: await pollOut(m.group.id, poll, { [m.user.id]: m.user.name }, m.user.id) };
});

route('PUT', '/groups/:gid/polls/:id', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const { pk, poll } = await getPoll(m, params.id);
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll or a group organizer can edit it.');
  if (poll.status === 'scheduled') throw new HttpError(400, 'A date has already been picked for this poll. Edit the calendar event instead.');
  const type = pollType(poll);
  const title = str(body.title, 160);
  if (!title) throw new HttpError(400, 'Please add a title.');
  // Responses collected anonymously stay anonymous; a named poll can be made anonymous
  const anonymous = !!poll.anonymous || !!body.anonymous;
  let next = { ...poll, type, title, description: str(body.description, 4000), anonymous, updatedAt: now() };
  let keep = null, cleared = new Set();
  if (type === 'dates') {
    const r = readDateOptions(body, new Map((poll.options || []).map((o) => [o.id, o])));
    next = { ...next, location: str(body.location, 200), cost: parseCost(body.cost), options: r.options, pitchIn: !!body.pitchIn };
    keep = new Set(r.options.map((o) => o.id)); cleared = r.cleared;
  } else if (type === 'choice') {
    const r = readChoiceOptions(body, new Map((poll.options || []).map((o) => [o.id, o])));
    next = { ...next, options: r.options, multi: !!body.multi };
    keep = new Set(r.options.map((o) => o.id)); cleared = r.cleared;
  } else {
    next = { ...next, location: str(body.location, 200) };
  }
  if (keep) { // drop answers only for removed options and options that changed meaning
    for (const k of await keys(`g/${m.group.id}/votes/${poll.id}/`)) {
      const v = await get(k);
      if (!v) continue;
      let changed = false;
      for (const optId of Object.keys(v.answers)) if (!keep.has(optId) || cleared.has(optId)) { delete v.answers[optId]; changed = true; }
      if (type === 'choice' && !next.multi && Object.keys(v.answers).length > 1) { // switched to one answer: keep the most recent single pick
        const firstKept = Object.keys(v.answers).find((id) => keep.has(id));
        v.answers = firstKept ? { [firstKept]: v.answers[firstKept] } : {}; changed = true;
      }
      if (!changed) continue;
      if (Object.keys(v.answers).length) await put(k, v); else await del(k);
    }
  }
  await put(pk, next);
  return { poll: await pollOut(m.group.id, next, await nameMap(m.group.id), m.user.id) };
});

route('PUT', '/groups/:gid/polls/:id/bring', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const { poll } = await getPoll(m, params.id);
  if (!(pollType(poll) === 'pitchin' || poll.pitchIn)) throw new HttpError(400, 'This poll isn’t collecting pitch-in items.');
  if (poll.status === 'scheduled') throw new HttpError(400, 'A date has been picked — add what you’re bringing on the calendar event instead.');
  if (poll.status === 'closed') throw new HttpError(400, 'This sign-up is closed.');
  await saveContribution(m.group.id, `p-${poll.id}`, m.user.id, body);
  return { poll: await pollOut(m.group.id, poll, await nameMap(m.group.id), m.user.id) };
});

route('POST', '/groups/:gid/polls/:id/vote', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const { poll } = await getPoll(m, params.id);
  const type = pollType(poll);
  if (type === 'pitchin') throw new HttpError(400, 'Sign up with what you’re bringing instead.');
  if (poll.status !== 'open') throw new HttpError(400, type === 'dates' ? 'This poll is closed — a date has already been picked.' : 'This poll is closed.');
  const key = `g/${m.group.id}/votes/${poll.id}/${m.user.id}`;
  const mine = (await get(key)) || { userId: m.user.id, answers: {} };
  const ids = new Set(poll.options.map((o) => o.id));
  if (type === 'choice') {
    const picks = [...new Set((Array.isArray(body?.choices) ? body.choices : []).filter((id) => ids.has(id)))];
    if (!poll.multi && picks.length > 1) throw new HttpError(400, 'Pick just one answer.');
    mine.answers = Object.fromEntries(picks.map((id) => [id, 'x']));
  } else {
    for (const [optId, answer] of Object.entries(body?.votes || {})) {
      if (!ids.has(optId)) continue;
      if (answer === null || answer === '') delete mine.answers[optId];
      else if (['yes', 'maybe', 'no'].includes(answer)) mine.answers[optId] = answer;
    }
  }
  mine.at = now();
  if (Object.keys(mine.answers).length) await put(key, mine); else await del(key);
  return { poll: await pollOut(m.group.id, poll, await nameMap(m.group.id), m.user.id) };
});

// Close or reopen a multiple-choice or pitch-in poll
route('POST', '/groups/:gid/polls/:id/status', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const { pk, poll } = await getPoll(m, params.id);
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll or a group organizer can close it.');
  if (pollType(poll) === 'dates') throw new HttpError(400, 'Date polls close when you schedule a date.');
  const next = { ...poll, status: body.status === 'closed' ? 'closed' : 'open', closedAt: body.status === 'closed' ? now() : null };
  await put(pk, next);
  return { poll: await pollOut(m.group.id, next, await nameMap(m.group.id), m.user.id) };
});

// Attach a pitch-in poll to a calendar event: sign-ups move to the event and the poll goes away
route('POST', '/groups/:gid/polls/:id/link-event', async ({ req, body, params }) => {
  const m = await requireMember(req, params.gid);
  const { poll } = await getPoll(m, params.id);
  if (pollType(poll) !== 'pitchin') throw new HttpError(400, 'Only pitch-in sign-ups can be linked to an event.');
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this sign-up or a group organizer can link it.');
  const ev = await linkPitchinToEvent(m, poll, str(body.eventId, 40));
  return { event: await eventOutOne(m.group.id, ev, await nameMap(m.group.id), m.user.id) };
});

route('POST', '/groups/:gid/polls/:id/schedule', async ({ req, body, params, ctx }) => {
  const m = await requireMember(req, params.gid);
  const { pk, poll } = await getPoll(m, params.id);
  if (pollType(poll) !== 'dates') throw new HttpError(400, 'Only date polls can be scheduled.');
  if (!canModify(m, poll.createdBy)) throw new HttpError(403, 'Only the person who created this poll can pick the final date.');
  if (poll.status !== 'open') throw new HttpError(400, 'A date has already been picked for this poll.');
  const opt = poll.options.find((o) => o.id === body.optionId);
  if (!opt) throw new HttpError(400, 'Please choose one of the poll’s dates.');
  const ev = { id: newId(), title: poll.title, description: poll.description, date: opt.date, time: opt.time, tz: opt.tz || '', cost: poll.cost,
    location: poll.location, pitchIn: !!poll.pitchIn, bringAnon: !!poll.anonymous, createdBy: m.user.id, pollId: poll.id, createdAt: now() };
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
  return { poll: await pollOut(m.group.id, next, names, m.user.id), event: await eventOutOne(m.group.id, ev, names, m.user.id) };
});

route('DELETE', '/groups/:gid/polls/:id', async ({ req, params }) => {
  const m = await requireMember(req, params.gid);
  const { pk, poll } = await getPoll(m, params.id);
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
  useStoreFor(context); // fresh store (and token) for every request; previews get their own data
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
      const limit = url.pathname === '/api/admin/backups/restore' ? 25_000_000 : 100_000; // backup files can be large
      if (text.length > limit) throw new HttpError(413, 'Request too large.');
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
  if (payload && payload.__redirect) return new Response(null, { status: 302, headers: { Location: payload.__redirect, 'Cache-Control': 'no-store' } });
  return new Response(JSON.stringify(payload), { status, headers });
}
