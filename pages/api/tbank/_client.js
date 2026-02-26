// pages/api/tbank/_client.js
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import { getTbankConfig } from './_config';

const tbankConfig = getTbankConfig();
const BASE = tbankConfig.partnerApiBase;
const OAUTH = `${(process.env.TBANK_OAUTH_URL || BASE).replace(/\/+$/, '')}/oauth/token`;
const BASIC = process.env.TBANK_OAUTH_BASIC || 'cGFydG5lcjpwYXJ0bmVy'; // 'partner:partner'
const LOGIN = process.env.TBANK_OAUTH_LOGIN;
const PASSWORD = process.env.TBANK_OAUTH_PASSWORD;

const DEBUG = String(process.env.TBANK_DEBUG || '').toLowerCase() === '1' || String(process.env.TBANK_DEBUG || '').toLowerCase() === 'true';

function maskSecret(s, left = 4, right = 4) {
  if (!s) return '(empty)';
  const str = String(s);
  if (str.length <= left + right) return str[0] + '***' + str[str.length - 1];
  return str.slice(0, left) + '…' + str.slice(-right);
}
function dlog(...args) { if (DEBUG) console.log('[TBANK]', ...args); }
function safeJSONStringify(obj) {
  try {
    return JSON.stringify(obj, (k, v) => {
      const key = k.toLowerCase();
      if (key.includes('password')) return maskSecret(v);
      if (key.includes('token')) return maskSecret(v);
      if (key.includes('authorization')) return '(masked)';
      return v;
    }, 2);
  } catch { return String(obj); }
}

/** mTLS агент (OAuth + sm-register) – поддерживает *_BASE64 и *_PEM_B64, а также *_PATH */
function buildHttpsAgent() {
  const insecure = String(process.env.TBANK_MTLS_INSECURE || '').toLowerCase() === 'true';
  let cert, key, ca;

  // Вариант 1: пути к PEM-файлам
  const certPath = process.env.TBANK_MTLS_CERT_PATH;
  const keyPath  = process.env.TBANK_MTLS_KEY_PATH;
  const caPath   = process.env.TBANK_MTLS_CA_PATH;
  if (certPath && keyPath) {
    try {
      cert = fs.readFileSync(certPath);
      key  = fs.readFileSync(keyPath);
      if (caPath && fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
      dlog('mTLS: using CERT/KEY from path', certPath, keyPath, caPath ? `(CA ${caPath})` : '');
      return new https.Agent({ cert, key, ca, rejectUnauthorized: !insecure });
    } catch (e) { dlog('mTLS: failed read path:', e?.message); }
  }

  // Вариант 2: base64 из env (оба имени поддержаны)
  const certB64 = process.env.TBANK_MTLS_CERT_BASE64 || process.env.TBANK_MTLS_CERT_PEM_B64;
  const keyB64  = process.env.TBANK_MTLS_KEY_BASE64  || process.env.TBANK_MTLS_KEY_PEM_B64;
  const caB64   = process.env.TBANK_MTLS_CA_BASE64   || process.env.TBANK_MTLS_CA_PEM_B64;

  if (certB64 && keyB64) {
    try {
      cert = Buffer.from(certB64, 'base64').toString('utf8');
      key  = Buffer.from(keyB64,  'base64').toString('utf8');
      if (caB64) ca = Buffer.from(caB64, 'base64').toString('utf8');
      dlog('mTLS: using CERT/KEY from base64 env');
      return new https.Agent({ cert, key, ca, rejectUnauthorized: !insecure });
    } catch (e) { dlog('mTLS: failed decode base64:', e?.message); }
  }

  dlog('mTLS: NO client certificate configured — OAuth will fail!');
  return undefined;
}

const httpsAgent = buildHttpsAgent();

function baseCfg(token) {
  return {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    httpsAgent,
    timeout: 20000,
    validateStatus: () => true,
  };
}

// ===== OAuth (grant_type=password, Basic partner:partner) ===== :contentReference[oaicite:3]{index=3}
export async function getAccessToken() {
  if (!LOGIN || !PASSWORD) throw new Error('TBANK_OAUTH_LOGIN / TBANK_OAUTH_PASSWORD are not set');

  const body = new URLSearchParams({ grant_type: 'password', username: LOGIN, password: PASSWORD });

  dlog('OAuth URL:', OAUTH);
  dlog('OAuth Basic:', maskSecret(BASIC));
  dlog('OAuth username:', LOGIN);
  dlog('OAuth password:', maskSecret(PASSWORD));
  dlog('OAuth mTLS agent:', httpsAgent ? 'ON' : 'OFF');

  const r = await axios.post(OAUTH, body.toString(), {
    headers: { Authorization: `Basic ${BASIC}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    httpsAgent,
    timeout: 20000,
    validateStatus: () => true,
  });

  dlog('OAuth ← status:', r.status);
  dlog('OAuth ← body:', typeof r.data === 'string' ? r.data : safeJSONStringify(r.data));

  if (r.status < 200 || r.status >= 300) throw new Error(`OAuth failed: ${r.status}`);
  const token = r?.data?.access_token;
  if (!token) throw new Error('Не получен access_token от Т-Банк');
  return token;
}

// ===== Вспомогательные нормализаторы =====
export function toBillingDescriptor(name) {
  const map = {А:'A',Б:'B',В:'V',Г:'G',Д:'D',Е:'E',Ё:'E',Ж:'ZH',З:'Z',И:'I',Й:'Y',К:'K',Л:'L',М:'M',Н:'N',О:'O',П:'P',Р:'R',С:'S',Т:'T',У:'U',Ф:'F',Х:'H',Ц:'C',Ч:'CH',Ш:'SH',Щ:'SCH',Ъ:'',Ы:'Y',Ь:'',Э:'E',Ю:'YU',Я:'YA',а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'};
  let s = (name || '').split('').map(ch => map[ch] ?? ch).join('');
  s = s.replace(/[^A-Za-z0-9.\-_ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = 'ONLOC';
  if (s.length > 14) s = s.slice(0, 14);
  return s;
}
export function parseAddress(src) {
  const s = (src || '').replace(/\s+/g, ' ').trim();
  const zip = (s.match(/(\b\d{6}\b)/) || [])[1];
  let city;
  const m = s.match(/(?:^|[, ]\s*)(?:г\.?|город)\s+([^,]+)/i);
  if (m) city = m[1].trim();
  if (!city) city = s.includes(',') ? s.slice(0, s.indexOf(',')).replace(/^,\s*/, '').trim() : s;
  let street = s.includes(',') ? s.split(',').slice(1).join(',').trim() : s;
  street = street.replace(new RegExp('^' + (city || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*,?\\s*', 'i'), '');
  return { zip, city: city || 'Москва', street: street || s || 'ул. Ленина, д. 1' };
}

// ===== sm-register =====
// Регистрация точки: POST /sm-register/register  (см. 1.3) :contentReference[oaicite:4]{index=4}
export async function tbankRegister(payload) {
  const token = await getAccessToken();
  const url = `${BASE}/sm-register/register`;
  dlog('REGISTER →', url);
  dlog('Payload:', safeJSONStringify(payload));
  const r = await axios.post(url, payload, { ...baseCfg(token), headers: { ...baseCfg(token).headers, 'Content-Type': 'application/json' } });
  dlog('REGISTER ← status:', r.status);
  dlog('REGISTER ← body:', safeJSONStringify(r.data));
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Register failed: ${r.status}`), { response: r });
  return r.data; // { code, shopCode, terminals: [] }
}

// Получение информации по точке: GET /sm-register/register/shop/{shopCode}  (см. 1.4) :contentReference[oaicite:5]{index=5}
export async function tbankGetShopByShopCode(shopCode) {
  const token = await getAccessToken();
  const url = `${BASE}/sm-register/register/shop/${encodeURIComponent(shopCode)}`;
  dlog('SHOP →', url);
  const r = await axios.get(url, baseCfg(token));
  dlog('SHOP ← status:', r.status);
  dlog('SHOP ← body:', safeJSONStringify(r.data));
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Shop info failed: ${r.status}`), { response: r });
  return r.data;
}

// Обновление банковских реквизитов точки: PATCH /sm-register/register/{shopCode}  (см. 2.2) :contentReference[oaicite:6]{index=6}
export async function tbankPatchShopBankAccount(shopCode, bankAccount) {
  const token = await getAccessToken();
  const url = `${BASE}/sm-register/register/${encodeURIComponent(shopCode)}`;
  const payload = { bankAccount };
  dlog('PATCH →', url);
  dlog('Payload:', safeJSONStringify(payload));
  const r = await axios.patch(url, payload, { ...baseCfg(token), headers: { ...baseCfg(token).headers, 'Content-Type': 'application/json' } });
  dlog('PATCH ← status:', r.status);
  dlog('PATCH ← body:', safeJSONStringify(r.data));
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Update failed: ${r.status}`), { response: r });
  return r.data; // { code, shopCode, terminals: [] }
}
