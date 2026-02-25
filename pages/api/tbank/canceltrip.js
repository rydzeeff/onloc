// pages/api/tbank/canceltrip.js
import { createClient } from '@supabase/supabase-js';
import { getTbankConfig } from './_config';
import crypto from 'crypto';

const tbankConfig = getTbankConfig();

// --- TBank helpers: closeSpDeal (+ простой sha256-токен) ---
function tbToken(params) {
  const withPwd = { ...params, Password: tbankConfig.terminalSecret || '' };
  // сортируем по ключу и конкатим значения
  const sorted = Object.keys(withPwd)
    .filter((k) => !['Token','DigestValue','SignatureValue','X509SerialNumber'].includes(k))
    .sort()
    .map((k) => String(withPwd[k]))
    .join('');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

async function closeSpDeal({ terminalKey, dealId }) {
  if (!terminalKey) throw new Error('TerminalKey is empty');
  if (!dealId) throw new Error('SpAccumulationId (dealId) is empty');

  const apiUrl = `${tbankConfig.eacqBaseV2}/closeSpDeal`;

  const params = { TerminalKey: terminalKey, SpAccumulationId: String(dealId) };
  const body = { ...params, Token: tbToken(params) };

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json?.Success || String(json?.ErrorCode) !== '0') {
    throw new Error(json?.Message || json?.Details || 'closeSpDeal failed');
  }
  return json;
}

/**
 * Дет. внешний ID для идемпотентности вызова Cancel у банка:
 * один и тот же вход → один и тот же ExternalRequestId
 */
function makeExternalRequestId({ tripId, participantId, paymentId, amount, batchId }) {
  const raw = `${tripId}:${participantId}:${paymentId}:${amount}:${batchId}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { tripId } = req.body || {};
    if (!tripId) return res.status(400).json({ error: 'tripId required' });

    // 0) Авторизация: берём JWT из заголовка и собираем клиент с этим JWT,
    //    чтобы RLS (auth.uid()) в политике видел создателя поездки.
    const authHeader = req.headers.authorization || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: 'Unauthorized' });

    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );

    // 1) Проверим, есть ли уже активный батч для этой поездки (idempotent)
    let { data: existingBatch, error: existingErr } = await db
      .from('trip_cancellations')
      .select('id, status, refund_progress, total_refunds, trip_id')
      .eq('trip_id', tripId)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error('[canceltrip] read existing batch error:', existingErr.message);
      return res.status(500).json({ error: 'DB error (existing batch)' });
    }

    let batch = existingBatch;

    // 2) Если активного батча нет — создаём новый + ставим trip.status='canceling'
    if (!batch) {
      // Посчитать, сколько участникам нужно инициировать возвраты (status='paid')
      const { data: paidList, error: paidErr } = await db
        .from('trip_participants')
        .select('user_id')
        .eq('trip_id', tripId)
        .eq('status', 'paid');

      if (paidErr) {
        console.error('[canceltrip] read paid participants error:', paidErr.message);
        return res.status(500).json({ error: 'DB error (paid participants)' });
      }
      const totalRefunds = (paidList || []).length;

      // Если оплаченных нет — закрываем сделку и завершаем отмену сразу
     if (totalRefunds === 0) {
        // (а) Закрываем SP-сделку напрямую (если у поездки есть deal_id)
        try {
          const { data: tripRow } = await db
            .from('trips')
            .select('deal_id')
            .eq('id', tripId)
            .maybeSingle();
          if (tripRow?.deal_id) {
            await closeSpDeal({
             terminalKey: tbankConfig.terminalKeyEacq || tbankConfig.terminalKeyBase,
              dealId: tripRow.deal_id,
            });
          }
        } catch (_) { /* мягко игнорим */ }

        // (б) Финальные состояния для «без оплат»
        await db.from('trips').update({ status: 'canceled' }).eq('id', tripId);
        await db
          .from('chats')
          .update({ chat_type: 'archived' })
          .eq('trip_id', tripId)
          .in('chat_type', ['trip_group', 'trip_private', 'dispute']);

// Проставим участникам статус 'canceled' (и тем, кто ждал — 'pending', и тем, кто успел оплатить — 'paid')
await db
  .from('trip_participants')
  .update({ status: 'canceled' })
  .eq('trip_id', tripId)
  .in('status', ['waiting', 'confirmed']); // 'waiting' ≈ 'pending', 'confirmed' ≈ 'paid'

        return res.status(200).json({
          success: true,
          batchId: null,
          status: 'canceled',
          total_refunds: 0,
          refund_progress: 0,
        });
      }

      // Ставим промежуточный статус, чтобы вебхуки не переводили участников в rejected
      const { error: tripSetCancelingErr } = await db
        .from('trips')
        .update({ status: 'canceling' })
        .eq('id', tripId);
      if (tripSetCancelingErr) {
        console.error('[canceltrip] set trip canceling error:', tripSetCancelingErr.message);
        return res.status(500).json({ error: 'DB error (set canceling)' });
      }

      const ins = await db
        .from('trip_cancellations')
        .insert({
          trip_id: tripId,
          status: 'pending',
          refund_progress: 0,
          total_refunds: totalRefunds,
        })
        .select()
        .single();

      if (ins.error) {
        console.error('[canceltrip] insert batch error:', ins.error.message);
        return res.status(500).json({ error: 'DB error (create batch)' });
      }
      batch = ins.data;
    }

    // 3) Переводим батч в running (если был pending)
    if (batch.status === 'pending') {
      const upd = await db
        .from('trip_cancellations')
        .update({ status: 'running' })
        .eq('id', batch.id)
        .select()
        .single();

      if (upd.error) {
        console.error('[canceltrip] set running error:', upd.error.message);
        return res.status(500).json({ error: 'DB error (set running)' });
      }
      batch = upd.data;
    }

    // 4) Получаем всех paid участников
    const { data: paidParticipants, error: paidErr2 } = await db
      .from('trip_participants')
      .select('user_id')
      .eq('trip_id', tripId)
      .eq('status', 'paid');

    if (paidErr2) {
      console.error('[canceltrip] read paid participants (2) error:', paidErr2.message);
      return res.status(500).json({ error: 'DB error (paid participants 2)' });
    }

    // 5) Для каждого участника: берём САМЫЙ СВЕЖИЙ платёж (любой статус) и действуем по статусу
    for (const p of paidParticipants || []) {
      // 5.1 Самый свежий participant_payment этого участника
      const { data: payment, error: payErr } = await db
        .from('payments')
        .select('id, payment_id, amount, status, created_at')
        .eq('trip_id', tripId)
        .eq('participant_id', p.user_id)
        .eq('payment_type', 'participant_payment')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (payErr) {
        console.warn('[canceltrip] payments read error:', payErr.message);
        continue;
      }
      if (!payment?.payment_id) {
        // нет платежа — просто считаем участника обработанным
        const { error: progErr } = await db
          .from('trip_cancellations')
          .update({ refund_progress: (batch.refund_progress || 0) + 1 })
          .eq('id', batch.id);
        if (progErr) await db.rpc('inc_trip_cancel_progress', { batch_id: batch.id }).catch(() => {});
        batch.refund_progress = (batch.refund_progress || 0) + 1;
        continue;
      }

      const status = String(payment.status || '').toLowerCase();

      // 5.2 Если платёж уже REFUNDED → проверим у банка через get-state и зачтём прогресс
      if (status === 'refunded') {
        try {
          const resp = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/get-state`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jwt}`,
            },
            body: JSON.stringify({ paymentId: String(payment.payment_id) }),
          });

          let okRefunded = false;
          if (resp.ok) {
            const js = await resp.json().catch(() => ({}));
            // ожидаем структуру вида { Success, Status, ... }
            okRefunded = js?.Success === true && String(js?.Status).toUpperCase() === 'REFUNDED';
          }

          if (okRefunded) {
            // считаем участника обработанным без повторного Cancel
            const { error: progErr } = await db
              .from('trip_cancellations')
              .update({ refund_progress: (batch.refund_progress || 0) + 1 })
              .eq('id', batch.id);
            if (progErr) await db.rpc('inc_trip_cancel_progress', { batch_id: batch.id }).catch(() => {});
            batch.refund_progress = (batch.refund_progress || 0) + 1;
            continue;
          }
          // если банк не подтвердил — падаем дальше в общий расчёт available (обычно он будет 0)
        } catch (e) {
          console.warn('[canceltrip] get-state failed (non-fatal):', e.message);
          // продолжаем потоком ниже
        }
      }

      // 5.3 Считаем уже возвращённую/забронированную сумму по ЭТОМУ платежу
      const { data: refunds, error: refErr } = await db
        .from('payment_refunds')
        .select('amount, status')
        .eq('payment_id', payment.id)
        .in('status', ['pending', 'confirmed']);

      if (refErr) {
        console.warn('[canceltrip] refunds read error:', refErr.message);
        continue;
      }

      const already = (refunds || []).reduce((s, r) => s + Number(r.amount || 0), 0);
      const available = Math.max(0, Number(payment.amount || 0) - already);

      // 5.4 Если остатка нет — по этому участнику делать нечего, просто двигаем прогресс батча
      if (available <= 0) {
        const { error: progErr } = await db
          .from('trip_cancellations')
          .update({ refund_progress: (batch.refund_progress || 0) + 1 })
          .eq('id', batch.id);
        if (progErr) await db.rpc('inc_trip_cancel_progress', { batch_id: batch.id }).catch(() => {});
        batch.refund_progress = (batch.refund_progress || 0) + 1;
        continue;
      }

      // 5.5 Если свежий платёж всё ещё confirmed → делаем возврат на доступный остаток
      if (status === 'confirmed') {
        const externalRequestId = makeExternalRequestId({
          tripId,
          participantId: p.user_id,
          paymentId: payment.payment_id,
          amount: available,
          batchId: batch.id,
        });

        try {
          const resp = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/tbank/cancel`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              paymentId: payment.payment_id,
              amount: available, // ← ВАЖНО: именно остаток
              tripId,
              participantId: p.user_id,
              externalRequestId,
              reason: 'organizer_trip_cancel',
              notes: `trip cancel batch=${batch.id}; user=${p.user_id}`,
            }),
          });

          let ok = false;
          if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            ok = !!data?.ok;
          }
          if (ok) {
            const { error: progErr } = await db
              .from('trip_cancellations')
              .update({ refund_progress: (batch.refund_progress || 0) + 1 })
              .eq('id', batch.id);
            if (progErr) await db.rpc('inc_trip_cancel_progress', { batch_id: batch.id }).catch(() => {});
            batch.refund_progress = (batch.refund_progress || 0) + 1;
          }
        } catch (e) {
          console.warn('[canceltrip] cancel call failed:', e.message);
        }
      } else {
        // Любой другой статус (например, 'refunded' но банк не подтвердил) при available>0 —
        // на всякий случай НЕ инициируем повторный Cancel.
        // Просто двигаем прогресс, чтобы батч можно было повторить вручную позже.
        const { error: progErr } = await db
          .from('trip_cancellations')
          .update({ refund_progress: (batch.refund_progress || 0) + 1 })
          .eq('id', batch.id);
        if (progErr) await db.rpc('inc_trip_cancel_progress', { batch_id: batch.id }).catch(() => {});
        batch.refund_progress = (batch.refund_progress || 0) + 1;
      }
    }

    // 6) Финализация: всё инициировано? (или total_refunds = 0)
    // NB: перечитываем батч из БД, чтобы учесть возможные параллельные инкременты
    const { data: freshBatch, error: freshErr } = await db
      .from('trip_cancellations')
      .select('id, total_refunds, refund_progress')
      .eq('id', batch.id)
      .single();

    if (freshErr) {
      console.error('[canceltrip] read fresh batch error:', freshErr.message);
      return res.status(500).json({ error: 'DB error (read batch final)' });
    }

    const total = freshBatch?.total_refunds || 0;
    const progressed = freshBatch?.refund_progress || 0;
    const allInitiated = progressed === total;

    if (allInitiated) {
      // Все возвраты УСПЕШНО инициированы или подтверждены как уже REFUNDED.
      // Дальше /api/tbank/cancel на каждом участнике проведёт реальный Cancel.
      // Когда оплаченных не останется, он сам вызовет closeSpDeal и финализирует поездку.
      await db.from('trip_cancellations').update({ status: 'completed' }).eq('id', batch.id);

// === [POST] Финализация после завершения батча ===
// Если подтверждённых оплат больше не осталось — мягко закрываем сделку и архивируем поездку.
// Этот блок покрывает кейс, когда часть платежей уже была REFUNDED (мы лишь учли прогресс),
// и /api/tbank/cancel не вызывался на "последнем" платеже → некому закрыть сделку.
try {
  // 1) Вытащим deal_id для трипа
  const { data: tripRow } = await db
    .from('trips')
    .select('id, deal_id')
    .eq('id', tripId)
    .maybeSingle();

  // 2) Посчитаем "живые" подтверждённые на текущий момент (по последнему платежу каждого участника)
  const { data: allPays, error: paysErr } = await db
    .from('payments')
    .select('participant_id, id, status, created_at, payment_type')
    .eq('trip_id', tripId)
    .eq('payment_type', 'participant_payment')
    .order('created_at', { ascending: false });

  if (!paysErr) {
    const latestByUser = new Map();
    for (const row of allPays || []) {
      if (!latestByUser.has(row.participant_id)) latestByUser.set(row.participant_id, row);
    }
    let stillConfirmed = 0;
    for (const r of latestByUser.values()) {
      if (String(r.status || '').toLowerCase() === 'confirmed') stillConfirmed += 1;
    }

    // 3) Если открытых подтверждённых не осталось — закрываем сделку (если есть) и архивируем поездку
    if (stillConfirmed === 0) {
      // закрыть SP-сделку (мягко, игнорим ошибку)
      try {
        if (tripRow?.deal_id) {
          await closeSpDeal({
            terminalKey: tbankConfig.terminalKeyEacq || tbankConfig.terminalKeyBase,
            dealId: tripRow.deal_id,
          });
        }
      } catch (_) { /* ignore */ }

      // финальный статус поездки и архив чатов
      await db.from('trips').update({ status: 'canceled' }).eq('id', tripId);
      await db
        .from('chats')
        .update({
          chat_type: 'archived',
          support_close_confirmed: true,
          support_close_requested_at: new Date().toISOString(),
        })
        .eq('trip_id', tripId)
        .neq('chat_type', 'archived');

await db
  .from('trip_participants')
  .update({ status: 'canceled' })
  .eq('trip_id', tripId)
  .in('status', ['waiting', 'confirmed']);

    }
  }
} catch (e) {
  console.warn('[canceltrip] post-batch finalize failed (non-fatal):', e.message);
}

      return res.status(200).json({
        success: true,
        batchId: batch.id,
        status: 'completed', // батч завершён (инициация/подтверждение прошли)
        total_refunds: total,
        refund_progress: progressed,
      });
    } else {
      // не всё инициировано/подтверждено → считаем батч неуспешным
      await db.from('trip_cancellations').update({ status: 'cancel_failed' }).eq('id', batch.id);
      await db.from('trips').update({ status: 'cancel_failed' }).eq('id', tripId);

      return res.status(207).json({
        success: false,
        batchId: batch.id,
        status: 'cancel_failed',
        total_refunds: total,
        refund_progress: progressed,
        message: 'Не все возвраты удалось инициировать/подтвердить. Повторите отмену позже.',
      });
    }
  } catch (e) {
    console.error('/api/tbank/canceltrip error:', e);
    return res.status(500).json({ error: e.message });
  }
}
