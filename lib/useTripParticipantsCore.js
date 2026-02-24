import { useState, useMemo } from 'react';
import { notifications } from '../pages/_app';
import crypto from 'crypto';

// Генерация токена для аутентификации
const generateToken = (params, secret) => {
  console.log('Генерация токена:', { params });
  try {
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((obj, key) => {
        if (key !== 'Token' && key !== 'DigestValue' && key !== 'SignatureValue' && key !== 'X509SerialNumber') {
          obj[key] = String(params[key]);
        }
        return obj;
      }, {});
    sortedParams['Password'] = secret;
    const concatenated = Object.values(sortedParams).join('');
    const token = crypto.createHash('sha256').update(concatenated).digest('hex');
    console.log('Токен сгенерирован успешно:', { token });
    return token;
  } catch (error) {
    console.error('Ошибка при генерации токена:', { error: error.message });
    throw error;
  }
};

// Основной хук для управления состоянием
export const useTripParticipantsCore = (tripId, supabase) => {
  // Состояния
  const [trip, setTrip] = useState(null);
  const [participants, setParticipants] = useState(null);
  const [message, setMessage] = useState('');
  const [actionDropdown, setActionDropdown] = useState({ open: false, participantId: null, buttonRef: null });
  const [reviewModal, setReviewModal] = useState({ open: false, organizerId: null, participantId: null, isBulk: false });
  const [reviewText, setReviewText] = useState('');
  const [rating, setRating] = useState(0);
  const [messageModal, setMessageModal] = useState({ open: false, organizerId: null });
  const [newMessage, setNewMessage] = useState('');
  const [user, setUser] = useState(null);
  const [confirmModal, setConfirmModal] = useState({ open: false, action: null, participantId: null, confirmMessage: '' });
  const [individualReviews, setIndividualReviews] = useState(new Set());
  const [bulkReviewSent, setBulkReviewSent] = useState(null);
  const [participantReviewSent, setParticipantReviewSent] = useState(false);
  const [evidenceFile, setEvidenceFile] = useState(null);
  const [participantId, setParticipantId] = useState(null);
  const [participantStatus, setParticipantStatus] = useState(null);
  const [isCreator, setIsCreator] = useState(false);

  // Мемоизация tripId
  const memoizedTripId = useMemo(() => tripId, [tripId]);

  // Расчёт возврата
  async function calculateRefund(trip, participantId = null) {
    try {
      console.log('Расчёт возврата:', { tripId: memoizedTripId, participantId });
      const now = new Date();
      const startDate = new Date(trip?.start_date);
      const hoursUntilStart = (startDate - now) / (1000 * 60 * 60);

      const refundPolicy = trip?.refund_policy || { type: 'standard', timezone: 'UTC+5', full_refunded_hours: 1, partial_refunded_hours: 0, partial_refunded_percent: 0 };
      let refundPercentage = 0;
      let refundMessage = '';

      if (refundPolicy.type === 'standard') {
        if (hoursUntilStart >= refundPolicy.full_refunded_hours) {
          refundPercentage = 100;
          refundMessage = `Если у Вас была оплата то, по правилам возврата, с которыми вы согласились, за ${Math.round(hoursUntilStart)} часов до начала поездки вам будет возвращено 100% средств.`;
        } else {
          refundPercentage = 0;
          refundMessage = `Если у Вас была оплата то, по правилам возврата, с которыми вы согласились, за ${Math.round(hoursUntilStart)} часов до начала поездки возврат средств не предусмотрен.`;
        }
      } else if (refundPolicy.type === 'custom') {
        if (hoursUntilStart >= refundPolicy.full_refunded_hours) {
          refundPercentage = 100;
          refundMessage = `Если у Вас была оплата то, по правилам возврата, с которыми вы согласились, за ${Math.round(hoursUntilStart)} часов до начала поездки вам будет возвращено 100% средств.`;
        } else if (hoursUntilStart >= refundPolicy.partial_refunded_hours) {
          refundPercentage = refundPolicy.partial_refunded_percent || 0;
          refundMessage = `Если у Вас была оплата то, по правилам возврата, с которыми вы согласились, за ${Math.round(hoursUntilStart)} часов до начала поездки вам будет возвращено ${refundPercentage}% средств.`;
        } else {
          refundPercentage = 0;
          refundMessage = `Если у Вас была оплата то, по правилам возврата, с которыми вы согласились, за ${Math.round(hoursUntilStart)} часов до начала поездки возврат средств не предусмотрен.`;
        }
      }

      const refundAmount = (refundPercentage / 100) * trip?.price;
      console.log('Возврат рассчитан:', { refundAmount, refundPercentage, refundMessage });
      return { refundAmount, refundMessage };
    } catch (error) {
      console.error('Ошибка расчёта возврата:', { error: error.message, tripId: memoizedTripId });
      return { refundAmount: 0, refundMessage: 'Ошибка расчёта возврата' };
    }
  }

  // Получение полного имени пользователя
  async function getUserFullName(userId) {
    try {
      console.log('Запрос полного имени пользователя:', { userId });
      const { data: userProfile, error } = await supabase
        .from('profiles')
        .select('first_name, last_name, patronymic')
        .eq('user_id', userId)
        .single();
      if (error) {
        console.error('Ошибка получения профиля:', { error: error.message });
        throw error;
      }
      const fullName = userProfile
        ? [userProfile.last_name, userProfile.first_name, userProfile.patronymic].filter(Boolean).join(' ') || 'Неизвестный пользователь'
        : 'Неизвестный пользователь';
      console.log('Полное имя:', { fullName });
      return fullName;
    } catch (error) {
      console.error('Ошибка при получении имени:', { error: error.message, userId });
      return 'Неизвестный пользователь';
    }
  }

async function getChatId(organizerId, participantId, _isDispute = false, _disputeId = null) {
    try {
      console.log('Запрос ID ЛС чата (trip_private):', { organizerId, participantId, tripId: memoizedTripId });

      if (!organizerId || !participantId || !memoizedTripId) {
        throw new Error('Недостаточно данных для получения чата');
      }

      // 1) Ищем пересечение chat_participants по обоим пользователям
      const [{ data: a, error: errA }, { data: b, error: errB }] = await Promise.all([
        supabase.from('chat_participants').select('chat_id').eq('user_id', organizerId),
        supabase.from('chat_participants').select('chat_id').eq('user_id', participantId),
      ]);
      if (errA) throw errA;
      if (errB) throw errB;

      const setA = new Set((a || []).map(r => r.chat_id));
      const shared = (b || []).map(r => r.chat_id).filter(id => setA.has(id));

      if (shared.length) {
        // Берём все чаты по пересечению и уже тут:
        //  - отбрасываем групповые
        //  - учитываем, что архивные ЛС имеют chat_type='archived'
        const { data: existing, error: errChats } = await supabase
          .from('chats')
          .select('id, chat_type, is_group, created_at')
          .in('id', shared)
          .eq('trip_id', memoizedTripId)
          .order('created_at', { ascending: true });

        if (errChats) throw errChats;

        if (Array.isArray(existing) && existing.length) {
          // 1) Сначала пробуем найти ЛС (is_group=false), даже если он уже archived
          const privateChat = existing.find(
            c =>
              !c.is_group &&
              (c.chat_type === 'trip_private' || c.chat_type === 'archived')
          );

          if (privateChat) {
            console.log('Найден существующий ЛС чат (в т.ч. archived):', {
              chatId: privateChat.id,
              chat_type: privateChat.chat_type,
            });
            return privateChat.id;
          }

          // 2) Если есть пересечение только по групповым чатам,
          //    и при этом поездка уже в архиве — новые ЛС не создаём
          const tripStatus = (trip?.status || '').toLowerCase();
          if (tripStatus === 'archived') {
            console.log(
              'Поездка в архиве, общий чат есть, но ЛС не было — новые ЛС не создаём.'
            );
            setMessage(
              'Переписка по этой поездке завершена и перенесена в архив. Для завершённых поездок новые личные сообщения недоступны.'
            );
            return null;
          }
        }
      }

      // 2) Если общих ЛС нет и поездка в архиве — не создаём новый чат
      const tripStatus = (trip?.status || '').toLowerCase();
      if (tripStatus === 'archived') {
        console.log(
          'Поездка в архиве и общих ЛС нет — не создаём новый частный чат.'
        );
        setMessage(
          'Переписка по этой поездке завершена и перенесена в архив. Для завершённых поездок новые личные сообщения недоступны.'
        );
        return null;
      }

      // 3) Если нет — создаём новый чат trip_private и добавляем обоих в chat_participants
      const title = `ЛС по поездке: ${trip?.title || ''}`;
      const { data: newChat, error: chatErr } = await supabase
        .from('chats')
        .insert({
          title,
          trip_id: memoizedTripId,
          chat_type: 'trip_private',
          is_group: false,
          moderator_id: null,
        })
        .select('id')
        .single();
      if (chatErr) throw chatErr;

      const chatId = newChat.id;

      const { error: partsErr } = await supabase
        .from('chat_participants')
        .insert([
          { chat_id: chatId, user_id: organizerId },
          { chat_id: chatId, user_id: participantId },
        ]);
      if (partsErr) throw partsErr;

      console.log('Создан новый ЛС чат и добавлены участники:', { chatId });
      return chatId;
    } catch (error) {
      console.error('Ошибка при получении/создании ЛС чата:', {
        error: error.message,
        tripId: memoizedTripId,
      });
      throw error;
    }
  }

  // Отправка одного сообщения в чат
  async function sendChatMessage(chatId, content) {
    try {
      if (!chatId) {
        console.warn('sendChatMessage: пустой chatId, сообщение не отправлено', { content });
        return;
      }
      console.log('Отправка сообщения в чат:', { chatId });
      const { error } = await supabase
        .from('chat_messages')
.insert({
  chat_id: chatId,
  user_id: user?.id,
  content,
});
      if (error) {
        console.error('Ошибка отправки сообщения:', { error: error.message });
        throw error;
      }
      // обновим unread локально, если используется глобальный менеджер
      console.log('Сообщение отправлено:', { chatId });
    } catch (error) {
      console.error('Ошибка при отправке сообщения:', { error: error.message, chatId });
      throw error;
    }
  }

    // Отправка сообщения (ЛС организатор ↔ участник) — всегда trip_private
  async function sendMessage(recipientId, content, isDispute = false, disputeId = null) {
    if (!user?.id || !recipientId || !memoizedTripId) {
      console.warn('Неверные параметры для отправки сообщения:', {
        userId: user?.id,
        recipientId,
        tripId: memoizedTripId,
      });
      setMessage('Ошибка: Недостаточно данных для отправки сообщения');
      return;
    }
    try {
      console.log('Отправка сообщения (trip_private):', {
        recipientId,
        isDisputeIgnored: isDispute,
        disputeIdIgnored: disputeId,
      });

      const organizerId = trip?.creator_id;
      // участник чата: тот, кто не организатор
      const dmParticipantId = user.id === organizerId ? recipientId : user.id;

      const chatId = await getChatId(
        organizerId,
        dmParticipantId /*, isDispute, disputeId*/
      );

      // Если getChatId вернул null (например, поездка в архиве и ЛС ещё не было) —
      // просто выходим: пользователю уже показали понятное сообщение через setMessage.
      if (!chatId) {
        console.log('ЛС чат не получен (поездка могла быть в архиве) — сообщение не отправляем.');
        return;
      }

      await sendChatMessage(chatId, content);
      console.log('Сообщение отправлено:', { recipientId, chatId });
    } catch (error) {
      console.error('Ошибка при отправке сообщения:', {
        error: error.message,
        recipientId,
        tripId: memoizedTripId,
      });
      setMessage('Ошибка отправки сообщения');
    }
  }


  // Расчёт возраста
  function calculateAge(birthDate) {
    try {
      console.log('Расчёт возраста:', { birthDate });
      if (!birthDate) return 'Не указан';
      const today = new Date();
      const birth = new Date(birthDate);
      let age = today.getFullYear() - birth.getFullYear();
      const monthDiff = today.getMonth() - birth.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--;
      console.log('Возраст рассчитан:', { age });
      return `${age} лет`;
    } catch (error) {
      console.error('Ошибка расчёта возраста:', { error: error.message });
      return 'Не указан';
    }
  }

  // Формирование полного имени участника
  function getFullName(participant) {
    try {
      console.log('Формирование полного имени:', { participantId: participant?.id });
      if (!participant) return 'Не указано';
      const parts = [participant.last_name, participant.first_name, participant.patronymic].filter(Boolean);
      const fullName = parts.length > 0 ? parts.join(' ') : 'Не указано';
      console.log('Полное имя:', { fullName });
      return fullName;
    } catch (error) {
      console.error('Ошибка формирования имени:', { error: error.message });
      return 'Не указано';
    }
  }

  return {
    trip,
    setTrip,
    participants,
    setParticipants,
    message,
    setMessage,
    actionDropdown,
    setActionDropdown,
    reviewModal,
    setReviewModal,
    reviewText,
    setReviewText,
    rating,
    setRating,
    messageModal,
    setMessageModal,
    newMessage,
    setNewMessage,
    user,
    setUser,
    confirmModal,
    setConfirmModal,
    individualReviews,
    setIndividualReviews,
    bulkReviewSent,
    setBulkReviewSent,
    participantReviewSent,
    setParticipantReviewSent,
    evidenceFile,
    setEvidenceFile,
    participantId,
    setParticipantId,
    participantStatus,
    setParticipantStatus,
    isCreator,
    setIsCreator,
    memoizedTripId,
    generateToken,
    calculateRefund,
    getUserFullName,
    getChatId,
    sendChatMessage,
    sendMessage,
    calculateAge,
    getFullName,
  };
};
