// /pages/api/tbank/init-payment.js
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { getTbankConfig } from './_config';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tbankConfig = getTbankConfig();
const TBANK_BASE = tbankConfig.restBase;

const log  = (...a) => console.log('[init-payment]', ...a);
const logE = (...a) => console.error('[init-payment]', ...a);

// Оплатный терминал — БЕЗ суффикса E2C
const stripE2C = (tk) => (tk ? tk.replace(/E2C$/i, '') : tk);

// Базовый URL сервера (для SuccessURL/FailURL)
function absoluteBaseUrl(req) {
  const envBase = (process.env.NEXT_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (envBase) return envBase;
  const host  = req?.headers?.host;
  const proto = (req?.headers?.['x-forwarded-proto'] || 'https').toString();
  return `${proto}://${host}`;
}

/** Подпись (без DATA) */
function generateToken(params) {
  if (!tbankConfig.terminalSecret) throw new Error('TBANK_SECRET не задан');
  const keys = Object.keys(params)
    .filter(k => !['Token','DigestValue','SignatureValue','X509SerialNumber','DATA'].includes(k))
    .sort();
  const concatenated = keys.map(k => String(params[k])).join('') + tbankConfig.terminalSecret;
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

/** Отладочное описание того, КАК мы собрали токен (ничего не меняет) */
function makeTokenDebugForInit(params) {
  const filteredKeys = Object.keys(params)
    .filter(k => !['Token','DigestValue','SignatureValue','X509SerialNumber','DATA'].includes(k))
    .sort();

  const concatWithoutSecret = filteredKeys.map(k => String(params[k])).join('');
  const concatPreview = concatWithoutSecret.slice(0, 24) + '...' + concatWithoutSecret.slice(-24);

  const token = generateToken(params); // как реально используется
  const tokenPreview = token.slice(0, 8) + '...' + token.slice(-8);

  return {
    orderedKeys: filteredKeys,
    concatenatedLen: concatWithoutSecret.length + (tbankConfig.terminalSecret ? String(tbankConfig.terminalSecret).length : 0),
    concatenatedPreview: concatPreview + ' + <SECRET>',
    tokenPreview,
  };
}

async function tbankCall(path, payload, { attempts = 2, retryOn = [502,504], delayMs = 350 } = {}) {
  const url = `${TBANK_BASE}${path}`;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const startedAt = Date.now();
    const resp = await fetch(url, {
      method : 'POST',
      headers: { 'Content-Type':'application/json' },
      body   : JSON.stringify(payload),
    });
    const ms = Date.now() - startedAt;

    // читаем текст ВСЕГДА
    const rawText = await resp.text();
    let json = null;
    try { json = rawText ? JSON.parse(rawText) : null; } catch {}

    // детальный лог ответа
    console.log('[init-payment] [TBANK] response', {
      url: path,
      httpStatus: resp.status,
      ms,
      jsonKeys: json ? Object.keys(json) : null,
    });

    // сохраняем для возвращения
    last = { resp, rawText, json, ms };

    if (!retryOn.includes(resp.status)) return last;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  return last;
}

export default async function handler(req, res) {
  log('request', { method: req.method, baseUrl: process.env.NEXT_PUBLIC_BASE_URL });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Метод не разрешён' });

  let body;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : await req.json();
  } catch {
    return res.status(400).json({ error: 'Некорректное тело запроса' });
  }

  try {
    if (!tbankConfig.terminalKeyBase || !tbankConfig.terminalSecret) {
      return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
    }

    // Поддержка НОВЫХ и СТАРЫХ полей запроса одновременно (обратная совместимость)
    const {
      // обязательные поля
      tripId, participantId, amount, orderId,
      notificationUrl, // всегда ваш /api/tbank/payment-notification
      successUrl, failUrl, // будут пересобраны на бэке из payment.order_id
      // старые поля фронта
      selectedCardId, saveCard, customerKey: rawCustomerKey,
      // новые поля фронта
      defaultCardId, withCustomerKey, noCustomerKey, phone,
    } = body;

    if (!tripId || !participantId || !amount || !orderId || !notificationUrl || !successUrl || !failUrl) {
      return res.status(400).json({ error: 'Недостаточно данных' });
    }

    // Валидация суммы
    const amountNum = Number(amount);
    const amountCents = Math.round(amountNum * 100);
    if (!Number.isFinite(amountNum) || amountNum <= 0 || !Number.isInteger(amountCents)) {
      return res.status(400).json({ error: 'Некорректная сумма' });
    }

    // auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Неавторизованный запрос' });
    const jwt = authHeader.slice(7);
    const sbUser = createClient(supabaseUrl, supabaseKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: { user }, error: authError } = await sbUser.auth.getUser();
    if (authError || !user) return res.status(401).json({ error: 'Неавторизованный запрос' });

    // participant
    const { data: participant, error: pErr } = await sbUser
      .from('trip_participants')
      .select('id,status,user_id')
      .eq('trip_id', tripId)
      .eq('user_id', participantId)
      .single();
    if (pErr || !participant) return res.status(400).json({ error: 'Участник не найден' });
    if (participant.status !== 'confirmed') {
      return res.status(400).json({ error: `Оплата доступна только для подтверждённых участников, текущий статус: ${participant.status}` });
    }

    // trip
    const { data: trip, error: tErr } = await sbUser
      .from('trips')
      .select('id,status,deal_id,title')
      .eq('id', tripId)
      .single();
    if (tErr || !trip) return res.status(400).json({ error: 'Поездка не найдена' });

    // pending dedupe (учитываем и authorized & !confirmed как «открытый»)
    const { data: pending, error: pendErr } = await supabase
      .from('payments')
      .select('id,order_id,payment_id,created_at,is_authorized,is_confirmed')
      .eq('trip_id', tripId)
      .eq('participant_id', participantId)
      .or('status.eq.pending,and(is_authorized.is.true,is_confirmed.is.false)')
      .order('created_at', { ascending: false });
    if (pendErr) return res.status(500).json({ error: 'Ошибка проверки незавершённых платежей', details: pendErr.message });

    let payment;
    if (pending?.length > 1) {
      for (const old of pending.slice(1)) {
        const { error } = await supabase.from('payments').delete().eq('id', old.id);
        if (error) return res.status(500).json({ error: 'Ошибка удаления старых платежей', details: error.message });
        log('Удалён старый платёж:', { paymentId: old.id });
      }
      payment = pending[0];
    } else if (pending?.length === 1) {
      payment = pending[0];
    }

    // collision by orderId
    const { data: existing, error: existErr } = await supabase
      .from('payments').select('id,status,participant_id,trip_id,order_id')
      .eq('order_id', orderId)
      .single();
    if (existErr && existErr.code !== 'PGRST116') {
      return res.status(500).json({ error: 'Ошибка проверки платежа', details: existErr.message });
    }
    if (!payment && existing) {
      if (existing.participant_id !== participantId || existing.trip_id !== tripId) {
        return res.status(400).json({ error: 'Платёж с таким идентификатором уже существует для другого участника/поездки' });
      }
      payment = existing;
    } else if (!payment) {
      // вставка новой «открытой» записи
      const { data: ins, error: insErr } = await supabase
        .from('payments')
        .insert({
          order_id: orderId, trip_id: tripId, participant_id: participantId,
          amount: amountNum, status: 'pending', payment_type: 'participant_payment', created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (insErr) {
        // Расширенный перехват дубля
        logE('[Init][insert] error object', { insErr });
        const isDup =
          insErr?.code === '23505' ||
          insErr?.status === 409 ||
          /duplicate key value/i.test(insErr?.message || '') ||
          /ux_payments_open_per_trip_participant/i.test(insErr?.message || '') ||
          /already exists/i.test(insErr?.message || '');

        if (isDup) {
          const { data: reopen, error: reErr } = await supabase
            .from('payments')
            .select('id,order_id,payment_id,created_at,is_authorized,is_confirmed,locked_until')
            .eq('trip_id', tripId)
            .eq('participant_id', participantId)
            .or('status.eq.pending,and(is_authorized.is.true,is_confirmed.is.false)')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          if (reErr || !reopen) {
            return res.status(409).json({ error: 'Уже есть открытый платёж, но не удалось его прочитать. Попробуйте ещё раз.' });
          }
  if (!reopen.payment_type) {
    await supabase
      .from('payments')
      .update({ payment_type: 'participant_payment' })  // ← добиваем недоставшее
      .eq('id', reopen.id);
  }
payment = upd;
          payment = reopen; // ► продолжаем дальше с уже открытой записью
        } else {
          return res.status(500).json({ error: 'Ошибка создания записи платежа', details: insErr.message || insErr.hint || null });
        }
      } else {
        payment = ins;
      }
    }

    // --- pre-lock на 60 секунд, чтобы сузить окно гонки между вкладками/устройствами
    try {
      const preLockIso = new Date(Date.now() + 60 * 1000).toISOString();
      await supabase
        .from('payments')
        .update({ locked_until: preLockIso })
        .eq('id', payment.id);
      log('[Init] pre-lock applied', { locked_until: preLockIso });
    } catch (e) {
      logE('[Init] pre-lock failed:', e?.message);
    }

    // profile (номер в DATA пока не шлём)
    let PhoneFromProfile;
    try {
      const prof = await sbUser.from('profiles').select('phone').eq('user_id', user.id).single();
      PhoneFromProfile = prof?.data?.phone || undefined;
    } catch {}

    const customerKey = (rawCustomerKey || user.id || '').toString();

    // Проверяем выбранную карту локально: ТОЛЬКО scope='payment'
    const incomingDefaultCardId = (defaultCardId || selectedCardId) ? String(defaultCardId || selectedCardId) : null;
    let defaultCardForInit = null;

    if (incomingDefaultCardId) {
      const { data: cardRec } = await supabase
        .from('user_cards')
        .select('card_id,last_four_digits,expiry_date')
        .eq('user_id', user.id)
        .eq('card_scope', 'payment')
        .eq('card_id', incomingDefaultCardId)
        .single();

      if (cardRec?.card_id) {
        defaultCardForInit = String(cardRec.card_id);
        log('[CardSelect] Local DB confirms selected card exists after pre-sync', {
          cardId: defaultCardForInit,
          last4 : (cardRec.last_four_digits || '').slice(-4),
          exp   : cardRec.expiry_date || null,
        });
      } else {
        log('[CardSelect] Selected card not found in payment scope; will proceed as new card', {
          triedCardId: incomingDefaultCardId
        });
      }
    }

    // Оплатный терминал БЕЗ E2C
    const initTerminalKey = tbankConfig.terminalKeyEacq || stripE2C(tbankConfig.terminalKeyBase || '');

    // ─────────────────────────────────────────────────────────────
    // Итоговая стратегия передачи CustomerKey/DATA:
    //  0) noCustomerKey === true → ЧИСТАЯ ФОРМА (игнорируем выбранную карту/флаги)
    //  1) defaultCardForInit → CustomerKey + DATA{ DefaultCard }
    //  2) (withCustomerKey === true ИЛИ saveCard === true) → CustomerKey + (DATA без Phone)
    //  3) иначе → без CustomerKey и без DATA
    // ─────────────────────────────────────────────────────────────
    const baseParams = {
      TerminalKey: initTerminalKey,
      Amount: amountCents,
      OrderId: payment.order_id,
      Description: `Оплата поездки ${tripId}`,
      NotificationURL: notificationUrl,
      SuccessURL: 'will-be-overridden',
      FailURL: 'will-be-overridden',
    };

    // Пересобираем Success/Fail URL на бэке из итогового order_id
    const base = absoluteBaseUrl(req);
    const finalOrderId = baseParams.OrderId;
    const successUrlFinal = `${base}/payment-result?status=success&orderId=${finalOrderId}`;
    const failUrlFinal    = `${base}/payment-result?status=fail&orderId=${finalOrderId}`;

    const params = {
      ...baseParams,
      SuccessURL: successUrlFinal,
      FailURL: failUrlFinal,
    };

    const hasSavedCard = !!defaultCardForInit;
    const wantsSaveNew = !hasSavedCard && (withCustomerKey === true || saveCard === true);
    const forceNoCK    = noCustomerKey === true;

    // Case A: сохранённая карта
    if (hasSavedCard) {
      params.CustomerKey = customerKey;
      params.DATA = { DefaultCard: defaultCardForInit };
      log('[Init] Strategy', { mode: 'savedCard', CustomerKey: true, DATA: params.DATA });

    // Case B: новая без сохранения (включая явный noCustomerKey)
    } else if (!wantsSaveNew) {
      if (!forceNoCK) {
        // могли бы поставить CK, но сознательно НЕ ставим
      }
      params.DATA = { DefaultCard: 'none' };
      log('[Init] Strategy', { mode: 'newCard_noSave', CustomerKey: false, DATA: params.DATA });

    // Case C: новая с сохранением
    } else {
      if (!forceNoCK) {
        params.CustomerKey = customerKey;
      }
      params.DATA = { DefaultCard: 'none' };
      log('[Init] Strategy', { mode: 'newCard_save', CustomerKey: !forceNoCK, DATA: params.DATA });
    }

    // ----- Deal binding -----
    if (trip?.deal_id) {
      params.DealId = String(trip.deal_id);
      log('[Init] Deal binding', { mode: 'existing', DealId: params.DealId });
    } else {
      params.CreateDealWithType = 'NN';
      log('[Init] Deal binding', { mode: 'create', CreateDealWithType: params.CreateDealWithType });
    }

    // Подробный лог перед генерацией токена (после установки RedirectDueDate!)
    const tokenDebug = makeTokenDebugForInit(params);
    log('[Init] Token(inputs) debug', tokenDebug);

    // Генерируем токен и финальный payload
    params.Token = generateToken(params);

    // Подробный лог параметров Init
    log('[Init] Request payload', {
      url: `${TBANK_BASE}/v2/Init`,
      terminalKey: initTerminalKey,
      protocol: 'EACQ',
      amount: params.Amount,
      orderId: params.OrderId,
      description: params.Description,
      notificationURL: params.NotificationURL,
      successURL: params.SuccessURL,
      failURL: params.FailURL,
      customerKey: params.CustomerKey || null,
      DATA: params.DATA
        ? (() => {
            const { Phone, phone: phone2, ...rest } = params.DATA; // выкинем Phone из логов/сигнатуры
            return Object.keys(rest).length ? rest : undefined;
          })()
        : undefined,
      DealId: params.DealId || null,
      CreateDealWithType: params.CreateDealWithType || null,
      Token: '[hidden]'
    });

    log('[Init] Final terminal & card', {
      initTerminalKey,
      defaultCardApplied: !!(params.DATA && params.DATA.DefaultCard),
      defaultCardId: (params.DATA && params.DATA.DefaultCard) || null,
      selectedCardId: incomingDefaultCardId || null,
      protocol: 'EACQ'
    });

    const { resp, rawText, json: initJson } =
      await tbankCall('/v2/Init', params, { attempts: 2, retryOn: [502,504], delayMs: 350 });

    if (!resp.ok || !initJson?.Success) {
      logE('Init error', {
        status: resp.status,
        json: initJson || null,
        rawTextPreview: (typeof rawText === 'string' ? rawText.slice(0, 1000) : null),
      });
      if ([502,504].includes(resp.status)) {
        return res.status(503).json({ error: 'Временная ошибка сервиса оплаты', details: 'Шлюз недоступен (502/504). Попробуйте ещё раз.' });
      }
      return res.status(400).json({
        error: initJson?.Message || `Ошибка инициализации платежа (HTTP ${resp.status})`,
        details: initJson?.Details || initJson?.ErrorCode || rawText || null,
      });
    }

    // Успешный ответ
    log('[Init] Success response summary', {
      TerminalKey: initJson.TerminalKey,
      Status: initJson.Status,
      PaymentId: initJson.PaymentId,
      OrderId: initJson.OrderId,
      Amount: initJson.Amount,
      hasPaymentURL: !!initJson.PaymentURL,
      DealId: initJson.DealId || null,
    });

    // Показать сам PaymentURL (для отладки)
    if (initJson.PaymentURL) {
      console.log('[Init] PaymentURL:', initJson.PaymentURL);
    } else {
      console.warn('[Init] NO PaymentURL. Full Init JSON:');
      console.dir(initJson, { depth: null });
    }

    if (!initJson.PaymentURL) return res.status(500).json({ error: 'PaymentURL не получен' });

    // Если банк вернул NN DealId и trips.deal_id ещё пуст — сохраним в поездку
    if (initJson.DealId && !trip.deal_id) {
      const { error: tripUpdErr } = await supabase
        .from('trips')
        .update({ deal_id: String(initJson.DealId) })
        .eq('id', tripId);
      if (tripUpdErr) return res.status(500).json({ error: 'Ошибка сохранения deal_id', details: tripUpdErr.message });
      log('[Init] deal_id (NN) saved into trip', { dealId: String(initJson.DealId) });
    }

    // Сохраняем payment_id / deal_id и ставим фронтовый лок на 10 минут
    const lockUntilIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error: payUpdErr } = await supabase
      .from('payments')
      .update({
        payment_id: initJson.PaymentId,
        deal_id: (initJson.DealId && String(initJson.DealId)) || (trip.deal_id ? String(trip.deal_id) : null),
        locked_until: lockUntilIso, // фронтовый лок
      })
      .eq('id', payment.id);

    if (payUpdErr) {
      return res.status(500).json({ error: 'Ошибка сохранения payment_id', details: payUpdErr.message });
    }

    log('[Init] payment locked_until set', { locked_until: lockUntilIso });

    return res.status(200).json({
      success    : true,
      paymentId  : initJson.PaymentId,
      paymentUrl : initJson.PaymentURL,
      dealId     : initJson.DealId || trip.deal_id || null,
      lockedUntil: lockUntilIso, // фронту удобно сразу рисовать таймер
      orderId    : finalOrderId, // для явной консистентности на клиенте
    });
  } catch (e) {
    logE('fatal', e);
    return res.status(500).json({ error: e?.message || 'Внутренняя ошибка сервера' });
  }
}
