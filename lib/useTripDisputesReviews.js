// /lib/useTripDisputesReviews.js
import crypto from 'crypto';
import { createTripAlert } from './tripAlerts';

/**
 * Группа функций: коммуникации, отзывы, подтверждения/одобрения, диспуты.
 * Фабрика получает общий контекст из useTripParticipants.
 */
export function useTripDisputesReviews(ctx) {
  const {
    memoizedTripId,
    trip,
    participants,
    setMessage,
    setConfirmModal,
    user,
    setParticipantReviewSent,
    setIndividualReviews,
    individualReviews,
    setBulkReviewSent,
    setReviewModal,
    reviewText,
    rating,
    evidenceFile,
    sendMessage,
    getUserFullName,
    fetchParticipants,
    supabase,
  } = ctx;

  async function notifyTripAlert({ userId, type, title, body, actorUserId = null, metadata = {} }) {
    if (!userId) return;
    try {
      await createTripAlert({
        userId,
        tripId: memoizedTripId,
        type,
        title,
        body,
        actorUserId,
        metadata,
        client: supabase,
      });
    } catch (e) {
      console.error('[useTripDisputesReviews] trip alert failed:', e?.message || e);
    }
  }

  // ============== ВСПОМОГАТЕЛЬНОЕ: поиск/создание чата-диспута ==============
  async function ensureDisputeChat({ tripId, initiatorId, respondentId, disputeId, reasonText }) {
    const { data: disputeChats } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', tripId)
      .eq('chat_type', 'dispute');

    let existingChatId = null;
    if (Array.isArray(disputeChats) && disputeChats.length) {
      const chatIds = disputeChats.map((c) => c.id);
      const { data: parts } = await supabase
        .from('chat_participants')
        .select('chat_id, user_id')
        .in('chat_id', chatIds);

      if (Array.isArray(parts) && parts.length) {
        const byChat = parts.reduce((acc, r) => {
          (acc[r.chat_id] ||= new Set()).add(r.user_id);
          return acc;
        }, {});
        for (const chatId of chatIds) {
          const set = byChat[chatId] || new Set();
          if (set.has(initiatorId) && set.has(respondentId)) {
            existingChatId = chatId;
            break;
          }
        }
      }
    }

    if (existingChatId) return existingChatId;

    const title = `Диспут по поездке: ${trip?.title || ''}`;
    const { data: newChat, error: chatErr } = await supabase
      .from('chats')
      .insert({
        title,
        trip_id: tripId,
        chat_type: 'dispute',
        is_group: true,
        moderator_id: null,
        support_close_requested_at: null,
        support_close_confirmed: null,
      })
      .select('id')
      .single();
    if (chatErr) throw chatErr;

    const chatId = newChat.id;

    const partsInsert = [
      { chat_id: chatId, user_id: initiatorId },
      { chat_id: chatId, user_id: respondentId },
    ];
    const { error: cpErr } = await supabase.from('chat_participants').insert(partsInsert);
    if (cpErr) throw cpErr;

if (reasonText && reasonText.trim()) {
  const { error: msgErr } = await supabase.from('chat_messages').insert({
  chat_id: chatId,
  user_id: initiatorId,
  content: `Открыт спор: ${reasonText.trim()}`,
});
  if (msgErr) throw msgErr;
}

    return chatId;
  }

  // ========================== Сообщение организатору ==========================
  async function handleSendMessage() {
    try {
      await sendMessage(trip?.creator_id, reviewText);
      setMessage('Сообщение отправлено');
      setReviewModal({ open: false, organizerId: null });
    } catch (error) {
      console.error('Ошибка отправки сообщения:', {
        error: error.message,
        tripId: memoizedTripId,
      });
      setMessage('Ошибка отправки сообщения');
    }
  }

  // ================================ Отзывы ================================
  /**
   * Может вызываться как:
   *  - handleSubmitReview(participantId, isBulk)
   *  - handleSubmitReview({ participantId, isBulk })
   */
  async function handleSubmitReview(arg1, arg2) {
    // Унификация сигнатуры
    let participantId = null;
    let isBulk = false;
    if (typeof arg1 === 'object' && arg1 !== null) {
      participantId = arg1.participantId ?? null;
      isBulk = !!arg1.isBulk;
    } else {
      participantId = arg1 ?? null;
      isBulk = !!arg2;
    }

    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      if (!reviewText || !rating) {
        setMessage('Введите текст отзыва и оценку');
        return;
      }

      const isOrganizerAuthor =
        user?.id && trip?.creator_id && user.id === trip.creator_id;
      const list = Array.isArray(participants) ? participants : [];

      if (isOrganizerAuthor) {
        // ======= ОРГАНИЗАТОР → УЧАСТНИКИ: всегда пишем в reviews =======
        const table = 'reviews';

        if (isBulk) {
          // Массово всем, кроме уже оценённых индивидуально
          const participantsToReview = list.filter(
            (p) => !individualReviews.has(p.user_id)
          );

          for (const p of participantsToReview) {
            // защита от дублей (на всякий случай)
            const { data: dup } = await supabase
              .from(table)
              .select('id')
              .eq('trip_id', memoizedTripId)
              .eq('reviewer_id', user.id)
              .eq('organizer_id', p.user_id)
              .limit(1);

            if (Array.isArray(dup) && dup.length) continue;

            const { error } = await supabase.from(table).insert({
              trip_id: memoizedTripId,
              reviewer_id: user.id, // организатор пишет
              organizer_id: p.user_id, // про КОГО отзыв — участник
              rating,
              text: reviewText,
              created_at: new Date().toISOString(),
            });
            if (error) throw error;

            await notifyTripAlert({
              userId: p.user_id,
              type: 'trip_review_received',
              title: 'Вам оставили отзыв',
              body: `Организатор оставил вам отзыв по поездке «${trip?.title || ''}».`,
              actorUserId: user.id,
              metadata: { tripTitle: trip?.title || null },
            });
          }

          setBulkReviewSent(true);
          setMessage('Отзывы отправлены всем участникам');
        } else {
          // Индивидуально по строке участника
          if (!participantId) {
            setMessage('Не выбран участник для отзыва');
            return;
          }

          const target = list.find(
            (p) => p.id === participantId || p.user_id === participantId
          );
          if (!target) {
            setMessage('Участник не найден');
            return;
          }

          // защита от дубля
          const { data: dup } = await supabase
            .from(table)
            .select('id')
            .eq('trip_id', memoizedTripId)
            .eq('reviewer_id', user.id)
            .eq('organizer_id', target.user_id)
            .limit(1);

          if (Array.isArray(dup) && dup.length) {
            setMessage('Отзыв этому участнику уже оставлен.');
            return;
          }

          const { error } = await supabase.from(table).insert({
            trip_id: memoizedTripId,
            reviewer_id: user.id, // организатор пишет
            organizer_id: target.user_id, // про участника
            rating,
            text: reviewText,
            created_at: new Date().toISOString(),
          });
          if (error) throw error;

          await notifyTripAlert({
            userId: target.user_id,
            type: 'trip_review_received',
            title: 'Вам оставили отзыв',
            body: `Организатор оставил вам отзыв по поездке «${trip?.title || ''}».`,
            actorUserId: user.id,
            metadata: { tripTitle: trip?.title || null },
          });

          // запоминаем, что конкретному участнику уже поставили
          setIndividualReviews(
            new Set([...individualReviews, target.user_id])
          );
          setMessage('Отзыв отправлен');
        }
      } else {
        // ======= УЧАСТНИК → ОРГАНИЗАТОР =======
        const table = trip?.is_company_trip ? 'company_reviews' : 'reviews';

        // защита от дубля
        const { data: already } = await supabase
          .from(table)
          .select('id')
          .eq('trip_id', memoizedTripId)
          .eq('reviewer_id', user.id)
          .eq('organizer_id', trip?.creator_id)
          .limit(1);

        if (Array.isArray(already) && already.length) {
          setMessage('Отзыв уже оставлен вами для данной поездки.');
          return;
        }

        const { error } = await supabase.from(table).insert({
          trip_id: memoizedTripId,
          reviewer_id: user.id, // участник пишет
          organizer_id: trip?.creator_id, // про организатора/компанию
          rating,
          text: reviewText,
          created_at: new Date().toISOString(),
        });
        if (error) throw error;

        await notifyTripAlert({
          userId: trip?.creator_id,
          type: 'trip_review_left_by_participant',
          title: 'Участник оставил отзыв',
          body: `Участник оставил отзыв о поездке «${trip?.title || ''}».`,
          actorUserId: user.id,
          metadata: { tripTitle: trip?.title || null },
        });

        setParticipantReviewSent(true);
        setMessage('Отзыв отправлен');
      }

      // Общие завершающие действия
      setReviewModal({
        open: false,
        organizerId: null,
        participantId: null,
        isBulk: false,
      });

      await fetchParticipants();
    } catch (error) {
      console.error('Ошибка при отправке отзыва:', {
        error: error.message,
        participantId,
        isBulk,
      });
      setMessage('Ошибка отправки отзыва');
    }
  }

  // ================================ Присутствие ================================
  async function handleConfirmPresence(participantId) {
    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      const { error } = await supabase
        .from('trip_participants')
        .update({ confirmed_start: true })
        .eq('id', participantId);
      if (error) throw error;

      setMessage('Присутствие подтверждено');
      await fetchParticipants();

      const fullName = await getUserFullName(user.id);
      await notifyTripAlert({
        userId: trip?.creator_id,
        type: 'trip_presence_confirmed',
        title: 'Участник подтвердил присутствие',
        body: `Участник ${fullName} подтвердил присутствие в поездке «${trip?.title || ''}».`,
        actorUserId: user.id,
        metadata: { tripTitle: trip?.title || null },
      });
    } catch (error) {
      console.error('Ошибка при подтверждении присутствия:', {
        error: error.message,
        participantId,
      });
      setMessage('Ошибка подтверждения присутствия');
    }
  }

  // ================================ Одобрение ================================
  async function handleApproveTrip(participantId, approved) {
    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      const { error } = await supabase
        .from('trip_participants')
        .update({ approved_trip: approved })
        .eq('id', participantId);
      if (error) throw error;

      setMessage(approved ? 'Поездка одобрена' : 'Поездка не одобрена');
      await fetchParticipants();

      const fullName = await getUserFullName(user.id);
      await notifyTripAlert({
        userId: trip?.creator_id,
        type: approved ? 'trip_approved_by_participant' : 'trip_not_approved_by_participant',
        title: approved ? 'Поездка одобрена участником' : 'Поездка не одобрена участником',
        body: `Участник ${fullName} ${approved ? 'одобрил' : 'не одобрил'} поездку «${trip?.title || ''}».`,
        actorUserId: user.id,
        metadata: { tripTitle: trip?.title || null, approved: !!approved },
      });
    } catch (error) {
      console.error('Ошибка при одобрении поездки:', {
        error: error.message,
        participantId,
      });
      setMessage('Ошибка обновления статуса поездки');
    }
  }

  // ================================ СПОР: открыть ================================
  async function handleOpenDispute(participantRowId, disputeReason) {
    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться для открытия спора');
        return;
      }
      const participant = (participants || []).find(
        (p) => p.id == participantRowId
      );
      if (!participant) {
        setMessage('Участник не найден');
        return;
      }

      const { data: existing, error: checkErr } = await supabase
        .from('disputes')
        .select('id, status')
        .eq('trip_id', memoizedTripId)
        .eq('initiator_id', participant.user_id)
        .limit(1);

      if (checkErr) {
        console.error('Ошибка проверки существующего спора:', {
          error: checkErr.message,
          code: checkErr.code,
        });
        throw checkErr;
      }
      if (Array.isArray(existing) && existing.length) {
        setMessage('Спор уже открыт');
        return existing[0].id;
      }

      const { data: dispute, error: disputeErr } = await supabase
        .from('disputes')
        .insert({
          trip_id: memoizedTripId,
          initiator_id: participant.user_id,
          respondent_id: trip?.creator_id,
          reason: disputeReason,
          status: 'awaiting_moderator',
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (disputeErr) throw disputeErr;

      await ensureDisputeChat({
        tripId: memoizedTripId,
        initiatorId: participant.user_id,
        respondentId: trip?.creator_id,
        disputeId: dispute.id,
        reasonText: disputeReason,
      });

      await notifyTripAlert({
        userId: trip?.creator_id,
        type: 'trip_dispute_opened',
        title: 'Открыт спор по поездке',
        body: `Участник ${await getUserFullName(participant.user_id)} открыл спор по поездке «${trip?.title || ''}». Проверьте вкладку «Поддержка».`,
        actorUserId: participant.user_id,
        metadata: { tripTitle: trip?.title || null, disputeId: dispute.id },
      });

      setMessage('Спор открыт. Чат доступен во вкладке «Поддержка».');
      return dispute.id;
    } catch (error) {
      console.error('Ошибка при открытии спора:', {
        error: error.message,
        participantRowId,
      });
      setMessage('Ошибка открытия спора');
    }
  }

  // ================================ СПОР: загрузка доказательства ================================
  async function handleUploadEvidence(disputeId, fileArg) {
    try {
      if (!user) {
        setMessage('Ошибка: Необходимо авторизоваться');
        return;
      }
      const file = fileArg || evidenceFile;
      if (!file || !disputeId) {
        setMessage('Выберите файл и спор');
        return;
      }

      const fileExt = file.name.split('.').pop();
      const fileName = `${crypto.randomUUID()}.${fileExt}`;
      const filePath = `disputes/${disputeId}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('evidence')
        .upload(filePath, file);
      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from('evidence')
        .getPublicUrl(filePath);

      const { error: insertError } = await supabase
        .from('dispute_evidences')
        .insert([
          {
            dispute_id: disputeId,
            file_url: publicUrlData.publicUrl,
            uploaded_by: user.id,
            created_at: new Date().toISOString(),
          },
        ]);
      if (insertError) throw insertError;

      setMessage('Доказательство загружено');
    } catch (error) {
      console.error('Ошибка при загрузке доказательства:', {
        error: error.message,
        disputeId,
      });
      setMessage('Ошибка загрузки доказательства');
    }
  }

  return {
    handleSendMessage,
    handleSubmitReview,
    handleConfirmPresence,
    handleApproveTrip,
    handleOpenDispute,
    handleUploadEvidence,
  };
}

export default useTripDisputesReviews;
