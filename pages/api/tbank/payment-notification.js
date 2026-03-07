// /api/tbank/payment-notification.js
import { supabase, getSupabaseAdmin } from './supabaseClient';
import crypto from 'crypto';
import { getTbankConfig } from './_config';

/**
 * Генерация токена по правилу A2C/E2C:
 * - Берём все поля (кроме Token/DigestValue/SignatureValue/X509SerialNumber/DATA)
 * - Сортируем по ключу
 * - Конкатенируем значения + Password
 * - SHA256
 *
 * Вариант passwordAtEnd оставлен для отладки нестандартных сборок токена.
 */
const generateToken = (params, label, passwordAtEnd = false) => {
  try {
    if (!tbankConfig.terminalSecret) {
      throw new Error('TBANK_SECRET не задан');
    }
    let sortedParams = Object.keys(params)
      .filter((k) => !['Token', 'DigestValue', 'SignatureValue', 'X509SerialNumber', 'DATA'].includes(k))
      .sort()
      .reduce((obj, key) => {
        obj[key] = String(params[key] ?? '');
        return obj;
      }, {});

    if (passwordAtEnd) {
      sortedParams['Password'] = tbankConfig.terminalSecret;
    } else {

      sortedParams = {
        ...sortedParams,
        Password: tbankConfig.terminalSecret,
      };

      sortedParams = Object.keys(sortedParams)
        .sort()
        .reduce((obj, key) => {
          obj[key] = String(sortedParams[key]);
          return obj;
        }, {});
    }

    const concatenated = Object.values(sortedParams).join('');
    const token = crypto.createHash('sha256').update(concatenated).digest('hex');

    console.log(`Параметры для генерации токена (${label}):`, {
      sortedParams,
      concatenatedPreview: concatenated.slice(0, 32) + '…' + concatenated.slice(-32),
      tbankSecret: tbankConfig.terminalSecret ? '**** (скрыт)' : 'не задан',
    });

    return { token, concatenated, sortedParams };
  } catch (error) {
    console.error(`Ошибка при генерации токена (${label}):`, { error: error.message });
    throw error;
  }
};

const tbankConfig = getTbankConfig();

export default async function handler(req, res) {
  console.log('Получен запрос на /api/tbank/payment-notification (полное тело):', {
    method: req.method,
    body: JSON.stringify(req.body, null, 2),
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL,
  });

  if (req.method !== 'POST') {
    console.error('Недопустимый метод запроса:', { method: req.method });
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const {
      Success,
      PaymentId,
      OrderId,
      Amount,
      Status,
      ErrorCode,
      Message,
      SpAccumulationId, // ← по мануалу тут всегда DealId (вне DATA)
      DealId,           // иногда может быть, но чаще пусто в EACQ
      Token,
      CardId,
      Pan,
      ExpDate,
      trip_id,
      participant_id,
      TerminalKey,
    } = req.body || {};

    console.log('Извлечённые параметры уведомления от Tinkoff:', {
      PaymentId,
      OrderId,
      Status,
      Success,
      Amount,
      ErrorCode,
      Message,
      DealId,
      SpAccumulationId, // debug
      CardId,
      Pan,
      ExpDate,
      trip_id,
      participant_id,
      Token,
    });

    // ---------- Проверка подписи (включаем SpAccumulationId и DealId) ----------
    const paramsForToken = {
      TerminalKey,
      OrderId,
      Success: String(Success),
      Status,
      PaymentId: String(PaymentId),
      ErrorCode,
      Amount: String(Amount),
      DealId: DealId || '',
      SpAccumulationId: SpAccumulationId || '',
      CardId: String(CardId || ''),
      Pan: Pan || '',
      ExpDate: ExpDate || '',
      Message: Message || '',
    };

    const { token: expectedToken } = generateToken(paramsForToken, 'Все параметры');

    // Диагностические сборки токена (оставлены)
    const tokenCombinations = [
      {
        label: 'Базовый набор',
        params: {
          TerminalKey,
          OrderId,
          Success: String(Success),
          Status,
          PaymentId: String(PaymentId),
          ErrorCode,
          DealId: DealId || '',
        },
        passwordAtEnd: false,
      },
      {
        label: 'Базовый набор (Password в конце)',
        params: {
          TerminalKey,
          OrderId,
          Success: String(Success),
          Status,
          PaymentId: String(PaymentId),
          ErrorCode,
          DealId: DealId || '',
        },
        passwordAtEnd: true,
      },
      {
        label: 'С Amount',
        params: {
          TerminalKey,
          OrderId,
          Success: String(Success),
          Status,
          PaymentId: String(PaymentId),
          ErrorCode,
          Amount: String(Amount),
          DealId: DealId || '',
        },
        passwordAtEnd: false,
      },
      {
        label: 'С SpAccumulationId (legacy)',
        params: {
          TerminalKey,
          OrderId,
          Success: String(Success),
          Status,
          PaymentId: String(PaymentId),
          ErrorCode,
          SpAccumulationId: SpAccumulationId || '',
        },
        passwordAtEnd: false,
      },
    ];

    const tokenResults = [
      { label: 'Все параметры', token: expectedToken, concatenated: '', sortedParams: paramsForToken },
    ];

    for (const combo of tokenCombinations) {
      const { token, concatenated, sortedParams } = generateToken(combo.params, combo.label, combo.passwordAtEnd);
      tokenResults.push({ label: combo.label, token, concatenated, sortedParams });
    }

    console.log('Результаты проверки токенов:', {
      tokenResults,
      receivedToken: Token,
      matchedCombination: expectedToken === Token ? 'Все параметры' : null,
    });

    // === CHANGED: неверный токен → 401, чтобы банк ретраил ===
    if (expectedToken !== Token) {
      console.error('Неверный токен:', { tokenResults, receivedToken: Token });
      return res.status(401).send('Invalid token');
    }

    // ---------- Поиск существующего платежа ----------
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id, trip_id, participant_id, status, payment_id, order_id, is_authorized, is_confirmed, is_refunded, deal_id')
      .eq('order_id', OrderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // === CHANGED: ошибка БД → 500 ===
    if (paymentError && paymentError.code !== 'PGRST116') {
      console.error('DB error: не удалось прочитать платеж по OrderId', { error: paymentError.message, OrderId });
      return res.status(500).send('DB fetch error');
    }

    // Идентификатор сделки для сохранения (NN) — строго из DealId || SpAccumulationId
    const effectiveDealId = (DealId || SpAccumulationId || '').toString() || null;

    // Идемпотентность по флагам (оставляем 200 OK)
    if (payment) {
      if (
        (Status === 'AUTHORIZED' && payment.is_authorized) ||
        (Status === 'CONFIRMED' && payment.is_confirmed) ||
        (Status === 'REFUNDED' && payment.is_refunded)
      ) {
        console.log('Уведомление уже обработано, пропускаем:', {
          PaymentId,
          OrderId,
          Status,
          is_authorized: payment.is_authorized,
          is_confirmed: payment.is_confirmed,
          is_refunded: payment.is_refunded,
        });
        // дозаполним deal_id при идемпотентности (мягко)
        if (effectiveDealId && !payment.deal_id) {
          await supabase.from('payments').update({ deal_id: effectiveDealId }).eq('id', payment.id);
          console.log('Дозаполнили payments.deal_id при идемпотентности', { effectiveDealId });
        }
        return res.status(200).send('OK');
      }
    }

    // Извлекаем trip/participant при отсутствии записи
    let tripId = payment?.trip_id || trip_id;
    let participantId = payment?.participant_id || participant_id;

    // === CHANGED: если вообще нет payment и нет trip/participant → 404 (пусть ретраят) ===
    if (!tripId || !participantId) {
      if (!payment) {
        console.warn('Payment not found by OrderId, нет trip/participant', { OrderId });
        return res.status(404).send('Payment not found');
      }
      tripId = payment.trip_id;
      participantId = payment.participant_id;
    }

    // ---------- Обработка статусов ----------
const S = String(Status || '').toUpperCase();

if (S === 'AUTHORIZED' && Success) {
  // === AUTHORIZED ===
  if (!payment) {
    const { data: newPayment, error: insertError } = await supabase
      .from('payments')
      .insert({
        order_id: OrderId,
        payment_id: PaymentId,
        trip_id: tripId,
        participant_id: participantId,
        amount: Amount / 100,
        status: 'pending',
        deal_id: effectiveDealId,
        payment_type: 'participant_payment',
        is_authorized: true,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insertError) {
      console.error('DB error: insert payment (AUTHORIZED) failed', { error: insertError.message });
      return res.status(500).send('DB insert error');
    }
    console.log('Создана предварительная запись AUTHORIZED:', { payment: newPayment });
  } else if (!payment.is_authorized) {
    const updatePatch = {
      payment_id: PaymentId,
      is_authorized: true,
      updated_at: new Date().toISOString(),
    };
    if (effectiveDealId && !payment.deal_id) updatePatch.deal_id = effectiveDealId;

    const { error: updateError } = await supabase
      .from('payments')
      .update(updatePatch)
      .eq('id', payment.id);

    if (updateError) {
      console.error('DB error: update payment (AUTHORIZED) failed', { error: updateError.message });
      return res.status(500).send('DB update error');
    }
    console.log('Обновлена запись для AUTHORIZED:', {
      PaymentId, OrderId, is_authorized: true, setDealId: !!updatePatch.deал_id,
    });
  }

  // мягко проставим deal_id в trips
  if (effectiveDealId) {
    try {
      const { data: tripRow, error: tripSelErr } = await supabase
        .from('trips').select('id, deal_id').eq('id', tripId).single();
      if (!tripSelErr && tripRow && !tripRow.deal_id) {
        const { error: tripUpdateError } = await supabase
          .from('trips').update({ deal_id: effectiveDealId }).eq('id', tripId);
        if (tripUpdateError) {
          console.error('Ошибка обновления deal_id в trips (AUTHORIZED):', { error: tripUpdateError.message });
        } else {
          console.log('deal_id (NN) сохранён в trips (AUTHORIZED):', { dealId: effectiveDealId });
        }
      }
    } catch (e) {
      console.error('Ошибка чтения/обновления trips.deal_id (AUTHORIZED):', { error: e.message });
    }
  }

  return res.status(200).send('OK');
}

if (S === 'CONFIRMED' && Success) {
  // === CONFIRMED ===
  if (!payment) {
    console.error('Payment not found for CONFIRMED', { OrderId, PaymentId });
    return res.status(500).send('Payment not found');
  }

  const updatePatch = {
    payment_id: PaymentId,
    status: 'confirmed',
    amount: Amount / 100,
    is_confirmed: true,
    updated_at: new Date().toISOString(),
  };
  if (effectiveDealId && !payment.deal_id) updatePatch.deal_id = effectiveDealId;

  const { error: updateError } = await supabase
    .from('payments')
    .update(updatePatch)
    .eq('id', payment.id);

  if (updateError) {
    console.error('DB error: update payment (CONFIRMED) failed', { error: updateError.message });
    return res.status(500).send('DB update error');
  }

  const { data: tripRowC, error: tripReadErrC } = await supabase
    .from('trips').select('status').eq('id', tripId).single();
  if (tripReadErrC) {
    console.error('DB error: read trip status (CONFIRMED)', { error: tripReadErrC.message });
    return res.status(500).send('DB read error');
  }

  const tripStatusC = String(tripRowC?.status || '').toLowerCase();
  const participantPatch = tripStatusC === 'canceled' ? { status: 'canceled' } : { status: 'paid' };

  const { error: participantError } = await supabase
    .from('trip_participants')
    .update(participantPatch)
    .eq('trip_id', tripId)
    .eq('user_id', participantId)
    .neq('status', 'rejected'); // не трогаем тех, кто уже вышел сам
  if (participantError) {
    console.error('DB error: update participant status (CONFIRMED) failed', { error: participantError.message });
    return res.status(500).send('DB update error');
  }

  if (effectiveDealId) {
    try {
      const { data: tripRow, error: tripSelErr } = await supabase
        .from('trips').select('id, deal_id').eq('id', tripId).single();
      if (!tripSelErr && tripRow && !tripRow.deal_id) {
        const { error: tripUpdateError } = await supabase
          .from('trips').update({ deal_id: effectiveDealId }).eq('id', tripId);
        if (tripUpdateError) {
          console.error('Ошибка обновления deal_id в trips (CONFIRMED):', { error: tripUpdateError.message });
        } else {
          console.log('deal_id (NN) сохранён в trips (CONFIRMED):', { dealId: effectiveDealId });
        }
      }
    } catch (e) {
      console.error('Ошибка чтения/обновления trips.deal_id (CONFIRMED):', { error: e.message });
    }
  }

  // === Оповещения: участнику и организатору о подтверждённой оплате ===
  try {
    const supabaseAdmin = getSupabaseAdmin();

    const { data: tripInfo, error: tripInfoErr } = await supabaseAdmin
      .from('trips')
      .select('creator_id, title')
      .eq('id', tripId)
      .single();

    if (tripInfoErr) {
      console.error('[payment-notification] read tripInfo error:', tripInfoErr.message);
    } else {
      const tripTitle = tripInfo?.title || '';
      const organizerId = tripInfo?.creator_id || null;

      let participantUserId = participantId;
      let participantProfile = null;

      if (participantUserId) {
        const { data: profileByUserId } = await supabaseAdmin
          .from('profiles')
          .select('full_name, first_name, last_name')
          .eq('user_id', participantUserId)
          .maybeSingle();
        participantProfile = profileByUserId || null;
      }

      // Фолбэк: в старых/нестандартных сценариях payments.participant_id может хранить trip_participants.id.
      if (!participantProfile && participantId && tripId) {
        const { data: participantRow } = await supabaseAdmin
          .from('trip_participants')
          .select('id, user_id')
          .eq('trip_id', tripId)
          .eq('id', participantId)
          .maybeSingle();

        if (participantRow?.user_id) {
          participantUserId = participantRow.user_id;
          const { data: profileByResolvedUserId } = await supabaseAdmin
            .from('profiles')
            .select('full_name, first_name, last_name')
            .eq('user_id', participantUserId)
            .maybeSingle();
          participantProfile = profileByResolvedUserId || null;

          console.log('[payment-notification] resolved participant user_id via trip_participants.id', {
            tripId,
            participantId,
            participantUserId,
          });
        }
      }

      const participantName =
        [participantProfile?.first_name, participantProfile?.last_name].filter(Boolean).join(' ').trim() ||
        participantProfile?.full_name ||
        'Участник';

      const payloads = [
        {
          user_id: participantUserId || participantId,
          trip_id: tripId,
          actor_user_id: participantUserId || participantId,
          type: 'trip_payment_paid',
          title: 'Оплата подтверждена',
          body: `Вы оплатили поездку «${tripTitle}».`,
          metadata: { tripTitle },
        },
      ];

      if (organizerId) {
        payloads.push({
          user_id: organizerId,
          trip_id: tripId,
          actor_user_id: participantUserId || participantId,
          type: 'trip_payment_paid_by_participant',
          title: 'Участник оплатил поездку',
          body: `Участник «${participantName}» оплатил поездку «${tripTitle}».`,
          metadata: { tripTitle, participantName },
        });
      }

      const { error: alertErr } = await supabaseAdmin.from('trip_alerts').insert(payloads);
      if (alertErr) {
        console.error('[payment-notification] insert trip_alerts error:', alertErr.message);
      }
    }
  } catch (e) {
    console.error('[payment-notification] Ошибка в блоке создания оповещений об оплате:', e);
  }

  console.log('Платёж CONFIRMED сохранён:', {
    PaymentId, OrderId, Amount, dealIdSaved: !!effectiveDealId,
  });
  return res.status(200).send('OK');
}

if (S === 'REFUNDED' && Success) {
  // === REFUNDED ===
  if (!payment) {
    console.error('Payment not found for REFUNDED', { OrderId, PaymentId });
    return res.status(500).send('Payment not found');
  }

  const updatePatch = {
    payment_id: PaymentId,
    status: 'refunded',
    amount: Amount / 100,
    is_refunded: true,
    updated_at: new Date().toISOString(),
  };
  if (effectiveDealId && !payment.deal_id) updatePatch.deal_id = effectiveDealId;

  const { error: updateError } = await supabase
    .from('payments')
    .update(updatePatch)
    .eq('id', payment.id);

  if (updateError) {
    console.error('DB error: update payment (REFUNDED) failed', { error: updateError.message });
    return res.status(500).send('DB update error');
  }

  const { data: tripRow, error: tripReadErr } = await supabase
    .from('trips').select('status').eq('id', tripId).single();
  if (tripReadErr) {
    console.error('DB error: read trip status (REFUNDED)', { error: tripReadErr.message });
    return res.status(500).send('DB read error');
  }

  const tripStatus = String(tripRow?.status || '').toLowerCase();
  const isTripCanceling = ['canceled', 'canceling'].includes(tripStatus);
  const nextParticipantStatus = isTripCanceling ? 'canceled' : 'rejected';

  let q = supabase
    .from('trip_participants')
    .update({ status: nextParticipantStatus })
    .eq('trip_id', tripId)
    .eq('user_id', participantId);
  if (nextParticipantStatus === 'rejected') {
    q = q.neq('status', 'canceled');
  } else {
    q = q.neq('status', 'rejected');
  }
  const { error: participantError } = await q;
  if (participantError) {
    console.error('DB error: update participant status (REFUNDED) failed', { error: participantError.message });
    return res.status(500).send('DB update error');
  }

  if (effectiveDealId) {
    try {
      const { data: tripRow2, error: tripSelErr } = await supabase
        .from('trips').select('id, deal_id').eq('id', tripId).single();
      if (!tripSelErr && tripRow2 && !tripRow2.deal_id) {
        const { error: tripUpdateError } = await supabase
          .from('trips').update({ deal_id: effectiveDealId }).eq('id', tripId);
        if (tripUpdateError) {
          console.error('Ошибка обновления deal_id в trips (REFUNDED):', { error: tripUpdateError.message });
        } else {
          console.log('deal_id (NN) сохранён в trips (REFUNDED):', { dealId: effectiveDealId });
        }
      }
    } catch (e) {
      console.error('Ошибка чтения/обновления trips.deal_id (REFUNDED):', { error: e.message });
    }
  }

  console.log('Возврат REFUNDED сохранён:', { PaymentId, OrderId, Amount, dealIdSaved: !!effectiveDealId });
  return res.status(200).send('OK');
}

if (S === 'PARTIAL_REFUNDED' && Success) {
  // Частичный возврат — payments.status НЕ трогаем (оставляем 'confirmed').
  if (!payment) {
    console.error(`Payment not found for ${S}`, { OrderId, PaymentId });
    return res.status(500).send('Payment not found');
  }
  console.log('Partial refund notification: keep payments.status=confirmed; handled elsewhere.', {
    PaymentId, OrderId, Amount,
  });
  return res.status(200).send('OK');
}

if (['REVERSED', 'CANCELED', 'PARTIAL_REVERSED'].includes(S)) {
  // Обратные/отменённые статусы — не трогаем payments.status
  if (!payment) {
    console.error(`Payment not found for ${S}`, { OrderId, PaymentId });
    return res.status(404).send('Payment not found');
  }
  console.log(`Notification ${S}: leaving payments/status untouched`, {
    PaymentId, OrderId, Amount, Success, ErrorCode, Message,
  });
  return res.status(200).send('OK');
}

if (['REJECTED', 'DEADLINE_EXPIRED'].includes(S)) {
  console.log(`Notification with non-final status ${S}:`, {
    PaymentId, OrderId, ErrorCode, Message,
  });
  return res.status(200).send('OK');
}

// На прочие/неожиданные статусы отвечаем 200, чтобы не заспамить ретраями
console.log('Unhandled Status (ignored):', { Status: S, PaymentId, OrderId, Success, ErrorCode, Message });
return res.status(200).send('OK');
  } catch (err) {
    console.error('payment-notification handler error:', {
      error: err?.message,
      stack: err?.stack,
    });
    return res.status(500).send('Internal Server Error');
  }
}
