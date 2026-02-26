// pages/api/tbank/cancel.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import os from 'os';
import { getTbankConfig } from './_config';

// ---- Supabase client (RLS через пользовательский токен) ----
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ---- Small helpers ----
const mask = (s, keepStart = 4, keepEnd = 4) => {
  if (!s) return s;
  const str = String(s);
  if (str.length <= keepStart + keepEnd) return '*'.repeat(Math.max(1, str.length - 1));
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
};
const maskToken = (t) => (t ? mask(t, 6, 6) : t);
const log = (...a) => console.log('[cancel]', ...a);
const logErr = (...a) => console.error('[cancel]', ...a);
const EPS = 0.005;
const tbankConfig = getTbankConfig();

// Вспомогатель: абсолютный BASE_URL для внутренних вызовов (payout)
function getBaseUrl(req) {
  // приоритет: явная переменная окружения (как на фронте)
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/,'');
  // fallback: из запроса
  const host = req?.headers?.host;
  if (host) return `https://${host}`;
  // локальная разработка
  return 'http://localhost:3000';
}

// ---- Token builder for TBank v2 (SHA-256 over sorted values + Password) + подробные логи ----
function generateTokenWithLogs(params) {
  if (!tbankConfig.terminalSecret) throw new Error('TBANK_SECRET не задан');

  const paramsWithPassword = { ...params, Password: tbankConfig.terminalSecret };
  const sorted = Object.keys(paramsWithPassword)
    .sort()
    .reduce((acc, k) => {
      if (
        k !== 'Token' &&
        k !== 'DigestValue' &&
        k !== 'SignatureValue' &&
        k !== 'X509SerialNumber'
      ) {
        acc[k] = String(paramsWithPassword[k]);
      }
      return acc;
    }, {});

  // Логируем отсортированные параметры (Password замаскируем)
  const sortedForLog = { ...sorted, Password: mask(sorted.Password) };
  log('Token sortedParams:', sortedForLog);

  const concat = Object.values(sorted).join('');
  // В склейке тоже замаскируем секрет
  const maskedConcat = concat.replace(String(tbankConfig.terminalSecret), mask(tbankConfig.terminalSecret));
  log('Token concatenated:', maskedConcat);

  const token = crypto.createHash('sha256').update(concat).digest('hex');
  log('Token sha256:', maskToken(token));
  return token;
}

async function getAdminAccess(userId) {
  const { data, error } = await supabase
    .from('user_admin_access')
    .select('is_admin, disputes')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---- DB helpers (трип, счетчики, архивирование) ----
async function getTripRow(tripId) {
  const { data, error } = await supabase
    .from('trips')
    .select('id, deal_id, status')
    .eq('id', tripId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function countStillPaidLatestPerParticipant(tripId) {
  // Берём все платежи по трипу, отсортированные по дате (свежие первыми)
  const { data, error } = await supabase
    .from('payments')
    .select('participant_id, id, status, created_at, payment_type')
    .eq('trip_id', tripId)
    .eq('payment_type', 'participant_payment')
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Для каждого участника оставляем только самый свежий платёж
  const latestByParticipant = new Map();
  for (const row of (data || [])) {
    if (!latestByParticipant.has(row.participant_id)) {
      latestByParticipant.set(row.participant_id, row); // первый в порядке = самый новый
    }
  }

  // Считаем тех, у кого самый свежий платёж ещё в статусе 'confirmed'
  let stillPaid = 0;
  for (const r of latestByParticipant.values()) {
    if ((r.status || '').toLowerCase() === 'confirmed') stillPaid += 1;
  }
  return stillPaid;
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

// Финализировать поездку выбранным статусом и заархивировать чаты
async function finalizeTripWithStatus(tripId, finalStatus = 'archived') {
  await supabase.from('trips').update({ status: finalStatus }).eq('id', tripId);
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

// ---- Вызов /v2/closeSpDeal (закрыть сделку) ----
async function closeSpDeal({ terminalKey, dealId }) {
  if (!terminalKey) throw new Error('TerminalKey is empty');
  if (!dealId) throw new Error('SpAccumulationId (dealId) is empty');

  const params = { TerminalKey: terminalKey, SpAccumulationId: String(dealId) };
  const token = generateTokenWithLogs(params);
  const body = { ...params, Token: token };

  const apiUrl = `${tbankConfig.eacqBaseV2}/closeSpDeal`;

  log('closeSpDeal request', { url: apiUrl, body: { ...body, Token: maskToken(body.Token) } });

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let json = null;
  try { json = await resp.json(); } catch {}

  log('closeSpDeal response', { status: resp.status, body: json });

  if (!resp.ok || !json?.Success || String(json?.ErrorCode) !== '0') {
    const msg = json?.Message || json?.Details || 'closeSpDeal failed';
    const err = new Error(msg);
    err.code = json?.ErrorCode;
    throw err;
  }
  return json;
}

// ============================================================

export default async function handler(req, res) {
  log('Incoming', { method: req.method, path: req.url });
  log('Incoming body', { body: req.body });

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Метод не разрешён' });
  }

  try {
    const TBANK_TERMINAL_KEY = tbankConfig.terminalKeyEacq || tbankConfig.terminalKeyBase;
    const TBANK_SECRET = tbankConfig.terminalSecret;
    log('Env check', { terminalKey: mask(TBANK_TERMINAL_KEY), secretSet: !!TBANK_SECRET, apiBase: tbankConfig.restBase });

    if (!TBANK_TERMINAL_KEY || !TBANK_SECRET) {
      logErr('Config error: TBANK_TERMINAL_KEY/TBANK_SECRET missing');
      return res.status(500).json({ ok: false, error: 'Ошибка конфигурации сервера (TBank env)' });
    }

    // --- Auth ---
    const authz = req.headers.authorization || '';
    if (!authz.startsWith('Bearer ')) {
      logErr('Auth error: no bearer header');
      return res.status(401).json({ ok: false, error: 'Неавторизованный запрос' });
    }
    const accessToken = authz.slice('Bearer '.length);
    const { data: auth, error: authErr } = await supabase.auth.getUser(accessToken);
    log('Auth check', { userId: auth?.user?.id || null, err: authErr?.message || null });
    if (authErr || !auth?.user?.id) {
      return res.status(401).json({ ok: false, error: 'Неавторизованный запрос' });
    }
    const actorUserId = auth.user.id;
 
// кто вызвал: админ + есть право "disputes"?
  let isAdminActor = false;
  let hasDisputesAccess = false;
  try {
    const acc = await getAdminAccess(actorUserId);
    isAdminActor = !!acc?.is_admin;
    hasDisputesAccess = !!acc?.disputes;
  } catch { /* не критично */ }

    // --- Body ---
    const {
      paymentId,      // внешний Tinkoff PaymentId исходного платежа участника (обяз.)
      tripId,         // uuid поездки (обяз.)
      participantId,  // uuid профиля участника (обяз.)
      amount,         // ₽ (положительное число) — СУММА ВОЗВРАТА
      externalRequestId, // опционально — идемпотентность на нашей стороне
      reason,         // причина (для аудита)
      notes,          // заметки (для аудита)
      source,
    } = req.body || {};

    if (!paymentId || !tripId || !participantId || amount == null) {
      logErr('Bad request: missing fields', { paymentId, tripId, participantId, amount });
      return res.status(400).json({ ok: false, error: 'Недостаточно данных (paymentId, tripId, participantId, amount)' });
    }
    const refundRub = Number(amount);
    if (!(refundRub > 0)) {
      logErr('Bad request: amount <= 0', { amount });
      return res.status(400).json({ ok: false, error: 'Сумма возврата должна быть > 0' });
    }
    
// Контекст: кто инициатор — сам участник (само-выход) или организатор/админ
    const isSelfLeave = actorUserId === participantId;   // участник сам покидает
    const isOrganizerAction = !isSelfLeave;              // исключение/служебное действие
    const isAdminDisputesFlow = String(source) === 'admin_disputes_settle';
    log('Context', { isSelfLeave, isOrganizerAction, isAdminActor, hasDisputesAccess, isAdminDisputesFlow });
    
// --- Найти исходный платеж по внешнему PaymentId/поездке/участнику ---
    const { data: paymentRow, error: payErr } = await supabase
      .from('payments')
      .select('id, payment_type, status, amount, participant_id, trip_id')
      .eq('payment_id', paymentId)
      .eq('trip_id', tripId)
      .eq('participant_id', participantId)
      .single();

    log('Payment lookup', { error: payErr?.message || null, paymentRow });
    if (payErr || !paymentRow) {
      return res.status(400).json({ ok: false, error: 'Исходный платёж не найден' });
    }
    if (paymentRow.payment_type !== 'participant_payment') {
      logErr('Bad payment_type for refund', { payment_type: paymentRow.payment_type });
      return res.status(400).json({ ok: false, error: 'Возврат возможен только по платежам участника' });
    }
    if (paymentRow.status !== 'confirmed') {
      logErr('Bad payment status for refund', { status: paymentRow.status });
      return res.status(400).json({ ok: false, error: `Возврат невозможен: платёж в статусе ${paymentRow.status}` });
    }

    // --- Идемпотентный ExternalRequestId для банка ---
    const extId =
      externalRequestId ||
      crypto
        .createHash('sha256')
        .update(`${tripId}:${participantId}:${paymentId}:${Math.round(refundRub * 100)}`)
        .digest('hex')
        .slice(0, 50);

    log('prepare_refund_atomic args', {
      p_payment_id: paymentRow.id,
      p_trip_id: tripId,
      p_participant_id: participantId,
      p_amount_rub: refundRub,
      p_external_request_id: extId,
      p_reason: reason || null,
      p_created_by: actorUserId || null,
    });

    // --- 1) ATOMIC RESERVE (prepare_refund_atomic) ---
    let prepare;
    try {
      const { data, error } = await supabase.rpc('prepare_refund_atomic', {
        p_payment_id: paymentRow.id,
        p_trip_id: tripId,
        p_participant_id: participantId,
        p_amount_rub: refundRub,
        p_external_request_id: extId,
        p_reason: reason || null,
        p_created_by: actorUserId || null,
      });
      if (error) throw error;
      prepare = (data && data[0]) || null;
      if (!prepare?.refund_row_id) throw new Error('prepare_refund_atomic: пустой ответ');
      log('prepare_refund_atomic ok', prepare);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/REFUND_EXCEEDS_AVAILABLE|PAYMENT_NOT_FOUND|INVALID|NOT_CONFIRMED/i.test(msg)) {
        log('prepare_refund_atomic business-conflict', msg);
        return res.status(409).json({ ok: false, error: msg });
      }
      logErr('prepare_refund_atomic error:', msg);
      return res.status(500).json({ ok: false, error: 'Ошибка подготовки возврата' });
    }

    const refundRowId = prepare.refund_row_id;
    const willClose = !!prepare.will_close;

// --- 1.5) Предрасчёт: сколько "открытых" останется ПОСЛЕ этого возврата (под advisory-lock в RPC)
    try {
      const { data: preOpenCount } = await supabase.rpc('compute_open_count_after_refund', {
        p_trip_id: tripId,
        p_payment_db_id: paymentRow.id,   // DB UUID из payments.id
        p_refund_amount_rub: refundRub,
      });
      log('pre-check compute_open_count_after_refund', { preOpenCount });
    } catch (e) {
      logErr('pre-check compute_open_count_after_refund error (non-fatal):', e?.message || e);
    }

    // --- 2) Вызов банка /v2/Cancel ---
    const tinkoffBody = {
      TerminalKey: TBANK_TERMINAL_KEY,
      PaymentId: String(paymentId),
      Amount: Math.round(refundRub * 100), // копейки
      ExternalRequestId: extId,
    };
    const token = generateTokenWithLogs(tinkoffBody);
    tinkoffBody.Token = token;

    const apiUrl = `${tbankConfig.eacqBaseV2}/Cancel`;

    const bodyForLog = { ...tinkoffBody, Token: maskToken(tinkoffBody.Token) };
    log('TBank Cancel request', { url: apiUrl, body: bodyForLog });

    let bankResp;
    try {
      bankResp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tinkoffBody),
      });
    } catch (netErr) {
      logErr('TBank network error', netErr?.message);
      await supabase
        .from('payment_refunds')
        .update({ status: 'failed', notes: (notes ? `${notes} | ` : '') + `network: ${netErr?.message || 'error'}` })
        .eq('id', refundRowId);
      return res.status(502).json({ ok: false, error: 'Сетевая ошибка при запросе к банку', details: netErr?.message });
    }

    let bankJson;
    let bankRawText = null;
    try {
      bankJson = await bankResp.json();
    } catch {
      try { bankRawText = await bankResp.text(); } catch {}
    }

    log('TBank Cancel response', {
      status: bankResp.status,
      ok: bankResp.ok,
      json: bankJson,
      raw: bankJson ? undefined : (bankRawText?.slice(0, 500) || null),
    });

    if (!bankResp.ok || !bankJson?.Success) {
      await supabase
        .from('payment_refunds')
        .update({
          status: 'failed',
          notes: (notes ? `${notes} | ` : '') + `bank: ${bankJson?.Message || bankJson?.Details || 'declined'}`,
        })
        .eq('id', refundRowId);

      logErr('Bank declined cancel', {
        http: { status: bankResp.status, ok: bankResp.ok },
        error: bankJson?.Message,
        details: bankJson?.Details,
        code: bankJson?.ErrorCode,
      });

      return res.status(400).json({
        ok: false,
        error: bankJson?.Message || 'Банк отклонил возврат',
        details: bankJson?.Details,
        errorCode: bankJson?.ErrorCode,
      });
    }

    // --- 3) Фиксация: pending → confirmed ---
    const upd = await supabase
      .from('payment_refunds')
      .update({
        status: 'confirmed',
        refund_id: String(bankJson?.PaymentId || ''),
        external_request_id: extId,
        notes: notes || null,
      })
      .eq('id', refundRowId)
      .select('id')
      .maybeSingle();

    if (upd.error) {
      logErr('Failed to update payment_refunds -> confirmed', upd.error.message);
      return res.status(500).json({ ok: false, error: 'Ошибка фиксации возврата' });
    }
    log('payment_refunds updated -> confirmed', { id: refundRowId });

// ---- NEW: обновить статус участника в trip_participants по типу действия ----
try {
  // Выберем целевой статус
  let targetStatus = null;

  // Если это отмена всей поездки (идёт из canceltrip, reason='organizer_trip_cancel') → canceled
  if (String(reason) === 'organizer_trip_cancel') {
    targetStatus = 'canceled';
  } else {
    // Самовольный выход участника → rejected
    // Исключение админом/организатором (если такой reason ты передаёшь) → rejected
    if (isSelfLeave || String(reason) === 'organizer_exclude') {
      targetStatus = 'rejected';
    }
  }

  if (targetStatus) {
    const { error: updPartErr } = await supabase
      .from('trip_participants')
      .update({ status: targetStatus })
      .eq('trip_id', tripId)
      .eq('user_id', participantId);

    if (updPartErr) {
      logErr('trip_participants status update error:', updPartErr.message);
    } else {
      log('trip_participants updated', { tripId, participantId, targetStatus });
    }
  } else {
    log('trip_participants status unchanged (no targetStatus)');
  }
} catch (e) {
  logErr('trip_participants status update exception:', e?.message || e);
}

    // --- 4) Лог события ---
    const logIns = await supabase.from('payout_logs').insert({
      trip_id: tripId,
      action: 'refund_success',
      details: {
        paymentId,
        refundRub,
        externalRequestId: extId,
        bank: bankJson,
        actorUserId,
        willClose,
      },
    });
    if (logIns.error) {
      logErr('payout_logs insert error', logIns.error.message);
    } else {
      log('payout_logs insert ok');
    }

// --- 4.4) Само-выход + частичный возврат -> инициируем выплату организатору (FinalPayout=false)
    try {
      // Остаток от исходного платежа после возврата
      const originalRub = Number(paymentRow.amount) || 0;
      const leftoverRub = Math.max(0, originalRub - refundRub);
      log('post-refund leftover calc', { originalRub, refundRub, leftoverRub, isSelfLeave });

      if (isSelfLeave && leftoverRub > 0) {
        // Вызываем наш payout-эндпоинт: он сам разрулит комиссию/схему и НЕ будет финализировать сделку
        const baseUrl = getBaseUrl(req);
        const payoutReq = {
          tripId,
          participantId,                 // участник, по которому был платёж/возврат
          mode: 'after_refund_self_leave',
          amountRub: leftoverRub,        // валовая сумма для сплита; нетто считает сервер
          finalPayout: false,            // ВАЖНО: без закрытия сделки
          reason: 'partial_payout_after_partial_refund',
          refundExternalId: extId,       // чтобы payout связался с этим возвратом
        };
        log('Calling /api/tbank/payout', { url: `${baseUrl}/api/tbank/payout`, payload: payoutReq });
        const payoutResp = await fetch(`${baseUrl}/api/tbank/payout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // пробрасываем тот же user JWT — payout может потребовать аутентификацию
           Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(payoutReq),
        });

        let payoutJson = null;
        try { payoutJson = await payoutResp.json(); } catch {}
        log('Payout response', { status: payoutResp.status, ok: payoutResp.ok, body: payoutJson });

        if (!payoutResp.ok || !payoutJson?.success) {
          logErr('Payout failed (non-fatal):', payoutJson?.error || `HTTP ${payoutResp.status}`);
          // логируем, но не роняем основной ответ возврата
          await supabase.from('payout_logs').insert({
            trip_id: tripId,
            action: 'organizer_payout_after_partial_refund_failed',
            details: { payoutReq, payoutJson },
          });
        } else {
          await supabase.from('payout_logs').insert({
            trip_id: tripId,
            action: 'organizer_payout_after_partial_refund_success',
            details: { payoutReq, payoutJson },
          });
        }
      }
    } catch (pErr) {
      logErr('4.4 payout-after-refund error (non-fatal):', pErr?.message || pErr);
      // не роняем ответ: возврат уже зафиксирован
    }

    // --- 4.5) Пост-чек под advisory-lock (RPC): если открытых платежей нет — закрыть сделку
    let closedDeal = false;
    try {
      const trip = await getTripRow(tripId);
      if (trip?.deal_id) {
        const { data: openCount } = await supabase.rpc('compute_open_count_now', { p_trip_id: tripId });
        const oc = Number(openCount || 0);
        log('post-check compute_open_count_now', { openCount: oc });

        if (oc === 0) {
          // Сценарий 1: полная отмена организатором всей поездки — старое поведение (canceled)
          if (!isSelfLeave && String(reason) === 'organizer_trip_cancel') {
            await closeSpDeal({ terminalKey: TBANK_TERMINAL_KEY, dealId: trip.deal_id });
            closedDeal = true;
            await finalizeTripWithStatus(tripId, 'canceled');
            await supabase.from('payout_logs').insert({
              trip_id: tripId,
              action: 'deal_closed_after_full_refunds',
              details: { paymentId, externalRequestId: extId, actorUserId, finalStatus: 'canceled' },
            });
            log('Auto-close: deal closed via closeSpDeal and trip finalized', { finalStatus: 'canceled' });
          } else {
            // Сценарий 2: админ-«Произвести выплаты и возврат» → полный возврат ПОСЛЕДНЕГО платежа
            const isFullRefund = Math.abs(Number(paymentRow.amount || 0) - refundRub) < EPS;
            if (isAdminActor && hasDisputesAccess && isAdminDisputesFlow && isFullRefund) {
              try { await closeSpDeal({ terminalKey: TBANK_TERMINAL_KEY, dealId: trip.deal_id }); } catch (_) {}
              closedDeal = true;
              await finalizeTripWithStatus(tripId, 'archived');
              await supabase.from('payout_logs').insert({
                trip_id: tripId,
               action: 'deal_closed_after_admin_dispute_last_full_refund',
                details: { paymentId, externalRequestId: extId, actorUserId, finalStatus: 'archived' },
              });
              log('Auto-close: deal closed & trip archived (admin disputes last full refund)');
            } else {
              log('Auto-close skipped: not organizer_trip_cancel nor admin_disputes_last_full_refund');
            }
          }
        } else {
          log('Auto-close skipped: openCount > 0', { openCount: oc });
        }
      } else {
        log('Auto-close skipped: trip.deal_id is empty');
     }
    } catch (autoErr) {
      logErr('Auto-close (closeSpDeal/archive) error:', autoErr?.message || autoErr);
      // возврат уже зафиксирован — ответ не валим
    }

    const newAmountRub = bankJson?.NewAmount != null ? bankJson.NewAmount / 100 : null;

    const okPayload = {
      ok: true,
      refund: {
        id: refundRowId,
        amountRub: refundRub,
        willClosePayment: willClose,
        externalRequestId: extId,
      },
      bank: {
        status: bankJson?.Status,
        newAmountRub,
      },
      autoClose: {
        closedDeal: !!closedDeal,
        archivedTrip: !!closedDeal,
      },
    };
    log('Response 200', okPayload);
    return res.status(200).json(okPayload);
  } catch (e) {
    logErr('Fatal error:', e?.message, e?.stack);
    return res.status(500).json({ ok: false, error: e?.message || 'Внутренняя ошибка сервера' });
  }
}
