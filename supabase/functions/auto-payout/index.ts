// @ts-nocheck
// Supabase Edge Function: auto-payout
// Вызывается pg_cron, проверяет expired finished trips, обновляет payout_completed и payout_at, закрывает поездку
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async (req)=>{
  try {
    console.log('Запуск auto-payout:', {
      timestamp: new Date().toISOString()
    });
    // Инициализация Supabase клиента
    console.time('Supabase init');
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    console.timeEnd('Supabase init');
    const now = new Date().toISOString();
    console.log('Текущее время:', {
      now
    });
    // Шаг 1: Находим finished поездки с истёкшим периодом споров, не closed
    console.time('Fetch expired trips');
    const { data: expiredTrips, error: tripsError } = await supabase.from('trips').select('id, creator_id, deal_id').eq('status', 'finished').neq('status', 'closed').lt('dispute_period_ends_at', now);
    console.timeEnd('Fetch expired trips');
    if (tripsError) {
      console.error('Ошибка получения expired trips:', tripsError);
      return new Response(`Error fetching trips: ${tripsError.message}`, {
        status: 500
      });
    }
    console.log('Найдено expired trips:', {
      count: expiredTrips?.length || 0
    });
    if (!expiredTrips || expiredTrips.length === 0) {
      return new Response('No expired trips to process', {
        status: 200
      });
    }
    // Шаг 2: Параллельная обработка поездок
    const tripPromises = expiredTrips.map(async (trip)=>{
      const tripId = trip.id;
      console.log('Обработка поездки:', {
        tripId
      });
      // Получаем телефон создателя поездки из таблицы profiles
      console.time(`Fetch creator phone for ${tripId}`);
      const { data: creatorData, error: creatorError } = await supabase.from('profiles').select('phone').eq('user_id', trip.creator_id).single();
      console.timeEnd(`Fetch creator phone for ${tripId}`);
      if (creatorError || !creatorData || !creatorData.phone) {
        console.error(`Ошибка получения телефона создателя для trip ${tripId}:`, creatorError?.message || 'Нет данных');
        return;
      }
      const creatorPhone = creatorData.phone;
      // Находим paid участников без одобрения (approved_trip is null or != true)
      console.time(`Fetch participants for ${tripId}`);
      const { data: participants, error: partsError } = await supabase.from('trip_participants').select('id, user_id').eq('trip_id', tripId).eq('status', 'paid').or('approved_trip.is.null, approved_trip.neq.true');
      console.timeEnd(`Fetch participants for ${tripId}`);
      if (partsError) {
        console.error(`Ошибка получения участников для trip ${tripId}:`, partsError);
        return;
      }
      console.log('Найдено участников:', {
        tripId,
        count: participants?.length || 0
      });
      // Параллельная обработка участников (даже если 0, продолжаем к шагу 7)
      const participantPromises = participants.map(async (participant)=>{
        console.log('Обработка участника:', {
          tripId,
          userId: participant.user_id
        });
        // Проверка спора
        console.time(`Check dispute for ${tripId}-${participant.user_id}`);
        const { data: disputeData, error: disputeError } = await supabase.from('disputes').select('id').eq('trip_id', tripId).eq('initiator_id', participant.user_id).eq('status', 'pending').single();
        console.timeEnd(`Check dispute for ${tripId}-${participant.user_id}`);
        if (disputeError && disputeError.code !== 'PGRST116') {
          console.error(`Ошибка проверки спора для participant ${participant.user_id}:`, disputeError);
          return;
        }
        if (disputeData) {
          console.log(`Пропуск выплаты для ${participant.user_id}: есть спор`);
          return;
        }
        // Получение платежа
        console.time(`Fetch payment for ${tripId}-${participant.user_id}`);
        const { data: paymentData, error: paymentError } = await supabase.from('payments').select('id, amount').eq('trip_id', tripId).eq('participant_id', participant.user_id).eq('status', 'confirmed').eq('payment_type', 'participant_payment').single();
        console.timeEnd(`Fetch payment for ${tripId}-${participant.user_id}`);
        if (paymentError || !paymentData || paymentData.amount <= 0) {
          console.error(`Ошибка или нет платежа для participant ${participant.user_id}:`, paymentError?.message);
          return;
        }
        // Проверка, не выплачено ли уже
        console.time(`Check payout completed for ${tripId}-${participant.user_id}`);
        const { data: paymentCheck } = await supabase.from('payments').select('id').eq('id', paymentData.id).eq('payout_completed', true).single();
        console.timeEnd(`Check payout completed for ${tripId}-${participant.user_id}`);
        if (paymentCheck) {
          console.log(`Выплата уже сделана для participant ${participant.user_id}`);
          return;
        }
        // Шаг 3.5: Проверка существующих попыток выплат для этого платежа/участника
        console.time(`Check payout attempts for ${tripId}-${participant.user_id}`);
        const { data: attemptsData, error: attemptsError } = await supabase.from('payout_attempts').select('*').eq('trip_id', tripId).eq('participant_id', participant.id).order('created_at', {
          ascending: false
        }).limit(1); // Последняя попытка
        console.timeEnd(`Check payout attempts for ${tripId}-${participant.user_id}`);
        if (attemptsError) {
          console.error(`Ошибка проверки попыток для ${tripId}:`, attemptsError);
          return;
        }
        let attemptId;
        let currentAttempt = attemptsData?.[0];
        if (currentAttempt && currentAttempt.status === 'completed') {
          console.log(`Выплата уже завершена для ${participant.user_id}`);
          return;
        }
        // Если есть failed попытка, инкрементируем count, иначе создаём новую
        if (currentAttempt && currentAttempt.status === 'failed') {
          attemptId = currentAttempt.id;
          const newCount = currentAttempt.attempt_count + 1;
          await supabase.from('payout_attempts').update({
            status: 'pending',
            attempt_count: newCount,
            last_attempt_at: new Date().toISOString(),
            error_message: null
          }).eq('id', attemptId);
        } else {
          // Создаём новую попытку
          const { data: newAttempt, error: createError } = await supabase.from('payout_attempts').insert({
            trip_id: tripId,
            participant_id: participant.id,
            status: 'pending',
            attempt_count: 1,
            last_attempt_at: new Date().toISOString(),
            amount: paymentData.amount * 100,
          }).select('id').single();
          if (createError) {
            console.error(`Ошибка создания попытки для ${tripId}:`, createError);
            return;
          }
          attemptId = newAttempt.id;
        }
        // Шаг 4: Генерация orderId
        console.time(`Generate orderId for ${tripId}-${participant.user_id}`);
        const rawOrderId = `${tripId}-${participant.id}-auto-payout-${Date.now()}`;
        const encoder = new TextEncoder();
        const hashInput = encoder.encode(rawOrderId);
        const hashBuffer = await crypto.subtle.digest('SHA-256', hashInput);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const orderId = hashArray.map((b)=>b.toString(16).padStart(2, '0')).join('').slice(0, 50);
        console.timeEnd(`Generate orderId for ${tripId}-${participant.user_id}`);
        // Шаг 5: Выплата через Tbank API
        console.time(`Tbank payout for ${tripId}-${participant.user_id}`);
        try {
          const response = await fetch(`${Deno.env.get('BASE_URL')}/api/tbank/payout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-payout-secret': Deno.env.get('API_SECRET')
            },
            body: JSON.stringify({
              tripId,
              amount: paymentData.amount,
              dealId: trip.deal_id,
              recipientId: `+${creatorPhone}`,
              orderId
            })
          });
          if (!response.ok) {
            throw new Error(await response.text());
          }
          const tbankResponse = await response.json();
          if (!tbankResponse.success) {
            throw new Error(tbankResponse.error || 'Неизвестная ошибка');
          }
          // Успех: Обновляем попытку на completed
          await supabase.from('payout_attempts').update({
            status: 'completed',
            last_attempt_at: new Date().toISOString(),
            error_message: null,
            payment_id: tbankResponse.paymentId
          }).eq('id', attemptId);
          // Шаг 6: Обновление платежа
          console.time(`Update payment for ${tripId}-${participant.user_id}`);
          const { error: updateError } = await supabase.from('payments').update({
            payout_completed: true,
            payout_at: new Date().toISOString()
          }).eq('id', paymentData.id);
          console.timeEnd(`Update payment for ${tripId}-${participant.user_id}`);
          if (updateError) {
            console.error(`Ошибка обновления выплаты для trip ${tripId}:`, updateError);
            // Revert auto approve if update failed
            console.time(`Revert approve for ${tripId}-${participant.user_id}`);
            const { error: revertError } = await supabase.from('trip_participants').update({
              approved_trip: null
            }).eq('id', participant.id);
            console.timeEnd(`Revert approve for ${tripId}-${participant.user_id}`);
            if (revertError) {
              console.error(`Ошибка отмены одобрения для participant ${participant.user_id}:`, revertError);
            } else {
              console.log(`Одобрение отменено для participant ${participant.user_id} из-за ошибки обновления платежа`);
            }
            return;
          }
          // Автоматическое одобрение после успешной выплаты
          console.time(`Auto approve participant for ${tripId}-${participant.user_id}`);
          const { error: approveError } = await supabase.from('trip_participants').update({
            approved_trip: true
          }).eq('id', participant.id);
          console.timeEnd(`Auto approve participant for ${tripId}-${participant.user_id}`);
          if (approveError) {
            console.error(`Ошибка автоматического одобрения после выплаты для participant ${participant.user_id}:`, approveError);
          } else {
            console.log(`Участник ${participant.user_id} автоматически одобрен после выплаты для trip ${tripId}`);
          }
          // Уведомление организатору
          console.time(`Insert message for ${tripId}-${participant.user_id}`);
          await supabase.from('messages').insert({
            recipient_id: trip.creator_id,
            content: `Автоматическая выплата ${paymentData.amount} за участника ${participant.user_id} для поездки ${tripId}`,
            created_at: new Date().toISOString()
          });
          console.timeEnd(`Insert message for ${tripId}-${participant.user_id}`);
          console.log(`Выплата успешна для trip ${tripId}, participant ${participant.user_id}, amount: ${paymentData.amount}`);
        } catch (error) {
          console.error(`Ошибка Tbank API для trip ${tripId}, participant ${participant.user_id}:`, error.message);
          // Ошибка: Обновляем попытку на failed
          await supabase.from('payout_attempts').update({
            status: 'failed',
            error_message: error.message,
            last_attempt_at: new Date().toISOString()
          }).eq('id', attemptId);
          // Revert auto approve if payout failed
          console.time(`Revert approve for ${tripId}-${participant.user_id}`);
          const { error: revertError } = await supabase.from('trip_participants').update({
            approved_trip: null // or false, depending on initial state
          }).eq('id', participant.id);
          console.timeEnd(`Revert approve for ${tripId}-${participant.user_id}`);
          if (revertError) {
            console.error(`Ошибка отмены одобрения для participant ${participant.user_id}:`, revertError);
          } else {
            console.log(`Одобрение отменено для participant ${participant.user_id} из-за ошибки выплаты`);
          }
          return;
        }
        console.timeEnd(`Tbank payout for ${tripId}-${participant.user_id}`);
      });
      await Promise.all(participantPromises);
      // Шаг 7: Проверка завершения всех выплат (всегда, даже если 0 участников для обработки)
      console.time(`Fetch updated payments for ${tripId}`);
      const { data: updatedPayments, error: updatedPaymentsError } = await supabase.from('payments').select('id, payout_completed').eq('trip_id', tripId).eq('payment_type', 'participant_payment');
      console.timeEnd(`Fetch updated payments for ${tripId}`);
      if (updatedPaymentsError) {
        console.error(`Ошибка проверки платежей после обработки для trip ${tripId}:`, updatedPaymentsError);
        return;
      }
      const allPaid = updatedPayments.every((p)=>p.payout_completed === true);
      if (allPaid) {
        console.time(`Update trip status for ${tripId}`);
        const { error: tripUpdateError } = await supabase.from('trips').update({
          status: 'closed'
        }).eq('id', tripId);
        console.timeEnd(`Update trip status for ${tripId}`);
        if (tripUpdateError) {
          console.error(`Ошибка закрытия поездки ${tripId}:`, tripUpdateError);
          return;
        }
        console.log(`Поездка ${tripId} закрыта`);
      } else {
        console.log(`Поездка ${tripId} не закрыта: не все платежи выплачены`);
      }
    });
    await Promise.all(tripPromises);
    return new Response('Auto payouts processed', {
      status: 200
    });
  } catch (error) {
    console.error('Критическая ошибка в auto-payout:', error);
    return new Response(`Error: ${error.message}`, {
      status: 500
    });
  }
});
