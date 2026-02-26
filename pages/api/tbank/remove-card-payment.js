// /pages/api/tbank/remove-card-payment.js
// Удаление ПЛАТЁЖНОЙ карты (EACQ, /v2/*) и чистка локальной записи в user_cards с card_scope='payment'.
//
// Сделан максимально совместимым по стилю логов и шагам с вашим текущим /api/tbank/remove-card
// (pre-GetCustomer → pre-GetCardList → RemoveCard → retry → локальная чистка), но:
//  - всегда используем ОПЛАТНЫЙ терминал: TerminalKey БЕЗ суффикса E2C;
//  - локально воздействуем только на записи user_cards с card_scope='payment'.
//
// Сохранённая совместимость и тон логов по образцу remove-card.js. :contentReference[oaicite:0]{index=0}

import crypto from 'crypto';
import { getTbankConfig } from './_config';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const tbankConfig = getTbankConfig();
const TBANK_BASE = tbankConfig.restBase;
const PASSWORD   = tbankConfig.terminalSecret || '';

// EACQ (оплаты): ключ БЕЗ E2C
const stripE2C = (tk) => (!tk ? tk : tk.replace(/E2C$/i, ''));
const TERMINAL_KEY = tbankConfig.terminalKeyEacq || stripE2C(tbankConfig.terminalKeyBase || '');

const LOGNS  = 'TBANK';
const METHOD = 'remove-card-payment';
const HIDDEN = '[hidden]';
const SCOPE  = 'payment';

function log(rid, msg, obj) {
  const base = `[${LOGNS}][${METHOD}][${rid}] ${msg}`;
  if (obj) console.log(base, obj); else console.log(base);
}

function apiPath(method) {
  // Для EACQ все методы по /v2/*
  return `/v2/${method}`;
}

// Token: добавляем Password в параметры, исключая служебные поля, сортируем и шифруем (как в remove-card.js). :contentReference[oaicite:1]{index=1}
function computeToken(payload) {
  const data = { ...payload, Password: PASSWORD };
  const keys = Object.keys(data)
    .filter(k => !['Token','DigestValue','SignatureValue','X509SerialNumber'].includes(k) && data[k] !== undefined && data[k] !== null)
    .sort();
  const concat = keys.map(k => String(data[k])).join('');
  const token = crypto.createHash('sha256').update(concat).digest('hex');
  return {
    token,
    debug: {
      orderedKeys: keys,
      concatenatedLen: concat.length,
      concatenatedPreview: concat.length > 40
        ? `${concat.slice(0,20)}.${concat.slice(-20)}`
        : concat,
      tokenPreview: token.slice(0, 8) + '.' + token.slice(-8),
    },
  };
}

async function tbankPost(rid, method, body, label) {
  const url = `${TBANK_BASE}${apiPath(method)}`;
  const payload = { ...body };
  const { token, debug } = computeToken(payload);
  payload.Token = token;

  log(rid, `${label || method}: token computed`, debug);
  log(rid, `${label || method}: POST`, {
    url,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: { ...body, Token: HIDDEN },
  });

  const t0 = Date.now();
  const resp = await fetch(url, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body   : JSON.stringify(payload),
  });
  const ms = Date.now() - t0;

  const contentType = resp.headers.get('content-type') || '';
  let json = null, text = null;
  try {
    if (contentType.includes('application/json')) json = await resp.json();
    else text = await resp.text();
  } catch {}

  const headers = {}; resp.headers.forEach((v,k)=>{ headers[k]=v; });
  log(rid, `${label || method}: response`, {
    httpStatus: resp.status, statusText: resp.statusText, ms,
    headers, contentType,
    rawTextPreview: text ? text.slice(0, 160) : null,
    jsonSummary: json ? (Array.isArray(json)
      ? { arr: true, len: json.length }
      : { Success: json.Success, ErrorCode: json.ErrorCode, Message: json.Message, Details: json.Details })
      : null,
  });

  return { ok: resp.ok, status: resp.status, json, text };
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '')
    .toString()
    .split(',')[0]
    .trim() || undefined;
}

export default async function handler(req, res) {
  const rid = uuidv4();

  try {
    log(rid, 'request start', { method: req.method, TBANK_BASE, TERMINAL_KEY: TERMINAL_KEY ? `${TERMINAL_KEY.slice(0,4)}...` : null });

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // auth
    const auth = req.headers.authorization || '';
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: 'No auth' });

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );
    const { data: userResp, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userResp?.user?.id) return res.status(401).json({ error: 'Auth failed' });

    const userId = userResp.user.id;
    const parsed  = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
    const uiCardId = String(parsed.cardId || '').trim();
    if (!uiCardId) return res.status(400).json({ error: 'cardId is required' });

    const clientIp = getClientIp(req);
    log(rid, 'pre-RemoveCard types', { typeofCardIdFromUi: typeof uiCardId, uiCardId, clientIp });

    // 1) GetCustomer — EACQ /v2/GetCustomer (как в базовом remove-card, но без E2C). :contentReference[oaicite:2]{index=2}
    {
      const pre = await tbankPost(rid, 'GetCustomer', { TerminalKey: TERMINAL_KEY, CustomerKey: userId }, 'GetCustomer');
      if (!pre.ok || pre.json?.Success !== true) {
        const msg = pre.json?.Message || pre.json?.Details || `GetCustomer HTTP ${pre.status}`;
        return res.status(400).json({ error: msg });
      }
    }

    // 2) GetCardList (pre) — проверим, что карта существует у банка и не D. Логи по образцу. :contentReference[oaicite:3]{index=3}
    const gl = await tbankPost(rid, 'GetCardList', { TerminalKey: TERMINAL_KEY, CustomerKey: userId }, 'GetCardList(pre)');
    const preOk = gl.ok && (Array.isArray(gl.json) || gl.json?.Success === true);
    if (!preOk) {
      const msg = gl.json?.Message || gl.json?.Details || `GetCardList HTTP ${gl.status}`;
      return res.status(400).json({ error: msg });
    }
    const preList = Array.isArray(gl.json) ? gl.json : (Array.isArray(gl.json?.Cards) ? gl.json.Cards : []);
    const sample  = preList.slice(0, 5).map(i => ({ CardId: i.CardId, RebillId: i.RebillId, Status: i.Status, ExpDate: i.ExpDate }));
    log(rid, 'GetCardList(pre): payload sample', { count: preList.length, items: sample });

    const found = preList.find(x => String(x.CardId) === uiCardId);
    const existsRemote = !!found;
    log(rid, 'precheck', { uiCardId, existsRemote, fromBank: found ? { CardId: found.CardId, RebillId: found.RebillId, Status: found.Status } : null });

    // Если у банка уже Status === 'D' — чистим локально в рамках СКОУПа 'payment' и выходим
    if (found && String(found.Status || '').toUpperCase() === 'D') {
      await supabase.from('user_cards').delete().eq('user_id', userId).eq('card_id', uiCardId).eq('card_scope', SCOPE);
      log(rid, 'bank shows Status=D — local cleaned (skip RemoveCard)');
      return res.status(200).json({ success: true, note: 'Already deleted at bank (Status=D), cleaned locally' });
    }

    // 3) RemoveCard (основная попытка, тип CardId строкой)
    const baseBody = {
      TerminalKey: TERMINAL_KEY,
      CustomerKey: userId,
      CardId     : String(uiCardId),
      ...(clientIp ? { IP: clientIp } : {}),
    };
    let rem = await tbankPost(rid, 'RemoveCard', baseBody, 'RemoveCard');

    // 4) Ретрай с числовым CardId (если неуспех и cardId числовой строкой), как в remove-card.js. :contentReference[oaicite:4]{index=4}
    if (!(rem.json?.Success === true) && /^\d+$/.test(uiCardId)) {
      const altBody = { ...baseBody, CardId: Number(uiCardId) };
      log(rid, 'RemoveCard(retry-alt-type)', { altType: typeof altBody.CardId, CardId: altBody.CardId });
      rem = await tbankPost(rid, 'RemoveCard', altBody, 'RemoveCard(retry-alt-type)');
    }

    // 5) Успех — чистим локально ТОЛЬКО записи со scope='payment'
    if (rem.json?.Success === true) {
      await supabase.from('user_cards').delete().eq('user_id', userId).eq('card_id', uiCardId).eq('card_scope', SCOPE);
      log(rid, 'bank remove success, deleted locally (payment scope)');
      return res.status(200).json({ success: true, status: rem.json?.Status || 'D' });
    }

    const errCode = rem.json?.ErrorCode;
    const errMsg  = rem.json?.Message || rem.json?.Details || 'RemoveCard failed';

    // 6) Битая подпись — 400
    if (errCode === '322') {
      log(rid, 'remove failed (bad signature)', { httpStatus: rem.status, errCode, errMsg });
      return res.status(400).json({ error: 'Неверная подпись запроса (Token).' });
    }

    // 7) «карта не найдена» — чистим локально по scope='payment', затем перепроверяем у банка
    if (errCode === '6' || (!existsRemote && errCode)) {
      await supabase.from('user_cards').delete().eq('user_id', userId).eq('card_id', uiCardId).eq('card_scope', SCOPE);

      const post = await tbankPost(rid, 'GetCardList', { TerminalKey: TERMINAL_KEY, CustomerKey: userId }, 'GetCardList(post)');
      const postOk = post.ok && (Array.isArray(post.json) || post.json?.Success === true);
      if (postOk) {
        const list = Array.isArray(post.json) ? post.json : (Array.isArray(post.json?.Cards) ? post.json.Cards : []);
        const stillThere = list.some(x => String(x.CardId) === uiCardId);
        if (!stillThere) return res.status(200).json({ success: true, note: 'Not found at bank, cleaned locally' });
      }
      return res.status(200).json({ success: true, note: 'Cleaned locally (bank error propagated)' });
    }

    return res.status(400).json({ error: errMsg, errorCode: errCode || null });
  } catch (e) {
    log(rid, 'unhandled', { error: String(e) });
    return res.status(500).json({ error: 'Internal error' });
  }
}
