// pages/api/tbank/add-customer.js
// A2C (выплаты): создаёт/проверяет Customer на ВЫПЛАТНОМ терминале (/e2c/v2/*),
// TerminalKey ДОЛЖЕН иметь суффикс E2C.

import { createClient } from '@supabase/supabase-js';
import crypto, { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const RAW_BASE = process.env.TBANK_API_BASE || 'https://rest-api-test.tinkoff.ru';
const TBANK_BASE = RAW_BASE.replace(/\/+$/, '');
const DEBUG_VERBOSE = process.env.TBANK_DEBUG_VERBOSE === '1';

const HIDDEN = '[hidden]';
const maskMid = (s, L = 10, R = 10) =>
  (typeof s === 'string' && s.length > L + R ? `${s.slice(0, L)}...${s.slice(-R)}` : s || '');
const maybeHide = (k, v) => {
  const low = (k || '').toLowerCase();
  if (!DEBUG_VERBOSE && (low.includes('token') || low.includes('secret') || low.includes('password'))) return HIDDEN;
  return v;
};
const sanitize = (obj) => {
  try {
    const c = JSON.parse(JSON.stringify(obj ?? {}));
    const w = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (['Authorization', 'Password', 'Token', 'TBANK_SECRET', 'SUPABASE_JWT_SECRET'].includes(k)) {
          o[k] = maybeHide(k, o[k]);
        } else if (typeof o[k] === 'string' && o[k].length > 140) {
          o[k] = DEBUG_VERBOSE ? o[k] : maskMid(o[k], 16, 16);
        } else if (typeof o[k] === 'object') {
          w(o[k]);
        }
      }
    };
    w(c);
    return c;
  } catch {
    return {};
  }
};
const logI = (cid, msg, extra = {}) => console.log(`[TBANK][add-customer][${cid}] ${msg}`, sanitize(extra));
const logE = (cid, msg, extra = {}) => console.error(`[TBANK][add-customer][${cid}] ${msg}`, sanitize(extra));

// Для A2C нужен ключ с суффиксом E2C
const ensureE2C = (tk) => (tk ? (/(E2C)$/i.test(tk) ? tk : `${tk}E2C`) : tk);

const tokenMaterials = (params) => {
  const withPwd = { ...params, Password: process.env.TBANK_SECRET ?? '' };
  const orderedKeys = Object.keys(withPwd)
    .filter((k) => !['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber'].includes(k))
    .sort();
  const parts = orderedKeys.map((k) => ({ key: k, value: String(withPwd[k]), len: String(withPwd[k]).length }));
  const concatenated = parts.map((p) => p.value).join('');
  const token = crypto.createHash('sha256').update(concatenated).digest('hex');
  return { token, orderedKeys, parts, concatenated };
};

const withToken = (label, cid, params) => {
  const m = tokenMaterials(params);
  logI(cid, `${label}: token computed`, {
    orderedKeys: m.orderedKeys,
    partsSummary: m.parts.map((p) => ({
      key: p.key,
      len: p.len,
      preview: DEBUG_VERBOSE ? p.value : maskMid(p.value, 8, 8),
    })),
    concatenatedLen: m.concatenated.length,
    concatenatedPreview: DEBUG_VERBOSE ? m.concatenated : maskMid(m.concatenated, 16, 16),
    tokenPreview: DEBUG_VERBOSE ? m.token : maskMid(m.token, 8, 8),
  });
  return { ...params, Token: m.token };
};

const postJson = async (cid, path, body, label) => {
  const url = `${TBANK_BASE}${path}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  logI(cid, `${label}: POST`, { url, headers, body });

  const t0 = Date.now();
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }).catch((e) => {
    logE(cid, `${label}: fetch error`, { error: String(e) });
    throw e;
  });
  const ms = Date.now() - t0;

  const respHeaders = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });
  const contentType = resp.headers.get('content-type') || '';
  let text = null,
    json = null;
  try {
    if (contentType.includes('application/json')) json = await resp.json();
    else text = await resp.text();
  } catch {}

  logI(cid, `${label}: response`, {
    httpStatus: resp.status,
    statusText: resp.statusText,
    ms,
    headers: respHeaders,
    contentType,
    jsonSummary: json ? { Success: json.Success, ErrorCode: json.ErrorCode, Message: json.Message } : undefined,
    textPreview: text ? text.slice(0, 160) : undefined,
  });

  return { resp, json, text, ms };
};

export default async function handler(req, res) {
  const cid = randomUUID();
  logI(cid, 'request start', { method: req.method, TBANK_BASE, protocol: 'A2C', pathBase: '/e2c/v2' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = req.headers.authorization?.split(' ')[1];
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(auth);
    if (userErr || !userRes?.user?.id) {
      logE(cid, 'supabase auth failed', { error: userErr?.message });
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = userRes.user.id;

    // A2C: ключ С СУФФИКСОМ E2C
    const TerminalKey = ensureE2C(process.env.TBANK_TERMINAL_KEY || '');
    if (!TerminalKey) return res.status(500).json({ error: 'Server misconfigured (TerminalKey)' });

    // 1) Проверяем, есть ли customer на A2C
    {
      const body = withToken('GetCustomer', cid, { TerminalKey, CustomerKey: userId });
      const { resp, json } = await postJson(cid, '/e2c/v2/GetCustomer', body, 'GetCustomer');
      if (resp.ok && json?.Success === true) {
        return res.status(200).json({ success: true, existed: true });
      }
    }

    // 2) Создаём customer на A2C
    {
      const profile = await supabase.from('profiles').select('email, phone').eq('user_id', userId).maybeSingle();

      const Email = profile?.data?.email || undefined;
      const Phone = profile?.data?.phone || undefined;

      const body = withToken('AddCustomer', cid, {
        TerminalKey,
        CustomerKey: userId,
        ...(Email ? { Email } : {}),
        ...(Phone ? { Phone } : {}),
      });
      const { resp, json } = await postJson(cid, '/e2c/v2/AddCustomer', body, 'AddCustomer');
      if (!resp.ok || json?.Success !== true) {
        return res.status(400).json({ error: json?.Message || 'AddCustomer failed', details: json?.Details });
      }
      return res.status(200).json({ success: true, created: true });
    }
  } catch (e) {
    logE(cid, 'unhandled error', { error: String(e) });
    return res.status(500).json({ error: 'Internal error' });
  }
}
