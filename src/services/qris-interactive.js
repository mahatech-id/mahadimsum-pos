/**
 * QRIS Interactive mutation adapter.
 *
 * This follows the public interface of restugbk/qris-interactive:
 *   QrisMerchantMutation(username, password, sessionFile)
 *   -> getMerchant()
 *   -> getTransactionsByRange(merchantId, DD/MM/YYYY, DD/MM/YYYY)
 *   -> getTransactionsByCustom(..., 'nominal', keyword)
 *
 * The upstream package is PHP and unofficial. MAHADIMSUM is Node/Express, so this
 * module keeps the same workflow in Node and persists cookies in a local session file.
 * Dashboard endpoints are configurable because the upstream library targets the
 * merchant dashboard's private endpoints, which can change without notice.
 */
const fs = require('fs');
const path = require('path');
const { getSetting } = require('../db');
const crypto = require('crypto');

// Unofficial mobile-app API client based on dianrp-space/interactive-qris-api.
// This is separate from the paid Open API and uses the merchant's own QRIS Interactive mobile-app login.
const APP = {
  SSO_BASES: ['https://myprofit.interactiveholic.net', 'https://cloud.interactive.co.id'],
  API_PATH: '/restapi/inholic-app/api',
  TX_BASE: 'https://api-app.qris.online',
  TX_PATH: '/restapi/backend/v2.1',
  QRIS_BASE: 'https://m.qris.online',
  QRIS_PATH: '/restapi/backend/v2',
  CLIENT_ID: 'YHhafu23897Hf289TFA8947Gf39GD274bgfy3YGuifa9bfay94GUg9FGgadifgvagfa9GUA3yf9238ag',
  CLIENT_SECRET: 'Hy6atVcmMcaoef638GYD24g',
  SIGNING_SECRET: 'qwqyuegwydadbvaq13g432h478hdgah3432ujk23823u327t24gy32742y3g42',
  SECRET_PREFIX: 'Qr!sPr1nt3d',
  HOMEPAGE: 'https://qris.online',
};
let appToken = null, appTokenExpires = 0, appTokenEmail = '', appLocation = null, appLocationEmail = '', appJwt = null, appJwtExpires = 0;
function b64url(value) { return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function md5(value) { return crypto.createHash('md5').update(String(value)).digest('hex'); }
function appEmail() { return getSetting('QRIS_INTERACTIVE_APP_EMAIL') || ''; }
function appPin() { return getSetting('QRIS_INTERACTIVE_APP_PIN') || ''; }
function appMidSetting() { return getSetting('QRIS_INTERACTIVE_APP_MID') || ''; }
function appConfiguredError() { const e = new Error('Integrasi QRIS Interactive mobile app belum dikonfigurasi. Isi QRIS_INTERACTIVE_APP_EMAIL (email login aplikasi QRIS Interactive), dan PIN bila diminta.'); e.code = 'QRIS_INTERACTIVE_NOT_CONFIGURED'; return e; }
async function appFetch(url, { method = 'GET', headers = {}, body, params } = {}) {
  if (params) { const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== null && v !== ''))).toString(); if (qs) url += (url.includes('?') ? '&' : '?') + qs; }
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 25000);
  try { const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.0 (dart:io)', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal }); const txt = await res.text(); let data; try { data = JSON.parse(txt); } catch { throw new Error(`Respons QRIS Interactive bukan JSON (HTTP ${res.status}).`); } if (!res.ok) throw new Error(`QRIS Interactive mobile API HTTP ${res.status}: ${String(data.message || data.error || 'request gagal').slice(0,180)}`); return data; }
  catch (e) { if (e.name === 'AbortError') throw new Error('Request ke QRIS Interactive timeout.'); throw e; } finally { clearTimeout(timer); }
}
async function getAppToken(force = false) {
  const email = appEmail(); if (!email) throw appConfiguredError();
  if (!force && appToken && appTokenEmail === email && Date.now() < appTokenExpires) return appToken;
  const now = new Date(Date.now() + 7*60*60*1000); const pad = n => String(n).padStart(2,'0'); const loginAt = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const body = { email, clientId: APP.CLIENT_ID, clientSecret: APP.CLIENT_SECRET, ipAddress: '1.1.1.1', deviceName: 'Android', loginAt, version_code: '1', version_name: '1.0.0' }; if (appPin()) body.pincode = appPin();
  let last; for (const base of APP.SSO_BASES) { try { const data = await appFetch(`${base}${APP.API_PATH}/auth/loginbyemail.php`, { method:'POST', body }); last = data; if (data.status === 'success' && data.token) { appToken = data.token; appTokenEmail = email; appTokenExpires = Date.now() + 14*24*3600*1000; appLocation = null; appLocationEmail = ''; appJwt = null; return appToken; } } catch(e) { last = { message:e.message }; } }
  throw new Error(`Login QRIS Interactive mobile app gagal: ${String(last?.message || 'akses ditolak').slice(0,180)}`);
}
async function getAppLocations(force = false) { const token = await getAppToken(); if (appLocation && appLocationEmail === appEmail() && !force) return appLocation; const data = await appFetch(`${APP.TX_BASE}${APP.TX_PATH}/getlocationqrisbyemail.php`, { headers:{ Authorization:`Bearer ${token}` }, params:{ force: force ? 'true':'false', hidePayment:'false' } }); const rows = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : []; if (!rows.length || !rows.some(x => x.mID)) throw new Error(`Akun mobile app tidak mengembalikan merchant/lokasi aktif: ${String(data.message || data.status || 'tidak ada lokasi').slice(0,150)}`); const configuredMid = appMidSetting(); const selected = configuredMid ? rows.find(x => String(x.mID) === String(configuredMid)) : rows[0]; if (configuredMid && !selected) throw new Error(`Merchant ID yang dikonfigurasi tidak cocok dengan lokasi akun mobile app. Lokasi yang tersedia: ${rows.map(x => `${x.mname || 'Merchant'} (${x.mID})`).join(', ')}`); appLocation = selected; appLocationEmail = appEmail(); return appLocation; }
async function getAppJwt() { if (appJwt && Date.now() < appJwtExpires) return appJwt; const loc = await getAppLocations(); const mID = String(loc.mID), email = String(loc.mpicemail || appEmail()), nmID = String(loc.mNMID || ''); const d = new Date(Date.now()+7*60*60*1000); const date = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`; const header = b64url(JSON.stringify({ alg:'HS256', typ:'JWT', iss:APP.HOMEPAGE })); const payload = b64url(JSON.stringify({ mID:md5(mID), email:md5(email), nmID:md5(nmID), secretKey:md5(`${APP.SECRET_PREFIX}${date}`), iat:Math.floor(Date.now()/1000) })); const input = `${header}.${payload}`; const sig = crypto.createHmac('sha256', APP.SIGNING_SECRET).update(input).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); appJwt = `${input}.${sig}`; appJwtExpires = Date.now()+23*3600*1000; return appJwt; }
async function generateAppInvoice(amount, info = '') { const n = Math.round(Number(amount)); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Nominal QRIS harus berupa rupiah integer lebih dari 0.'); const jwt = await getAppJwt(); const data = await appFetch(`${APP.TX_BASE}${APP.TX_PATH}/generate-qris-dinamis.php`, { method:'POST', headers:{ Authorization:`Bearer ${jwt}` }, body:{ gtotal:String(n), info:String(info || '').slice(0,100), disableTip:1 } }); const d = data?.data; if (data?.status !== 'success' || !d?.content || !d?.invoiceId || !d?.refNo) { const e = new Error(`Pembuatan invoice QRIS gagal: ${String(data?.message || data?.status || 'response tidak lengkap').slice(0,180)}`); e.providerResponse = data; throw e; } const loc = await getAppLocations(); let expires = d.expiredDate ? new Date(String(d.expiredDate).replace(' ','T') + (String(d.expiredDate).includes('+') ? '' : '+07:00')) : new Date(Date.now()+60*60*1000); if (!Number.isFinite(expires.getTime())) expires = new Date(Date.now()+60*60*1000); return { content:d.content, invoiceId:String(d.invoiceId), refNo:String(d.refNo), mID:String(loc.mID), merchantName:loc.mname || 'QRIS Interactive', nmid:loc.mNMID || null, expiresAt:expires.toISOString(), expiresInSeconds:Math.max(1,Math.floor((expires.getTime()-Date.now())/1000)), raw:data }; }
async function checkAppInvoicePayment(invoiceId, refNo, mid) { if (!invoiceId || !refNo) return null; const data = await appFetch(`${APP.QRIS_BASE}${APP.QRIS_PATH}/check-transaction-qris1.php`, { method:'POST', body:{ mID:String(mid || (await getAppLocations()).mID), invoiceId:String(invoiceId), refNo:String(refNo) } }); const d = data?.data || {}; if (data?.status === 'success' && d.dateSuccess && d.rrn) return { paid:true, amount:Number(d.amountPayed), referenceNo:String(d.rrn || d.tranId || invoiceId), invoiceId:String(d.invoiceId || invoiceId), data:d, raw:data }; return { paid:false, raw:data }; }

const DEFAULT_BASE = 'https://merchant.qris.interactive.co.id';

function cfg() {
  const username = getSetting('QRIS_INTERACTIVE_USERNAME');
  const password = getSetting('QRIS_INTERACTIVE_PASSWORD');
  const merchantId = getSetting('QRIS_INTERACTIVE_MERCHANT_ID') || getSetting('QRIS_MERCHANT_ID');
  if (!username || !password || !merchantId) {
    const err = new Error('QRIS Interactive belum dikonfigurasi. Isi username, password, dan merchant ID di Settings.');
    err.code = 'QRIS_INTERACTIVE_NOT_CONFIGURED';
    throw err;
  }
  return {
    baseUrl: (getSetting('QRIS_INTERACTIVE_BASE_URL') || DEFAULT_BASE).replace(/\/$/, ''),
    username,
    password,
    merchantId,
    loginPath: getSetting('QRIS_INTERACTIVE_LOGIN_PATH') || '/v2/m/login.php',
    merchantPath: getSetting('QRIS_INTERACTIVE_MERCHANT_PATH') || '/api/merchant',
    transactionPath: getSetting('QRIS_INTERACTIVE_TRANSACTION_PATH') || '/api/transaction',
    sessionFile: getSetting('QRIS_INTERACTIVE_SESSION_FILE') || path.join(process.cwd(), 'data', 'qris-interactive-session.json'),
  };
}

function readSession(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { cookies: {}, createdAt: 0 }; }
}
function writeSession(file, session) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
}
function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(existing, setCookieHeaders) {
  const out = { ...(existing || {}) };
  for (const header of setCookieHeaders || []) {
    const first = String(header).split(';', 1)[0];
    const idx = first.indexOf('=');
    if (idx > 0) out[first.slice(0, idx)] = first.slice(idx + 1);
  }
  return out;
}
async function responseJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function request(cfgx, url, options = {}, session) {
  const headers = { 'User-Agent': 'Mozilla/5.0 MAHADIMSUM-POS', ...(options.headers || {}) };
  const cookies = cookieHeader(session.cookies);
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  session.cookies = mergeCookies(session.cookies, setCookies);
  return res;
}

async function login(cfgx, session) {
  const url = `${cfgx.baseUrl}${cfgx.loginPath}`;
  const body = new URLSearchParams({ email: cfgx.username, username: cfgx.username, password: cfgx.password });
  const res = await request(cfgx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${cfgx.baseUrl}/v2/m/login.php` },
    body,
  }, session);
  if (![200, 302].includes(res.status)) {
    const text = await res.text();
    throw new Error(`Login QRIS Interactive gagal (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  session.loggedInAt = Date.now();
  writeSession(cfgx.sessionFile, session);
  return true;
}

async function ensureSession() {
  const cfgx = cfg();
  const session = readSession(cfgx.sessionFile);
  if (!session.cookies || !Object.keys(session.cookies).length || Date.now() - Number(session.loggedInAt || 0) > 24 * 3600 * 1000) {
    await login(cfgx, session);
  }
  return { cfg: cfgx, session };
}

function unwrap(data) {
  if (!data) return data;
  if (data.data) return data.data;
  if (data.result) return data.result;
  return data;
}

function normalizeTransactions(data) {
  const raw = unwrap(data);
  const arr = Array.isArray(raw) ? raw : (raw?.transactions || raw?.data?.transactions || []);
  return arr.map(t => ({
    transaction_id: Number(t.transaction_id ?? t.id ?? t.trx_id ?? 0),
    invoice_id: t.invoice_id ?? t.invoice ?? t.inv ?? null,
    date: t.date ?? t.created_at ?? t.transaction_date ?? null,
    amount: Number(t.amount ?? t.nominal ?? t.trxvalue ?? t.value ?? 0),
    amount_display: t.amount_display ?? null,
    status: String(t.status ?? t.qris_status ?? t.payment_status ?? '').trim(),
    payment_method: t.payment_method ?? t.payment_methodby ?? null,
    customer: t.customer ?? t.customer_name ?? t.qris_payment_customername ?? null,
    rrn: t.rrn ?? t.RRN ?? null,
    raw: t,
  }));
}

function dateDMY(date) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function parseTransactionDate(value) {
  if (!value) return NaN;
  const str = String(value).trim();
  let m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}+07:00`).getTime();
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}+07:00`).getTime();
  return new Date(str).getTime();
}

async function getMerchant() {
  const { cfg: cfgx, session } = await ensureSession();
  const url = new URL(cfgx.merchantPath, cfgx.baseUrl);
  url.searchParams.set('merchant_id', cfgx.merchantId);
  const res = await request(cfgx, url, {}, session);
  if (res.status === 401 || res.status === 403) { await login(cfgx, session); return getMerchant(); }
  const data = await responseJson(res);
  if (!res.ok) throw new Error(`Gagal mengambil merchant Interactive (HTTP ${res.status}).`);
  return data;
}

async function getTransactionsByRange(merchantId, startDate, endDate) {
  const { cfg: cfgx, session } = await ensureSession();
  const url = new URL(cfgx.transactionPath, cfgx.baseUrl);
  url.searchParams.set('merchant_id', merchantId || cfgx.merchantId);
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);
  const res = await request(cfgx, url, {}, session);
  if (res.status === 401 || res.status === 403) { await login(cfgx, session); return getTransactionsByRange(merchantId, startDate, endDate); }
  const data = await responseJson(res);
  if (!res.ok) throw new Error(`Gagal mengambil mutasi Interactive (HTTP ${res.status}).`);
  const transactions = normalizeTransactions(data);
  return { status: true, data: { total_records: transactions.length, summary_amount: transactions.reduce((s, t) => s + t.amount, 0), transactions } };
}

async function getTransactionsByCustom(merchantId, startDate, endDate, filterBy, keyword) {
  const result = await getTransactionsByRange(merchantId, startDate, endDate);
  const k = String(keyword).toLowerCase();
  const transactions = result.data.transactions.filter(t => {
    const field = filterBy === 'nominal' ? t.amount : filterBy === 'rrn' ? t.rrn : filterBy === 'inv' ? t.invoice_id : filterBy === 'csname' ? t.customer : t.raw?.infoket;
    return String(field ?? '').toLowerCase() === k;
  });
  return { status: true, data: { total_records: transactions.length, summary_amount: transactions.reduce((s, t) => s + t.amount, 0), transactions } };
}

async function findSuccessfulPayment({ amount, createdAt, expiresAt }) {
  const start = dateDMY(new Date(createdAt || Date.now() - 120000));
  const end = dateDMY(new Date(expiresAt || Date.now()));
  const result = await getTransactionsByCustom(cfg().merchantId, start, end, 'nominal', String(Math.round(Number(amount))));
  const min = new Date(createdAt || Date.now() - 120000).getTime() - 120000;
  const max = new Date(expiresAt || Date.now() + 60000).getTime() + 120000;
  const success = result.data.transactions.filter(t => {
    const status = t.status.toLowerCase();
    const ts = parseTransactionDate(t.date);
    return ['success', 'paid', 'berhasil'].includes(status) && Number(t.amount) === Math.round(Number(amount)) && (!Number.isFinite(ts) || (ts >= min && ts <= max));
  }).sort((a, b) => parseTransactionDate(b.date) - parseTransactionDate(a.date));
  return success[0] || null;
}

module.exports = { cfg, getMerchant, getTransactionsByRange, getTransactionsByCustom, findSuccessfulPayment, dateDMY, parseTransactionDate, generateAppInvoice, checkAppInvoicePayment, getAppLocations };
