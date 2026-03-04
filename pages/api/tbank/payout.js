// pages/api/tbank/payout.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { platformSettings } from '../../../lib/platformSettings';
import { calculateNetAmountAfterFees } from '../../../lib/tbankFees';
import { getTbankConfig } from './_config';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const tbankConfig = getTbankConfig();
const TBANK_E2C_BASE = tbankConfig.a2cBaseV2;

// ---------- utils ----------
const genReqId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const mask = (s, keepStart = 4, keepEnd = 4) => {
  if (!s) return s;
  const str = String(s);
  if (str.length <= keepStart + keepEnd) return '*'.repeat(Math.max(1, str.length - 1));
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
};
const maskToken = (t) => (t ? mask(t, 6, 6) : t);
const maskCardId = (c) => (c ? mask(c, 4, 4) : c);
const maskKey = (k) => (k ? mask(k, 4, 4) : k);
const log = (id, ...a) => console.log(`[payout][${id}]`, ...a);
const logErr = (id, ...a) => console.error(`[payout][${id}]`, ...a);

// ---------- JWT fallback ----------
function decodeJwtNoVerify(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function getAuthUserFromReq(req, reqId) {
  const bearer = req.headers.authorization?.replace('Bearer ', '').trim() || '';
  const cookieToken = req.cookies?.['sb-access-token'] || req.cookies?.['supabase-auth-token'] || null;
  const accessToken = bearer || cookieToken;
  log(reqId, 'Auth tokens:', {
    authzBearer: bearer ? `Bearer ${maskToken(bearer)}` : undefined,
    cookieToken: cookieToken ? maskToken(cookieToken) : undefined,
  });

  if (!accessToken) return { user: null, error: new Error('Token is empty') };
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);
    return { user: data?.user || null, error };
  } catch (e) {
    const decoded = decodeJwtNoVerify(accessToken);
    if (decoded?.sub) return { user: { id: decoded.sub }, error: null };
    return { user: null, error: e };
  }
}

// ---------- комиссии ----------
function computeNetFromGrossUsingTripPercents(gross, trip) {
  const platformPercent = Number.isFinite(Number(trip?.platform_fee))
    ? Number(trip.platform_fee)
    : Number(platformSettings?.platformFeePercent || 0);
  const tbankPercent = Number.isFinite(Number(trip?.tbank_fee))
    ? Number(trip.tbank_fee)
    : Number(platformSettings?.tbankFeePercent || 0);

  const { netAmount: net } = calculateNetAmountAfterFees(Number(gross), platformPercent, {
    cardFeePercent: tbankPercent,
    cardFeeMinRub: platformSettings.tbankCardFeeMinRub,
    payoutFeePercent: platformSettings.tbankPayoutFeePercent,
    payoutFeeMinRub: platformSettings.tbankPayoutFeeMinRub,
  });
  return { net, platformPercent, tbankPercent, totalPercent: null };
}

// ---------- Token генерация ----------
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function buildTokenWithPassword(params) {
  const pwd = tbankConfig.terminalSecret || '';
  const pairs = Object.entries({ ...params, Password: pwd })
    .filter(([k]) => !['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber'].includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const concat = pairs.map(([, v]) => String(v)).join('');
  return { token: sha256Hex(concat), concat, pwd };
}

// ---------- БД helpers ----------
async function getTrip(tripId) {
  const { data, error } = await supabase
    .from('trips')
    .select('id, creator_id, is_company_trip, deal_id, status, platform_fee, tbank_fee, title')
    .eq('id', tripId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getActiveCompanyForOrganizer(userId) {
  const { data, error } = await supabase
    .from('mycompany')
    .select('company_id, tbank_shop_code, is_active, verified, status')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getTripParticipant(tripId, participantId) {
  const { data, error } = await supabase
    .from('trip_participants')
    .select('id, user_id, status, approved_trip')
    .eq('id', participantId)
    .eq('trip_id', tripId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getLatestConfirmedParticipantPayment(tripId, participantUserId) {
  const { data, error } = await supabase
    .from('payments')
    .select('id, amount, status, payment_type, created_at')
    .eq('trip_id', tripId)
    .eq('participant_id', participantUserId)
    .eq('payment_type', 'participant_payment')
    .eq('status', 'confirmed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getOrganizerPayoutCardId(userId) {
  const { data, error } = await supabase
    .from('user_cards')
    .select('card_id, is_primary, created_at')
    .eq('user_id', userId)
    .eq('card_scope', 'payout')
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0]?.card_id) || null;
}

// === Финализация ===
async function getPaidUserIdsForTrip(tripId) {
  const { data, error } = await supabase
    .from('payments')
    .select('participant_id')
    .eq('trip_id', tripId)
    .eq('payment_type', 'participant_payment')
    .eq('status', 'confirmed');
  if (error) throw error;
  const ids = (data || []).map((r) => r.participant_id).filter(Boolean);
  return Array.from(new Set(ids));
}

async function countApprovedPaidParticipants(tripId, paidUserIds) {
  if (!paidUserIds.length) return 0;
  const { data, error } = await supabase
    .from('trip_participants')
    .select('user_id')
    .eq('trip_id', tripId)
    .in('user_id', paidUserIds)
    .eq('approved_trip', true);
  if (error) throw error;
  return (data || []).length;
}

async function archiveTripAndChats(tripId) {
  await supabase.from('trips').update({ status: 'archived' }).eq('id', tripId);
  await supabase
    .from('chats')
    .update({
      chat_type: 'archived',
      support_close_confirmed: true,
      support_close_requested_at: new Date().toISOString(),
    })
    .eq('trip_id', tripId)
    .neq('chat_type', 'archived');
}

// ---------- Вызовы E2C ----------
async function tbankInitAndPayment({
  reqId,
  amountKop,
  dealId,
  partnerId, // string | null
  cardId, // string | null
  finalPayout = true,
  orderId, // связываем с бронью из prepare_payout_atomic
paymentRecipientId,   // ← добавили
}) {
  const terminalKey = tbankConfig.terminalKeyA2c || `${tbankConfig.terminalKeyBase || ''}E2C`;

  // Безопасный OrderId ≤ 50 символов
  let safeOrderId = orderId && String(orderId).trim();
  if (!safeOrderId) {
    safeOrderId = crypto.randomBytes(12).toString('hex'); // 24 символа
  }
  if (safeOrderId.length > 50) {
    const sha1 = crypto.createHash('sha1').update(safeOrderId).digest('hex'); // 40
    safeOrderId = `o-${sha1.slice(0, 32)}`; // 34 символа
  }

  const initParams = {
    TerminalKey: terminalKey,
    Amount: amountKop,
    DealId: String(dealId),
    OrderId: safeOrderId,
    ...(finalPayout ? { FinalPayout: true } : {}),
    ...(partnerId ? { PartnerId: String(partnerId) } : {}),
    ...(cardId ? { CardId: String(cardId) } : {}),
...(paymentRecipientId ? { PaymentRecipientId: String(paymentRecipientId) } : {}),
  };

  const { token } = buildTokenWithPassword(initParams);
  const initBody = { ...initParams, Token: token };

  log(reqId, '[Init] payload:', {
    TerminalKey: maskKey(terminalKey),
    Amount: amountKop,
    DealId: initParams.DealId,
    OrderId: initParams.OrderId,
    PartnerId: initParams.PartnerId,
    CardId: initParams.CardId ? maskCardId(initParams.CardId) : undefined,
    FinalPayout: !!initParams.FinalPayout,
    PaymentRecipientId: initParams.PaymentRecipientId, // можно оставить в логе, или замаскировать
    Token: maskToken(token),
  });

  const initResp = await fetch(`${TBANK_E2C_BASE}/Init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(initBody),
  });
  const initJson = await initResp.json().catch(() => ({}));
  log(reqId, 'TBank INIT response:', { status: initResp.status, body: initJson });

  if (!initResp.ok || String(initJson?.ErrorCode) !== '0' || initJson?.Success === false) {
    throw new Error(initJson?.Message || initJson?.Details || 'Ошибка Init');
  }

  const paymentParams = {
    TerminalKey: terminalKey,
    PaymentId: initJson.PaymentId,
  };
  const { token: payToken } = buildTokenWithPassword(paymentParams);
  const paymentBody = { ...paymentParams, Token: payToken };

  const payResp = await fetch(`${TBANK_E2C_BASE}/Payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(paymentBody),
  });
  const payJson = await payResp.json().catch(() => ({}));
  log(reqId, 'TBank PAYMENT response:', { status: payResp.status, body: payJson });

if (!payResp.ok) {
  throw new Error(payJson?.Message || payJson?.Details || 'Ошибка Payment');
}

const bankStatus = String(payJson?.Status || '').toUpperCase();
const errorCode = payJson?.ErrorCode || null;
const success = payJson?.Success !== false && errorCode === '0';

// Возвращаем статусы наружу, чтобы вызывающая сторона решала, что делать
return {
  paymentId: initJson.PaymentId,
  orderId: safeOrderId,
  bankStatus,            // COMPLETED / CREDIT_CHECKING / ...
  bankSuccess: success,  // true/false по ErrorCode/Sucess
  bankErrorCode: errorCode,
  bankMessage: payJson?.Message || null,
  raw: payJson,
};
}

// ---------- GetState (E2C, только PaymentId + optional IP) ----------
function ensureE2CTerminal(key) {
  const base = String(key || '');
  return base.endsWith('E2C') ? base : `${base}E2C`;
}

function generateGetStateToken(params, reqId) {
  const pwd = tbankConfig.terminalSecret || '';
  const excluded = ['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber'];

  const base = { ...params, Password: pwd };
  const keys = Object.keys(base).filter(k => !excluded.includes(k)).sort();
  const concat = keys.map(k => String(base[k])).join('');
  const token = crypto.createHash('sha256').update(concat).digest('hex');

  // отладка как в get-statev
  const printableVals = keys.map(k => (k === 'Password' ? '***PWD***' : String(base[k])));
  log(reqId, '=== TOKEN DEBUG (GetState) ===');
  log(reqId, 'ALPHABETICAL_KEYS:', keys);
  log(reqId, 'VALUES_BY_KEY (Password masked):', printableVals);
  log(reqId, `SHA256_HEX (length=${token.length}):`, token);

  return token;
}

async function tbankGetState({ reqId, paymentId, ip }) {
  const terminalKey = tbankConfig.terminalKeyA2c || ensureE2CTerminal(tbankConfig.terminalKeyBase || '');
  if (!terminalKey) throw new Error('TBANK_TERMINAL_KEY is empty');

  // ⚠️ БЕЗ OrderId
  const baseParams = {
    TerminalKey: terminalKey,
    PaymentId: String(paymentId),
    ...(ip ? { IP: String(ip) } : {}),
  };

  const token = generateGetStateToken(baseParams, reqId);
  const params = { ...baseParams, Token: token };

  const payloadMaskedButFullToken = {
    ...params,
    TerminalKey: maskKey(params.TerminalKey),
    Token: params.Token,
  };

  const url = `${TBANK_E2C_BASE}/GetState`;

  log(reqId, '=== OUTGOING GETSTATE ===');
  log(reqId, 'URL:', url);
  log(reqId, 'Headers:', { 'Content-Type': 'application/json', 'X-Request-Id': reqId });
  log(reqId, 'Payload (TerminalKey masked, Token FULL):', payloadMaskedButFullToken);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId },
    body: JSON.stringify(params),
  });

  const rawText = await resp.text();
  let json; try { json = JSON.parse(rawText); } catch { json = { raw: rawText }; }

  log(reqId, '=== INCOMING GETSTATE ===');
  log(reqId, 'Status:', resp.status);
  log(reqId, 'Body:', json);

  if (!resp.ok) {
    throw new Error(json?.Message || json?.Details || 'Ошибка GetState');
  }

  const bankStatus = String(json?.Status || '').toUpperCase();
  return {
    ok: !!json?.Success && json?.ErrorCode === '0',
    bankStatus,
    errorCode: json?.ErrorCode || null,
    message: json?.Message || null,
    raw: json,
  };
}

// ---------- resolve helpers ----------
async function resolveSourcePaymentId({ tripId, participantUserId, refundExternalId, reqId }) {
  // 1) По external_request_id из payment_refunds
  if (refundExternalId) {
    const { data: pr, error: prErr } = await supabase
      .from('payment_refunds')
      .select('payment_id')
      .eq('trip_id', tripId)
      .eq('participant_id', participantUserId) // ← это user_id участника
      .eq('external_request_id', refundExternalId)
      .in('status', ['pending','confirmed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!prErr && pr?.payment_id) {
      log(reqId, 'Resolved sourcePaymentId by refundExternalId:', pr.payment_id);
      return pr.payment_id;
    }
    if (prErr) logErr(reqId, 'resolve by refundExternalId error:', prErr.message);
  }

  // 2) Фолбэк — самый свежий participant_payment этого юзера в этом трипе
  const { data: pay, error: payErr } = await supabase
    .from('payments')
    .select('id')
    .eq('trip_id', tripId)
    .eq('participant_id', participantUserId)   // ← user_id участника
    .eq('payment_type', 'participant_payment')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!payErr && pay?.id) {
    log(reqId, 'Resolved sourcePaymentId by latest payment:', pay.id);
    return pay.id;
  }
  if (payErr) logErr(reqId, 'resolve by latest payment error:', payErr.message);

  return null;
}

// ---------- handler ----------
export default async function handler(req, res) {
  const reqId = genReqId();
  try {
    log(reqId, 'Incoming request', {
      method: req.method,
      body: req.body,
      headers: {
        authorization: req.headers['authorization']
          ? `Bearer ${maskToken(req.headers['authorization'].replace('Bearer ', ''))}`
          : undefined,
        host: req.headers['host'],
        origin: req.headers['origin'],
        referer: req.headers['referer'],
        'user-agent': req.headers['user-agent'],
      },
    });

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { user, error: authErr } = await getAuthUserFromReq(req, reqId);
    if (authErr || !user) {
      logErr(reqId, 'Auth error:', authErr?.message || 'No user');
      return res.status(401).json({ error: 'Unauthorized' });
    }

   const {
      mode,
      tripId,
     participantId,
      amount,
      dealId,
      finalPayout,         // 🔹 новый необязательный флаг-override финальности (true/false)
      reason,              // 🔹 для логов/аудита (необяз.)
      refundExternalId,    // 🔹 связываем выплату с конкретным возвратом (необяз.)
      amountRub,            // 🔹 альтернативное имя суммы (если пришла из cancel)
      sourcePaymentId
    } = req.body || {};

    // Нормализуем override-флаг: null = не задан → использовать computed из БД
    const overrideFinal = (typeof finalPayout === 'boolean') ? finalPayout : null;
    // Нормализуем входную сумму: amountRub > amount
    const requestAmountRub = (amountRub != null) ? Number(amountRub) : Number(amount);

    log(reqId, 'Parsed body:', {
      mode, tripId, participantId,
      amount: requestAmountRub, dealId,
      overrideFinal,
      reason, 
      refundExternalId,
      sourcePaymentId
    });

    // Поездка
    const trip = await getTrip(tripId);
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    log(reqId, 'Trip:', {
      id: trip.id,
      creator_id: trip.creator_id,
      is_company_trip: trip.is_company_trip,
      deal_id: trip.deal_id,
    });

    // Получатель (PartnerId / CardId)
    let partnerId = null;
    let cardId = null;
    let paymentRecipientId = null;
    if (trip.is_company_trip) {
      const company = await getActiveCompanyForOrganizer(trip.creator_id);
      partnerId = (company?.tbank_shop_code || '').trim();
      if (!partnerId) return res.status(400).json({ error: 'Organizer company tbank_shop_code is missing' });
// телефон ответственного (у тебя уже в формате 11 цифр)
    const { data: prof } = await supabase
      .from('profiles')
      .select('phone')
      .eq('user_id', trip.creator_id)
      .single();
    paymentRecipientId = prof?.phone || null;
    if (!paymentRecipientId || !/^7\d{10}$/.test(paymentRecipientId)) {
      return res.status(400).json({ error: 'Organizer phone invalid for PaymentRecipientId' });
    }
    } else {
      cardId = await getOrganizerPayoutCardId(trip.creator_id);
      if (!cardId) return res.status(400).json({ error: 'Organizer payout card not found (CardId)' });
const { data: prof } = await supabase
      .from('profiles')
      .select('phone')
      .eq('user_id', trip.creator_id)
      .single();
    paymentRecipientId = prof?.phone || null;
    if (!paymentRecipientId || !/^7\d{10}$/.test(paymentRecipientId)) {
      return res.status(400).json({ error: 'Organizer phone invalid for PaymentRecipientId' });
    }    
   }


log(reqId, 'Payout recipient resolved:', {
      is_company_trip: !!trip.is_company_trip,
      partnerId: partnerId || undefined,
      cardId: cardId ? maskCardId(cardId) : undefined,
      overrideFinal
    });

    // === Режим: участник одобряет свою выплату (строка участника) ===
    if (mode === 'participant-approval') {
      const part = await getTripParticipant(tripId, participantId);
      if (!part) return res.status(404).json({ error: 'Participant not found' });
      if (user.id !== part.user_id) {
        return res.status(403).json({ error: 'Only participant can approve this row' });
      }

      // Берём последний подтверждённый платёж участника
      const pay = await getLatestConfirmedParticipantPayment(tripId, part.user_id);
      if (!pay) return res.status(400).json({ error: 'No confirmed participant payment' });
      const grossRub = Number(pay.amount || 0);
      if (!(grossRub > 0)) return res.status(400).json({ error: 'Invalid participant payment amount' });

      // NET к выплате = gross - (площ.+банк)%
      const { net } = computeNetFromGrossUsingTripPercents(grossRub, trip);
      const amountRub = net;

// 1) Атомарная бронь выплаты под advisory-lock
let prep;
try {
  // снимок процентов комиссий для RPC
  const feePlatformPct = Number.isFinite(Number(trip?.platform_fee)) ? Number(trip.platform_fee)
                     : Number(platformSettings?.platformFeePercent || 0);
 const feeTbankPct    = Number.isFinite(Number(trip?.tbank_fee)) ? Number(trip.tbank_fee)
                     : Number(platformSettings?.tbankFeePercent || 0);

  const { data, error } = await supabase.rpc('prepare_payout_atomic', {
    p_trip_id: tripId,
    p_source_payment_id: pay.id,     // UUID из payments (последний платёж участника)
    p_amount_net_rub: amountRub,     // NET (в рублях), который реально уйдёт
    p_fee_platform_pct: feePlatformPct,
    p_fee_tbank_pct: feeTbankPct,
    p_participant_id: participantId, // trip_participants.id (UUID строки участника)
    p_hint_is_final: null,           // финальность решит функция (или передайте true/false)
  });
  if (error) throw error;
  prep = (data && data[0]) || null;
  if (!prep?.order_id) throw new Error('prepare_payout_atomic: empty response');
} catch (e) {
  const msg = String(e?.message || e);
  if (/PAYOUT_EXCEEDS_AVAILABLE|PAYOUT_AMOUNT_INVALID/i.test(msg)) {
    logErr(reqId, 'prepare_payout_atomic business error (participant):', msg);
    return res.status(409).json({ error: msg });
  }
  logErr(reqId, 'prepare_payout_atomic error (participant):', msg);
  return res.status(500).json({ error: 'Failed to prepare payout' });
}

// 2) Банк: Init→Payment с FinalPayout из БД и тем же orderId
try {
  const bank = await tbankInitAndPayment({
    reqId,
    amountKop: prep.amount_kop,
    dealId: dealId || trip.deal_id,
    partnerId,
    cardId,
    finalPayout: !!prep.computed_is_final,
    orderId: prep.order_id,
    paymentRecipientId,
  });

  if (bank.bankStatus === 'CREDIT_CHECKING') {
    await supabase.from('payout_attempts').update({
      status: 'pending',
      bank_status: 'CREDIT_CHECKING',
      bank_error_code: bank.bankErrorCode || null,
      bank_message: bank.bankMessage || 'Асинхронная проверка (CREDIT_CHECKING)',
      bank_payload: bank.raw || null,
      last_attempt_at: new Date().toISOString(),
      payment_id: bank.paymentId,
      bank_order_id: bank.orderId,
    }).eq('order_id', prep.order_id);

    return res.status(202).json({
      success: true,
      pending: true,
      bankStatus: 'CREDIT_CHECKING',
      message: 'Платёж на выплату подтверждается банком (CREDIT_CHECKING). Повторно запускать не нужно.',
      orderId: prep.order_id,
      bankOrderId: bank.orderId,
      paymentId: bank.paymentId,
    });
  }

  if (bank.bankStatus !== 'COMPLETED') {
    await supabase.from('payout_attempts').update({
      status: 'failed',
      bank_status: bank.bankStatus,
      bank_error_code: bank.bankErrorCode || null,
      bank_message: bank.bankMessage || 'Ошибка Payment',
      bank_payload: bank.raw || null,
      last_attempt_at: new Date().toISOString(),
      payment_id: bank.paymentId,
      bank_order_id: bank.orderId,
    }).eq('order_id', prep.order_id);

    throw new Error(bank.bankMessage || 'Ошибка Payment');
  }

  // 🔹 Снимок комиссий и сумм (NET ушёл в банк; GROSS-эквивалент — для учёта лимита на основе GROSS)
  const feePlatformPct = Number.isFinite(Number(trip?.platform_fee)) ? Number(trip.platform_fee)
                     : Number(platformSettings?.platformFeePercent || 0);
  const feeTbankPct    = Number.isFinite(Number(trip?.tbank_fee)) ? Number(trip.tbank_fee)
                     : Number(platformSettings?.tbankFeePercent || 0);
  const totalPct       = feePlatformPct + feeTbankPct;
  const amountNetRub   = Math.floor(prep.amount_kop) / 100; // NET копейки → вниз
  const grossEquivRub  = totalPct >= 100
    ? null
    : Math.trunc((amountNetRub / (1 - totalPct / 100)) * 100) / 100; // вниз до копейки

  // 3) Завершение попытки
  await supabase
    .from('payout_attempts')
    .update({
      status: 'completed',
      bank_status: 'COMPLETED',
      last_attempt_at: new Date().toISOString(),
      error_message: null,
      payment_id: bank.paymentId,          // ← было paymentId
      bank_order_id: bank.orderId,         // ← было bankOrderId
      source_payment_id: pay.id,
      fee_platform_pct: feePlatformPct,
      fee_tbank_pct:    feeTbankPct,
      amount_net_rub:   amountNetRub,
      amount_gross_equiv_rub: grossEquivRub,
    })
    .eq('order_id', prep.order_id);

  // 4) Помечаем платёж участника как выплаченный
  await supabase
    .from('payments')
    .update({ payout_completed: true, payout_at: new Date().toISOString() })
    .eq('id', pay.id);

  // 5) Участник подтвердил поездку
  await supabase.from('trip_participants').update({ approved_trip: true }).eq('id', participantId);

  // 6) Финализация: архивируем при последней выплате
  try {
    const paidUserIds = await getPaidUserIdsForTrip(tripId);
    const approvedCount = await countApprovedPaidParticipants(tripId, paidUserIds);
    log(reqId, 'Finalization check:', { paidUsers: paidUserIds.length, approvedCount });
    if (paidUserIds.length > 0 && approvedCount === paidUserIds.length) {
      await archiveTripAndChats(tripId);
      log(reqId, 'Trip and chats archived after last payout');
    }
  } catch (finErr) {
    logErr(reqId, 'Finalization (archive) error:', finErr?.message || finErr);
  }
  // 7) 🔔 Оповещение организатору: участник одобрил поездку, выплата проведена
  try {
    const organizerId = trip?.creator_id;
    const participantUserId = part?.user_id;

    if (organizerId && participantUserId) {
      const { error: alertErr } = await supabase
        .from('trip_alerts')
        .insert({
          user_id: organizerId,
          trip_id: tripId,
          actor_user_id: participantUserId,
          type: 'trip_payout_completed_after_participant_approval',
          title: 'Выплата организатору выполнена',
          body: `Участник одобрил поездку «${trip?.title || ''}». Выплата выполнена.`,
          metadata: { tripTitle: trip?.title || null },
        });

      if (alertErr) {
        logErr(reqId, 'trip_alerts payout insert error:', alertErr.message);
      } else {
        log(reqId, 'trip_alerts: отправлено оповещение о выплате организатору');
      }
    }
  } catch (notifyErr) {
    logErr(
      reqId,
      'trip_alerts payout notify error:',
      notifyErr?.message || notifyErr
    );
  }
  return res.status(200).json({
    success: true,
    paymentId: bank.paymentId,
    amountKop: prep.amount_kop,
    finalPayout: (overrideFinal === null ? !!prep.computed_is_final : overrideFinal),
    orderId: prep.order_id,  // локальный OrderId
    bankOrderId: bank.orderId,
  });
} catch (e) {
  await supabase
    .from('payout_attempts')
    .update({
      status: 'failed',
      last_attempt_at: new Date().toISOString(),
      error_message: e?.message || 'unknown',
    })
    .eq('order_id', prep.order_id);
  logErr(reqId, 'Participant-approval payout error:', e?.message);
  return res.status(500).json({ error: e?.message || 'Payout error' });
}
}
    // === Ручной/служебный режим (в т.ч. after_refund_self_leave) ===
if (!requestAmountRub || !(dealId || trip.deal_id)) {
  return res.status(400).json({ error: 'Missing amount/dealId for manual payout' });
}
const manualAmountRub = Number(requestAmountRub);
if (!(manualAmountRub > 0)) return res.status(400).json({ error: 'Invalid amount' });

// ✅ Новая логика: если пришёл mode === 'admin-settle-net', то amount — это уже NET
let netRub;
if (mode === 'admin-settle-net') {
  netRub = manualAmountRub;
  if (!(netRub > 0)) return res.status(400).json({ error: 'Invalid net amount' });
  log(reqId, 'Manual payout (admin-settle-net): using provided NET', { netRub });
} else {
  // Старое поведение: amount — это GROSS → локально считаем NET
  const { net, platformPercent, tbankPercent, totalPercent } =
   computeNetFromGrossUsingTripPercents(manualAmountRub, trip);
  netRub = net;
  if (!(netRub > 0)) return res.status(400).json({ error: 'Net amount after fees is not positive' });
  log(reqId, 'Manual payout gross→net:', {
    grossRub: manualAmountRub, netRub,
    platformPercent, tbankPercent, totalPercent
  });
}

    // 1) Атомарная бронь выплаты
let prep;

// 🔹 ВЫНЕСЛИ наружу, чтобы была доступна и после try/catch
let resolvedSourcePaymentId = sourcePaymentId ?? null;

try {
  // снимок процентов комиссий для RPC
  const feePlatformPct = Number.isFinite(Number(trip?.platform_fee))
    ? Number(trip.platform_fee)
    : Number(platformSettings?.platformFeePercent || 0);
  const feeTbankPct = Number.isFinite(Number(trip?.tbank_fee))
    ? Number(trip.tbank_fee)
    : Number(platformSettings?.tbankFeePercent || 0);

  // ── найти sourcePaymentId, если не передали напрямую
  if (!resolvedSourcePaymentId) {
    // participantId здесь — это user_id участника (как в логах)
    const participantUserId = participantId;
    resolvedSourcePaymentId = await resolveSourcePaymentId({
      tripId,
      participantUserId,
      refundExternalId,
      reqId,
    });
  }

  if (!resolvedSourcePaymentId) {
    logErr(reqId, 'SOURCE_PAYMENT_NOT_FOUND (manual): cannot resolve');
    return res.status(400).json({ error: 'SOURCE_PAYMENT_NOT_FOUND' });
  }

// --- ПРЕДОХРАНИТЕЛЬ: если есть "висящая" попытка в CREDIT_CHECKING, сначала проверим её состояние
try {
  const { data: pending = [] } = await supabase
    .from('payout_attempts')
    .select('id, order_id, bank_order_id, payment_id, status, bank_status')
    .eq('source_payment_id', resolvedSourcePaymentId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);

  const pa = pending?.[0];
  if (pa && String(pa.bank_status).toUpperCase() === 'CREDIT_CHECKING') {
    // Сначала пробуем по payment_id, если нет — по bank_order_id (OrderId)
    const getState = await tbankGetState({
      reqId,
      paymentId: pa.payment_id || undefined,
    });

    // Обновим payload и мета-инфо (не меняя status, пока не увидим финальный банк-статус)
    await supabase.from('payout_attempts').update({
      bank_status: getState.bankStatus || pa.bank_status,
      bank_error_code: getState.errorCode || null,
      bank_message: getState.message || null,
      bank_payload: getState.raw || null,
      last_attempt_at: new Date().toISOString(),
    }).eq('id', pa.id);

    if (getState.bankStatus === 'CREDIT_CHECKING') {
      // Всё ещё проверяется — запрещаем повторно стартовать выплату
      return res.status(409).json({
        error: 'BANK_CREDIT_CHECKING',
        message: 'Платёж на выплату всё ещё подтверждается Т-Банком. Напишите в техподдержку — так решится быстрее.',
      });
    }

    if (getState.bankStatus === 'REJECTED') {
      // Ставим failed — и позволяем дальше запустить НОВУЮ выплату (текущий поток продолжит)
      await supabase.from('payout_attempts').update({
        status: 'failed',
        bank_status: 'REJECTED',
        bank_error_code: getState.errorCode || null,
        bank_message: getState.message || 'Отклонён банком',
        bank_payload: getState.raw || null,
        last_attempt_at: new Date().toISOString(),
      }).eq('id', pa.id);
      log(reqId, 'Previous attempt rejected by bank; proceeding with new payout.');
    }

    if (getState.bankStatus === 'COMPLETED') {
      // Закрываем старую попытку, проводим финализацию как обычно и ВОЗВРАЩАЕМ 200 (новую не запускаем)
      await supabase.from('payout_attempts').update({
        status: 'completed',
        bank_status: 'COMPLETED',
        bank_error_code: getState.errorCode || null,
        bank_message: getState.message || null,
        bank_payload: getState.raw || null,
        last_attempt_at: new Date().toISOString(),
      }).eq('id', pa.id);

      // (Опционально) отметить payout_completed на source-платеже, если ещё не стояло:
      await supabase.from('payments')
        .update({ payout_completed: true, payout_at: new Date().toISOString() })
        .eq('id', resolvedSourcePaymentId);

      // Попробуем финализацию архивации (логика как у тебя ниже)
      try {
        const paidUserIds = await getPaidUserIdsForTrip(tripId);
        const approvedCount = await countApprovedPaidParticipants(tripId, paidUserIds);
        log(reqId, 'Finalization check (from GetState COMPLETED):', { paidUsers: paidUserIds.length, approvedCount });
        if (paidUserIds.length > 0 && approvedCount === paidUserIds.length) {
          await archiveTripAndChats(tripId);
          log(reqId, 'Trip and chats archived after completed payout (GetState).');
        }
      } catch (finErr) {
        logErr(reqId, 'Finalization (archive from GetState) error:', finErr?.message || finErr);
      }

      return res.status(200).json({
        success: true,
        message: 'Выплата завершилась в банке ранее (COMPLETED). Повторный запуск не требуется.',
      });
    }

    // Если пришёл незнакомый статус — не стартуем новую выплату, просим техподдержку
    return res.status(409).json({
      error: 'BANK_PENDING_UNKNOWN',
      message: `Выплата в состоянии ${getState.bankStatus || 'UNKNOWN'}. Напишите в техподдержку.`,
    });
  }
} catch (guardErr) {
  logErr(reqId, 'Pending guard error:', guardErr?.message || guardErr);
  // Не блокируем, просто продолжим; но можно вернуть 500, если хочешь строго.
}


  const { data, error } = await supabase.rpc('prepare_payout_atomic', {
    p_trip_id: tripId,
    p_source_payment_id: resolvedSourcePaymentId, // ← теперь переменная видна снаружи
    p_amount_net_rub: netRub,
    p_fee_platform_pct: feePlatformPct,
    p_fee_tbank_pct: feeTbankPct,
    p_participant_id: null,
    p_hint_is_final: (overrideFinal === null ? null : overrideFinal),
  });
  if (error) throw error;
  prep = (data && data[0]) || null;
  if (!prep?.order_id) throw new Error('prepare_payout_atomic: empty response');
} catch (e) {
  const msg = String(e?.message || e);
  if (/PAYOUT_EXCEEDS_AVAILABLE|PAYOUT_AMOUNT_INVALID/i.test(msg)) {
    logErr(reqId, 'prepare_payout_atomic business error (manual):', msg);
    return res.status(409).json({ error: msg });
  }
  logErr(reqId, 'prepare_payout_atomic error (manual):', msg);
  return res.status(500).json({ error: 'Failed to prepare payout' });
}

    // 2) Банк
    try {
      const bank = await tbankInitAndPayment({
  reqId,
  amountKop: prep.amount_kop,
  dealId: dealId || trip.deal_id,
  partnerId,
  cardId,
  finalPayout: !!prep.computed_is_final,
  orderId: prep.order_id,
  paymentRecipientId,
});

if (bank.bankStatus === 'CREDIT_CHECKING') {
  // Отмечаем попытку как pending + сохраняем банк-мета
  await supabase.from('payout_attempts').update({
    status: 'pending',
    bank_status: 'CREDIT_CHECKING',
    bank_error_code: bank.bankErrorCode || null,
    bank_message: bank.bankMessage || 'Асинхронная проверка (CREDIT_CHECKING)',
    bank_payload: bank.raw || null,
    last_attempt_at: new Date().toISOString(),
    payment_id: bank.paymentId,
    bank_order_id: bank.orderId,
    // снимки сумм/комиссий, если хочешь — можно сохранить и тут
  }).eq('order_id', prep.order_id);

  // участнику можно вернуть 202/200 с информационным сообщением
  return res.status(202).json({
    success: true,
    pending: true,
    bankStatus: 'CREDIT_CHECKING',
    message: 'Платёж на выплату подтверждается банком (CREDIT_CHECKING). Повторно запускать не нужно.',
    orderId: prep.order_id,
    bankOrderId: bank.orderId,
    paymentId: bank.paymentId,
  });
}

if (bank.bankStatus !== 'COMPLETED') {
  // Любой другой неуспешный статус считаем фейлом
  await supabase.from('payout_attempts').update({
    status: 'failed',
    bank_status: bank.bankStatus,
    bank_error_code: bank.bankErrorCode || null,
    bank_message: bank.bankMessage || 'Ошибка Payment',
    bank_payload: bank.raw || null,
    last_attempt_at: new Date().toISOString(),
    payment_id: bank.paymentId,
    bank_order_id: bank.orderId,
  }).eq('order_id', prep.order_id);

  throw new Error(bank.bankMessage || 'Ошибка Payment');
}
      

// 🔹 Снимок комиссий и сумм
const feePlatformPct = Number.isFinite(Number(trip?.platform_fee)) ? Number(trip.platform_fee)
                   : Number(platformSettings?.platformFeePercent || 0);
const feeTbankPct    = Number.isFinite(Number(trip?.tbank_fee)) ? Number(trip.tbank_fee)
                   : Number(platformSettings?.tbankFeePercent || 0);
const totalPct       = feePlatformPct + feeTbankPct;
const amountNetRub   = Number((prep.amount_kop / 100).toFixed(2));
const grossEquivRub  = totalPct >= 100 ? null : Number((amountNetRub / (1 - totalPct / 100)).toFixed(2));

await supabase
  .from('payout_attempts')
  .update({
    status: 'completed',
    bank_status: 'COMPLETED',
    last_attempt_at: new Date().toISOString(),
    error_message: null,
    payment_id: bank.paymentId,     // ← было paymentId
    bank_order_id: bank.orderId,    // ← было bankOrderId
    source_payment_id: resolvedSourcePaymentId,
    fee_platform_pct: feePlatformPct,
    fee_tbank_pct:    feeTbankPct,
    amount_net_rub:   amountNetRub,
    amount_gross_equiv_rub: grossEquivRub,
  })
  .eq('order_id', prep.order_id);

// ⬇️ ВСТАВИТЬ СЮДА: пометить исходный платёж как выплаченный
await supabase
  .from('payments')
  .update({ payout_completed: true, payout_at: new Date().toISOString() })
  .eq('id', resolvedSourcePaymentId);

// 5b) Если знаем участника — помечаем его строку approved_trip = true
// В админ-потоке participantId — это user_id участника (по твоим логам),
// поэтому фильтруем по user_id + trip_id. Если вдруг присылается id строки,
// fallback возьмёт по id.
if (participantId) {
  // сначала пробуем по user_id
  const { error: updByUserErr, count: updByUserCount } = await supabase
    .from('trip_participants')
    .update({ approved_trip: true })
    .eq('trip_id', tripId)
    .eq('user_id', participantId)
    .select('id', { count: 'exact', head: true });

  // если по user_id не нашлось — повторим по первичному id строки
  if (updByUserErr || !updByUserCount) {
    await supabase
      .from('trip_participants')
      .update({ approved_trip: true })
      .eq('id', participantId);
  }
}
try {
  // 🔹 Выплату считаем финальной, если:
  //   1) overrideFinal === true, или
  //   2) overrideFinal === null и БД посчитала computed_is_final = true
  const isActuallyFinal = (overrideFinal === true) ||
                          (overrideFinal === null && !!prep?.computed_is_final);
  if (isActuallyFinal) {
    await archiveTripAndChats(tripId);
    log(reqId, 'Trip and chats archived after final payout');
  } else {
    log(reqId, 'Skip archive: finalPayout override =', overrideFinal);
  }
} catch (archErr) {
  logErr(reqId, 'Archive-after-payout error:', archErr?.message || archErr);
}
      return res.status(200).json({
  success: true,
  paymentId: bank.paymentId,
  amountKop: prep.amount_kop,
  finalPayout: (overrideFinal === null ? !!prep.computed_is_final : overrideFinal),
  orderId: prep.order_id,
  bankOrderId: bank.orderId,
});
    } catch (e) {
      await supabase
        .from('payout_attempts')
        .update({
          status: 'failed',
          last_attempt_at: new Date().toISOString(),
          error_message: e?.message || 'unknown',
        })
        .eq('order_id', prep.order_id);
      logErr(reqId, 'Manual payout error:', e?.message);
      return res.status(500).json({ error: e?.message || 'Payout error' });
    }
  } catch (error) {
    logErr(reqId, 'Critical payout error:', error);
    return res.status(500).json({ error: error?.message || 'Internal error' });
  }
}
