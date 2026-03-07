// pages/admin/AdminDisputesPage.js
import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../_app';
import styles from '../../styles/admin-disputes.module.css';

// UI переписки
import ChatHeader from '../../features/messages/desktop/ChatHeader';
import MessageList from '../../features/messages/desktop/MessageList';
import MessageComposer from '../../features/messages/desktop/MessageComposer';
import { useMessagesRealtime } from '../../features/messages/hooks/useMessagesRealtime';
import { renderChatTitle } from '../../features/messages/utils/chatUtils';

// Общие стили чатов
import commonStyles from '../../styles/messages-common.module.css';
import desktopStyles from '../../styles/messages-desktop.module.css';
const msgStyles = { ...commonStyles, ...desktopStyles };

// Загрузка/отправка вложений
import { useChatAttachments } from '../../hooks/useChatAttachments';

// Комиссии платформы/банка
import { platformSettings } from '../../lib/platformSettings';
import { calculateNetAmountAfterFees } from '../../lib/tbankFees';

const pct = (v) => Number.isFinite(v) ? v : 0;

function resolveFeeRules(snapshot = {}) {
  return {
    platformPercent: pct(snapshot?.platformPercent ?? platformSettings?.platformFeePercent),
    tbankCardPercent: pct(snapshot?.tbankCardPercent ?? platformSettings?.tbankFeePercent),
    tbankCardMinRub: pct(snapshot?.tbankCardMinRub ?? platformSettings?.tbankCardFeeMinRub),
    tbankPayoutPercent: pct(snapshot?.tbankPayoutPercent ?? platformSettings?.tbankPayoutFeePercent),
    tbankPayoutMinRub: pct(snapshot?.tbankPayoutMinRub ?? platformSettings?.tbankPayoutFeeMinRub),
  };
}

function computeFeesBreakdown(sumRub, snapshot = {}) {
  const rules = resolveFeeRules(snapshot);
  const gross = Number(sumRub) || 0;
  const calc = calculateNetAmountAfterFees(gross, rules.platformPercent, {
    cardFeePercent: rules.tbankCardPercent,
    cardFeeMinRub: rules.tbankCardMinRub,
    payoutFeePercent: rules.tbankPayoutPercent,
    payoutFeeMinRub: rules.tbankPayoutMinRub,
  });

  return {
    ps: rules.platformPercent,
    tb: rules.tbankCardPercent,
    tbPayout: rules.tbankPayoutPercent,
    tbTotalPercent: Number((rules.tbankCardPercent + rules.tbankPayoutPercent).toFixed(3)),
    feePlatform: calc.platformFee,
    feeTbank: calc.tbankFee,
    feeTbankCard: calc.tbankCardFee,
    feeTbankPayout: calc.tbankPayoutFee,
    net: calc.netAmount,
  };
}

function fmtRub(x) {
  return (Number(x) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getTripFeeSnapshot(src) {
  if (!src) return null;
  const platformRaw = src.platform_fee ?? src.platformPercent;
  const tbankRaw = src.tbank_fee ?? src.tbankCardPercent;
  return {
    platformPercent: Number.isFinite(Number(platformRaw)) ? Number(platformRaw) : undefined,
    tbankCardPercent: Number.isFinite(Number(tbankRaw)) ? Number(tbankRaw) : undefined,
  };
}

function buildDecisionMessage({ tripTitle, refund, payout, feesPayout, description }) {
  const lines = [
    `🧩 Решение администрации по поездке «${tripTitle || ''}» после обсуждения:`,
    `• Возврат участнику: ${fmtRub(refund)} ₽ — без комиссий.`,
    `• Выплата организатору: ${fmtRub(payout)} ₽ — за вычетом комиссии Т-банка (${fmtRub(feesPayout.feeTbank)} ₽) и комиссии площадки «Онлок» (${fmtRub(feesPayout.feePlatform)} ₽).`,
  ];
  if (description && description.trim()) {
    lines.push(`• Описание: ${description.trim()}`);
  }
  return `[ADMIN_DECISION]\n${lines.join('\n')}`;
}

const AdminDisputesPage = ({ permissions = { is_admin: false, can_tab: false } }) => {
  const { user } = useAuth();
  const [disputes, setDisputes] = useState([]);
  const [message, setMessage] = useState('');

  // активная строка (для мягкой подсветки)
  const [activeDisputeId, setActiveDisputeId] = useState(null);

  // модалка переписки
  const [viewerChat, setViewerChat] = useState(null);
  const [viewerProfilesMap, setViewerProfilesMap] = useState({});
  const [viewerTrip, setViewerTrip] = useState(null);          // { id, title, image_urls }
  const [viewerCanSend, setViewerCanSend] = useState(false);   // серый композер до вступления

  // модалка делегирования
  const [delegatingDispute, setDelegatingDispute] = useState(null); // полный объект диспута
  const [adminCandidates, setAdminCandidates] = useState([]);       // [{ user_id, profile }]
  const [delegateTo, setDelegateTo] = useState(null);               // user_id выбранного админа

  // модалка завершения спора (ввод предложения + суммы/проценты)
  const [closingModal, setClosingModal] = useState({
    open: false,
    dispute: null,
    description: '',
    total: '',
    refundRub: '',
    refundPct: '',
    inputMode: 'rub', // 'rub' | 'pct' — чем задаём возврат
    submitting: false,
  });

  // модалка «Произвести выплаты и возврат»
  const [settleModal, setSettleModal] = useState({
    open: false,
    dispute: null,
    total: '',       // общая сумма оплаты (₽)
    refund: '',      // сумма возврата участнику (₽)
    loading: false,
    organizerId: null, // creator_id поездки
    dealId: null,      // trips.deal_id
    paymentId: null,   // последний payment_id участника
    originalPaid: null, // сумма исходной оплаты участника (для валидации)
    paymentDbId: null,
    feeSnapshot: null,
  });

  const canModerate = !!(permissions.is_admin || permissions.can_tab);

  // вложения
  const {
    pendingFiles,
    isUploading,
    onPickFiles,
    removePending,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  } = useChatAttachments({ supabase, bucket: 'trip_chat_files' });

  const {
    messages, setMessages,
    chatMessagesRef, messagesEndRef,
    page, setPage,
    hasMore, setHasMore,
    fetchMessages,
    markAllMessagesAsRead,
    resetPagination,
  } = useMessagesRealtime({
    supabase,
    user,
    currentChat: viewerChat,
    preloadSignedUrlsForMessages,
    signFileUrl,
    notifications: { getTotalUnread: () => 0, unreadCounts: {}, addListener: () => {}, removeListener: () => {}, setUnreadCount: () => {} },
    updateUnreadCount: async () => {},
  });

  function toastOnce(msg) {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3200);
  }
  function deny() { toastOnce('Доступ запрещен: недостаточно прав'); }

  async function getUserFullName(userId) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name, patronymic')
      .eq('user_id', userId)
      .maybeSingle();
    return profile
      ? [profile.last_name, profile.first_name, profile.patronymic].filter(Boolean).join(' ')
      : 'Неизвестный пользователь';
  }

  async function sendChatSystem(chatId, content) {
    await supabase.from('chat_messages').insert({
      chat_id: chatId,
      user_id: user.id,
      content,
      read: false,
    });
  }

  async function hasSystemMessage(chatId, content) {
    const { data } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('chat_id', chatId)
      .eq('content', content)
      .limit(1)
      .maybeSingle();
    return !!data?.id;
  }

  async function findDisputeChatId({ tripId, initiatorId, respondentId }) {
    const { data: chatsRows } = await supabase
      .from('chats')
      .select('id')
      .eq('trip_id', tripId)
      .eq('chat_type', 'dispute');
    if (!Array.isArray(chatsRows) || chatsRows.length === 0) return null;

    const chatIds = chatsRows.map(c => c.id);
    const { data: partsRows } = await supabase
      .from('chat_participants')
      .select('chat_id, user_id')
      .in('chat_id', chatIds);

    const byChat = (partsRows || []).reduce((acc, r) => {
      (acc[r.chat_id] ||= new Set()).add(r.user_id);
      return acc;
    }, {});

    for (const chatId of chatIds) {
      const s = byChat[chatId] || new Set();
      if (s.has(initiatorId) && s.has(respondentId)) return chatId;
    }
    return null;
  }

  // список кандидатов
  async function fetchAdminCandidatesForDisputes() {
    const { data } = await supabase.from('user_admin_access').select('user_id, is_admin, disputes');
    const allowedIds = (data || []).filter((r) => r.is_admin || r.disputes).map((r) => r.user_id);
    if (!allowedIds.length) return [];
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_id, first_name, last_name, avatar_url')
      .in('user_id', allowedIds);
    const map = (profs || []).reduce((acc, p) => { acc[p.user_id] = p; return acc; }, {});
    return allowedIds.map((uid) => ({ user_id: uid, profile: map[uid] }));
  }

  // === Загрузка списка диспутов (+ мета чатов/непрочит./последнее) ===
  const disputeChatIdsRef = useRef(new Set());
  async function fetchDisputes() {
    const { data, error } = await supabase
      .from('disputes')
      .select(`
        id,
        trip_id,
        initiator_id,
        respondent_id,
        reason,
        status,
        created_at,
        close_proposal_text,
        refund_amount_cents,
        payout_amount_cents,
        initiator_confirmed,
        respondent_confirmed,
        trips (title, platform_fee, tbank_fee),
        profiles_initiator:profiles!initiator_id (first_name, last_name),
        profiles_respondent:profiles!respondent_id (first_name, last_name)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      toastOnce('Ошибка загрузки споров');
      return;
    }

    const rows = data || [];
    const withChatId = await Promise.all(
      rows.map(async (d) => {
        const chatId = await findDisputeChatId({
          tripId: d.trip_id,
          initiatorId: d.initiator_id,
          respondentId: d.respondent_id,
        });
        return { ...d, chatId };
      })
    );

    const chatIds = withChatId.map(r => r.chatId).filter(Boolean);
    disputeChatIdsRef.current = new Set(chatIds);

    // метаданные чатов
    let chatMetaById = {};
    if (chatIds.length) {
      const { data: chatRows } = await supabase
        .from('chats')
        .select('id, moderator_id, support_close_confirmed, chat_type')
        .in('id', chatIds);
      for (const r of chatRows || []) {
        chatMetaById[r.id] = {
          moderator_id: r.moderator_id || null,
          support_close_confirmed: !!r.support_close_confirmed,
          chat_type: r.chat_type,
        };
      }
    }

    // непрочитанные
    let unreadByChat = {};
    if (chatIds.length) {
      const { data: unreadRows } = await supabase
        .from('chat_messages')
        .select('chat_id, id, user_id, read')
        .in('chat_id', chatIds)
        .neq('user_id', user?.id)
        .or('read.is.null,read.eq.false');

      (unreadRows || []).forEach((m) => {
        unreadByChat[m.chat_id] = (unreadByChat[m.chat_id] || 0) + 1;
      });
    }

    // последние
    let lastByChat = {};
    if (chatIds.length) {
      const { data: lastRows } = await supabase
        .from('chat_messages')
        .select('chat_id, content, created_at')
        .in('chat_id', chatIds)
        .order('created_at', { ascending: false });
      for (const row of lastRows || []) {
        if (!lastByChat[row.chat_id]) lastByChat[row.chat_id] = row;
      }
    }

    const enriched = withChatId.map((d) => {
      const meta = d.chatId ? (chatMetaById[d.chatId] || {}) : {};
      return {
        ...d,
        moderator_id: meta.moderator_id ?? null,
        support_close_confirmed: !!meta.support_close_confirmed,
        unread: d.chatId ? (unreadByChat[d.chatId] || 0) : 0,
        lastMessage: d.chatId ? (lastByChat[d.chatId]?.content || null) : null,
        lastMessageAt: d.chatId ? (lastByChat[d.chatId]?.created_at || null) : null,
      };
    });

    setDisputes(enriched);
  }

  useEffect(() => { if (canModerate) fetchDisputes(); }, [canModerate]);

  // realtime: новые сообщения + архивация + смена модератора + подтверждение закрытия
  useEffect(() => {
    if (!canModerate) return;
    const channel = supabase
      .channel('admin_disputes_watch')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        async (payload) => {
          const row = payload?.new;
          if (!row) return;

          let isDisputeChat = disputeChatIdsRef.current.has(row.chat_id);
          if (!isDisputeChat) {
            const { data: c } = await supabase
              .from('chats')
              .select('id, chat_type')
              .eq('id', row.chat_id)
              .maybeSingle();
            isDisputeChat = c?.chat_type === 'dispute';
            if (isDisputeChat) disputeChatIdsRef.current.add(row.chat_id);
          }
          if (!isDisputeChat) return;

          setDisputes((prev) =>
            prev.map((d) => {
              if (d.chatId !== row.chat_id) return d;
              const isViewer = viewerChat?.id === row.chat_id;
              const isMine = row.user_id === user?.id;
              const unreadDelta = isMine || isViewer ? 0 : 1;

              return {
                ...d,
                lastMessage: row.content,
                lastMessageAt: row.created_at,
                unread: Math.max(0, (d.unread || 0) + unreadDelta),
              };
            })
          );

          if (viewerChat?.id === row.chat_id && row.user_id !== user?.id) {
            try { await supabase.from('chat_messages').update({ read: true }).eq('id', row.id); } catch {}
          }
        }
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chats' },
        (payload) => {
          const newRow = payload?.new;
          if (!newRow) return;

          setDisputes((prev) =>
            prev.map((d) =>
              d.chatId === newRow.id
                ? {
                    ...d,
                    moderator_id: newRow.moderator_id || null,
                    support_close_confirmed:
                      typeof newRow.support_close_confirmed === 'boolean'
                        ? newRow.support_close_confirmed
                        : d.support_close_confirmed,
                    status: newRow.chat_type === 'archived' ? 'resolved' : d.status,
                  }
                : d
            )
          );

          if (newRow.chat_type === 'archived') {
            if (disputeChatIdsRef.current.has(newRow.id)) {
              if (viewerChat?.id === newRow.id) {
                setViewerChat(null);
                setActiveDisputeId(null);
              }
            }
          }
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [canModerate, viewerChat?.id, user?.id]);

  // ВСТУПИТЬ
  async function handleJoinDispute(disputeId, tripId) {
    if (!canModerate) return deny();

    const row = disputes.find(d => d.id === disputeId);
    if (!row) return;

    const { data: dispute } = await supabase
      .from('disputes')
      .select('status, initiator_id, respondent_id')
      .eq('id', disputeId)
      .single();

    if (dispute?.status !== 'awaiting_moderator') {
      toastOnce('Спор уже взят другим модератором или завершен');
      return;
    }

    const chatId = await findDisputeChatId({
      tripId,
      initiatorId: dispute.initiator_id,
      respondentId: dispute.respondent_id,
    });
    if (!chatId) return toastOnce('Чат спора не найден');

    const moderatorName = await getUserFullName(user.id);

    const { data: existsAdmin } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('chat_id', chatId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!existsAdmin) {
      await supabase.from('chat_participants').insert({ chat_id: chatId, user_id: user.id });
    }

    const { error: chatError } = await supabase
      .from('chats')
      .update({ moderator_id: user.id })
      .eq('id', chatId);
    const { error: disputeError } = await supabase
      .from('disputes')
      .update({ status: 'in_progress' })
      .eq('id', disputeId);

    if (chatError || disputeError) return toastOnce('Ошибка назначения модератора');

    await sendChatSystem(chatId, `Модератор ${moderatorName} вступил в обсуждение`);

    if (viewerChat?.id === chatId) setViewerCanSend(true);

    setDisputes((prev) =>
      prev.map((d) => (d.id === disputeId ? { ...d, moderator_id: user.id, status: 'in_progress' } : d))
    );

    toastOnce('Вы вступили в спор');
  }

  // ДЕЛЕГИРОВАТЬ
  async function openDelegateModal(row) {
    if (row.status !== 'in_progress' || row.moderator_id !== user?.id) return;
    setDelegatingDispute(row);
    setDelegateTo(null);
    const list = await fetchAdminCandidatesForDisputes();
    setAdminCandidates(list);
  }
  async function handleDelegateConfirm() {
    const row = delegatingDispute;
    if (!row || !delegateTo) return;

    const chatId = row.chatId;
    if (!chatId) return toastOnce('Чат спора не найден');

    const { data: chatRow } = await supabase.from('chats').select('moderator_id').eq('id', chatId).maybeSingle();
    if (!chatRow || chatRow.moderator_id !== user.id) return toastOnce('Делегировать может только назначенный модератор');

    const { error: updChatErr } = await supabase
      .from('chats')
      .update({ moderator_id: delegateTo })
      .eq('id', chatId);
    if (updChatErr) return toastOnce('Ошибка делегирования');

    await supabase.from('chat_participants').delete().eq('chat_id', chatId).eq('user_id', user.id);

    const { data: haveNew } = await supabase
      .from('chat_participants')
      .select('chat_id, user_id')
      .eq('chat_id', chatId).eq('user_id', delegateTo).maybeSingle();
    if (!haveNew) await supabase.from('chat_participants').insert([{ chat_id: chatId, user_id: delegateTo }]);

    const { data: prof } = await supabase
      .from('profiles').select('first_name, last_name').eq('user_id', delegateTo).single();
    const display = `${prof?.last_name || ''} ${prof?.first_name || ''}`.trim() || 'новый модератор';
    await sendChatSystem(chatId, `Спор передан: ${display}`);

    if (viewerChat?.id === chatId) setViewerCanSend(false);

    setDisputes((prev) => prev.map((d) => (d.id === row.id ? { ...d, moderator_id: delegateTo } : d)));
    setDelegatingDispute(null);
    setDelegateTo(null);
    toastOnce('Спор делегирован');
  }

  // ЗАВЕРШИТЬ (админское предложение + опрос)
  async function handleResolveDispute(disputeId) {
    if (!canModerate) return deny();
    const row = disputes.find(d => d.id === disputeId);
    if (!row) return;
    if (row?.moderator_id !== user?.id) return toastOnce('Закрыть спор может только назначенный модератор');
    if (row?.status !== 'in_progress') return toastOnce('Спор не в процессе обсуждения');

    // Подставим предполагаемую сумму оплаты участника
    const guess = await guessPaymentAndDeal(row);
    setClosingModal({
      open: true,
      dispute: row,
      description: '',
      total: guess.total ? String(guess.total) : '',
      refundRub: '0',
      refundPct: '0',
      inputMode: 'rub',
      submitting: false,
    });
  }

  async function confirmClosePrompt() {
    const { dispute, description, total, refundRub, refundPct } = closingModal;
    if (!dispute) return;

    const { data: drow } = await supabase
      .from('disputes')
      .select('trip_id, initiator_id, respondent_id, status, id')
      .eq('id', dispute.id)
      .single();
    if (!drow || drow.status !== 'in_progress') {
      setClosingModal({ open: false, dispute: null, description: '', total: '', refundRub: '', refundPct: '', inputMode: 'rub', submitting: false });
      return toastOnce('Спор не в процессе обсуждения');
    }

    const chatId = await findDisputeChatId({
      tripId: drow.trip_id,
      initiatorId: drow.initiator_id,
      respondentId: drow.respondent_id,
    });
    if (!chatId) {
      setClosingModal({ open: false, dispute: null, description: '', total: '', refundRub: '', refundPct: '', inputMode: 'rub', submitting: false });
      return toastOnce('Чат спора не найден');
    }

    const sumTotal = Number(total);
    if (!Number.isFinite(sumTotal) || sumTotal <= 0) return toastOnce('Укажите корректную общую сумму оплаты');

    const { data: pmt } = await supabase
      .from('payments')
      .select('amount')
      .eq('trip_id', drow.trip_id)
      .eq('participant_id', drow.initiator_id)
      .eq('payment_type', 'participant_payment')
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const originalPaid = Number(pmt?.amount || 0);
    if (!(originalPaid > 0)) return toastOnce('Исходный платёж участника не найден');
    if (sumTotal > originalPaid + 1e-6) return toastOnce('Общая сумма больше исходной оплаты участника');

    let refund = 0;
    if (closingModal.inputMode === 'rub') {
      refund = Number(refundRub || 0);
    } else {
      const rp = Number(refundPct || 0);
      if (!Number.isFinite(rp) || rp < 0 || rp > 100) return toastOnce('Процент возврата должен быть от 0 до 100');
      refund = +(sumTotal * (rp / 100)).toFixed(2);
    }
    if (refund < 0) refund = 0;
    if (refund > sumTotal) return toastOnce('Сумма возврата больше общей суммы');
    const payout = +(sumTotal - refund).toFixed(2);

    const feeSnapshot = getTripFeeSnapshot(dispute?.trips);
    const feesPayout = computeFeesBreakdown(payout, feeSnapshot);
    const decisionText = buildDecisionMessage({
      tripTitle: dispute.trips?.title,
      refund,
      payout,
      feesPayout,
      description,
    });

    const guess = await guessPaymentAndDeal(dispute);

    setClosingModal((s) => ({ ...s, submitting: true }));
    try {
      const { error: upderr } = await supabase
        .from('disputes')
        .update({
          close_proposal_text: decisionText,
          close_proposal_at: new Date().toISOString(),
          refund_amount_cents: Math.round(refund * 100),
          payout_amount_cents: Math.round(payout * 100),
          initiator_confirmed: true,
          respondent_confirmed: true,
          confirmed_at: new Date().toISOString(),
          locked: true,
        })
        .eq('id', dispute.id);

      if (upderr) throw new Error('Не удалось сохранить решение администратора');

      await sendChatSystem(chatId, decisionText);

      const refundDoneText = `✅ Возврат участнику выполнен: ${fmtRub(refund)} ₽.`;
      const payoutDoneText = `✅ Выплата организатору выполнена: ${fmtRub(payout)} ₽.`;

      if (refund > 0 && !(await hasSystemMessage(chatId, refundDoneText))) {
        await doRefund({
          tripId: drow.trip_id,
          participantId: drow.initiator_id,
          paymentId: guess.paymentId,
          amount: refund,
          source: 'admin_disputes_settle',
          reason: 'admin_dispute_settle',
        });
        await sendChatSystem(chatId, refundDoneText);
      }

      if (payout > 0 && !(await hasSystemMessage(chatId, payoutDoneText))) {
        await doPayout({
          tripId: drow.trip_id,
          organizerId: guess.organizerId,
          dealId: guess.dealId,
          participantId: drow.initiator_id,
          amount: payout,
          sourcePaymentId: guess.paymentDbId,
          feeSnapshot: guess.feeSnapshot,
        });
        await sendChatSystem(chatId, payoutDoneText);
      }

      await supabase
        .from('disputes')
        .update({ status: 'resolved' })
        .eq('id', dispute.id);
      await supabase
        .from('chats')
        .update({
          support_close_confirmed: true,
          support_close_requested_at: new Date().toISOString(),
          chat_type: 'archived',
        })
        .eq('id', chatId);

      setClosingModal({ open: false, dispute: null, description: '', total: '', refundRub: '', refundPct: '', inputMode: 'rub', submitting: false });
      toastOnce('Спор завершен. Возврат и выплата выполнены.');
      fetchDisputes();
    } catch (e) {
      console.error(e);
      toastOnce(e?.message || 'Ошибка завершения спора');
      setClosingModal((s) => ({ ...s, submitting: false }));
    }
  }

  // ОТКРЫТЬ ЧАТ
  async function openDisputeViewer(row) {
    if (!row?.chatId) return toastOnce('Чат спора не найден');

    const { data: parts } = await supabase
      .from('chat_participants')
      .select('chat_id, user_id')
      .eq('chat_id', row.chatId);
    const participantIds = (parts || []).map((p) => p.user_id);

    let profilesMap = {};
    if (participantIds.length) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name, avatar_url')
        .in('user_id', participantIds);
      profilesMap = (profiles || []).reduce((acc, pr) => { acc[pr.user_id] = pr; return acc; }, {});
    }

    const { data: tripRow } = await supabase
      .from('trips')
      .select('id, title, image_urls')
      .eq('id', row.trip_id)
      .maybeSingle();
    setViewerTrip(tripRow || { id: row.trip_id, title: row.trips?.title || '', image_urls: [] });

    setViewerCanSend(participantIds.includes(user?.id));

    const chatObj = {
      id: row.chatId,
      chat_type: 'dispute',
      is_group: true,
      trip_id: row.trip_id,
      title: `Диспут · ${row.trips?.title || tripRow?.title || ''}`,
      participantsUserIds: participantIds,
    };

    setViewerProfilesMap(profilesMap);
    setViewerChat(chatObj);

    setActiveDisputeId(row.id);
    setDisputes((prev) => prev.map((d) => (d.id === row.id ? { ...d, unread: 0 } : d)));

    resetPagination();
    await fetchMessages(chatObj.id);
    await markAllMessagesAsRead(chatObj.id);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }

  function closeViewer() {
    setViewerChat(null);
    setViewerProfilesMap({});
    setViewerTrip(null);
    setPage(1);
    setHasMore(true);
    setMessages([]);
    setViewerCanSend(false);
    setActiveDisputeId(null);
  }

  // ==== ВЫПЛАТЫ / ВОЗВРАТ — единая кнопка ====

  // предзаполнить total/payment/deal + данные из disputes
  async function guessPaymentAndDeal(dispute) {
    const out = { total: 0, paymentId: null, dealId: null, organizerId: null, originalPaid: 0 };

    // последний платёж участника
    const { data: pmt } = await supabase
      .from('payments')
      .select('id, payment_id, amount')
      .eq('trip_id', dispute.trip_id)
      .eq('participant_id', dispute.initiator_id)
      .eq('payment_type', 'participant_payment')
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pmt) { out.total = Number(pmt.amount) || 0; out.paymentId = pmt.payment_id || null; out.originalPaid = Number(pmt.amount) || 0; out.paymentDbId = pmt.id || null; }

    // deal_id + organizer
    const { data: trip } = await supabase
      .from('trips')
      .select('deal_id, creator_id, platform_fee, tbank_fee')
      .eq('id', dispute.trip_id)
      .maybeSingle();
    if (trip) {
      out.dealId = trip.deal_id || null;
      out.organizerId = trip.creator_id || null;
      out.feeSnapshot = {
        platformPercent: Number.isFinite(Number(trip.platform_fee)) ? Number(trip.platform_fee) : platformSettings.platformFeePercent,
        tbankCardPercent: Number.isFinite(Number(trip.tbank_fee)) ? Number(trip.tbank_fee) : platformSettings.tbankFeePercent,
      };
    }

    // если в диспуте уже лежат согласованные суммы — используем их
    if ((dispute.refund_amount_cents ?? null) !== null || (dispute.payout_amount_cents ?? null) !== null) {
      const ref = (dispute.refund_amount_cents || 0) / 100;
      const pay = (dispute.payout_amount_cents || 0) / 100;
      if (ref + pay > 0) out.total = +(ref + pay).toFixed(2);
    }

    return out;
  }

  function closeSettleModal() {
    setSettleModal({ open: false, dispute: null, total: '', refund: '', loading: false, organizerId: null, dealId: null, paymentId: null, originalPaid: null, paymentDbId: null, feeSnapshot: null });
  }

  // API вызовы к tbank-* (через ваши pages/api/tbank/*)
  async function getAccessToken() {
    const { data: { session} } = await supabase.auth.getSession();
    return session?.access_token || '';
  }

async function doRefund({ paymentId, tripId, participantId, amount, reason, source }) {
  const token = await getAccessToken();
  const resp = await fetch('/api/tbank/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ paymentId, tripId, participantId, amount, reason, source }),
  });

  let data = null;
  try { data = await resp.json(); } catch {}

  if (!resp.ok || !data?.ok) {
    const msg = data?.error || data?.details || `HTTP ${resp.status}`;
    const code = data?.errorCode ? ` (код банка: ${data.errorCode})` : '';
    console.error('[disputes/doRefund] API error:', { status: resp.status, data });
    throw new Error(`Возврат отклонён: ${msg}${code}`);
  }
  return data;
}
async function doPayout({ tripId, organizerId, dealId, participantId, amount, sourcePaymentId, feeSnapshot }) {
    if (!amount || amount <= 0) return true;
    if (!dealId) throw new Error('deal_id не найден для поездки');

    // получим recipientId (например, телефон организатора) — для карточных выплат не обязателен,
    // но пусть будет, мы на сервере всё равно используем CardId/PartnerId
    const { data: prof } = await supabase
      .from('profiles')
      .select('phone')
      .eq('user_id', organizerId)
      .maybeSingle();
    const recipientId = prof?.phone || null;

    const payoutFees = computeFeesBreakdown(amount, feeSnapshot);
    const token = await getAccessToken();
    const res = await fetch('/api/tbank/payout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tripId,
        amount: payoutFees.net, // ✅ шлём NET
        feePlatformPct: payoutFees.ps,
        feeTbankPct: payoutFees.tbTotalPercent,
        mode: 'admin-settle-net',                 // ✅ сервер НЕ пересчитывает комиссии
        dealId,
        recipientId,
        participantId,
        source: 'admin_disputes_settle', // 👈 добавили
        reason: 'admin_dispute_settle',
      }),
    });
    if (!res.ok) throw new Error('payout failed');
    return true;
  }

  async function handleSettleConfirm() {
    const row = settleModal.dispute;
    const total = Number(settleModal.total);
    const refund = Number(settleModal.refund);
    if (!row) return;

    if (!Number.isFinite(total) || total <= 0) return toastOnce('Укажите корректную общую сумму оплаты');
    if (!Number.isFinite(refund) || refund < 0) return toastOnce('Укажите корректную сумму возврата');
    if (refund > total) return toastOnce('Сумма возврата не может превышать общую сумму');

    // защита: общая сумма не должна превышать исходную оплату участника
    const originalPaid = Number(settleModal.originalPaid || 0);
    if (originalPaid > 0 && total > originalPaid + 1e-6) {
      return toastOnce('Указанная сумма больше суммы исходной оплаты участника');
    }

    const payout = Math.max(total - refund, 0);

    setSettleModal((s) => ({ ...s, loading: true }));
    try {
      await sendChatSystem(row.chatId, `🧾 Операция: возврат участнику ${fmtRub(refund)} ₽; выплата организатору ${fmtRub(payout)} ₽ (итого ${fmtRub(total)} ₽).`);

      // 1) возврат (если > 0)
      if (refund > 0) {
        await doRefund({
          tripId: row.trip_id,
          participantId: row.initiator_id,
          paymentId: settleModal.paymentId,
          amount: refund,
          source: 'admin_disputes_settle',
          reason: 'admin_dispute_settle',
        });

        await sendChatSystem(row.chatId, `✅ Возврат участнику выполнен: ${fmtRub(refund)} ₽.`);
      }

      // 2) выплата (если > 0)
      if (payout > 0) {
        await doPayout({
          tripId: row.trip_id,
          organizerId: settleModal.organizerId,
          dealId: settleModal.dealId,
          participantId: row.initiator_id,
          amount: payout,
          sourcePaymentId: settleModal.paymentDbId, // 👈 привязка к чеку
          feeSnapshot: settleModal.feeSnapshot,
        });
        await sendChatSystem(row.chatId, `✅ Выплата организатору выполнена: ${fmtRub(payout)} ₽.`);
      }

      toastOnce('Операции завершены');
      closeSettleModal();
    } catch (e) {
      console.error(e);
      toastOnce('Ошибка выполнения выплат/возврата');
      setSettleModal((s) => ({ ...s, loading: false }));
    }
  }

  // ==== РЕНДЕР ====

  if (!canModerate) {
    return (
      <div className={styles.container}>
        <h2>Диспуты</h2>
        <div className={styles.error}>Нет прав на просмотр диспутов</div>
      </div>
    );
  }

  const formatTime = (iso) => (!iso ? '' : new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));

  // вспомогательная панель комиссий
  const FeesInfo = ({ sum, kind = 'payout', snapshot = null }) => {
    const s = Number(sum) || 0;
if (kind === 'refund') {
     return (
       <div style={{ marginTop: 4, padding: '8px 10px', border: '1px dashed #e5e7eb', borderRadius: 8, background: '#fafafa', fontSize: 13 }}>
         <div>Возврат выполняется без комиссий.</div>
         <div>К зачислению участнику: {fmtRub(s)} ₽</div>
       </div>
     );
   }
   const { feePlatform, feeTbank, net } = computeFeesBreakdown(s, snapshot);
   return (
     <div style={{ marginTop: 4, padding: '8px 10px', border: '1px dashed #e5e7eb', borderRadius: 8, background: '#fafafa', fontSize: 13 }}>
       <div>Комиссии считаются от введённой суммы.</div>
       <div>Т-банк: {fmtRub(feeTbank)} ₽, Площадка «Онлок»: {fmtRub(feePlatform)} ₽</div>
       <div>К получению «на руки»: {fmtRub(net)} ₽</div>
     </div>
  );
  };

  return (
    <div className={styles.container}>
      <h2>Управление спорами</h2>
      {message && <div className={styles.toast}>{message}</div>}

      <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Поездка</th>
            <th>Инициатор</th>
            <th>Ответчик</th>
            <th>Причина</th>
            <th>Статус</th>
            <th>Чат</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {disputes.map((dispute) => {
            const isMyModerator = dispute.moderator_id && dispute.moderator_id === user?.id;
            const isActive = activeDisputeId === dispute.id;
            const hasUnread = (dispute.unread || 0) > 0;
            const isConfirmed = !!dispute.support_close_confirmed || dispute.status === 'resolved';

            const rowStyle = {
              ...(hasUnread ? { boxShadow: 'inset 3px 0 0 #ef4444' } : null),
              ...(isActive ? { background: '#f9fafb' } : null),
            };

            return (
              <tr key={dispute.id} style={rowStyle}>
                <td>{dispute.id}</td>
                <td>{dispute.trips?.title || 'Не указано'}</td>
                <td>{dispute.profiles_initiator?.last_name} {dispute.profiles_initiator?.first_name}</td>
                <td>{dispute.profiles_respondent?.last_name} {dispute.profiles_respondent?.first_name}</td>
                <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {dispute.reason}
                </td>
                <td>
                  {dispute.status === 'awaiting_moderator' && 'Ожидает модератора'}
                  {dispute.status === 'in_progress' && (isConfirmed ? 'Подтверждён' : 'В процессе')}
                  {dispute.status === 'resolved' && 'Завершен'}
                  {dispute.status === 'error' && 'Ошибка'}
                </td>

                <td>
                  {dispute.chatId ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {dispute.lastMessage || '—'}
                      </div>
                      {dispute.unread > 0 && <span className={styles.badge}>{dispute.unread}</span>}
                      <div style={{ fontSize: 12, opacity: 0.6 }}>{formatTime(dispute.lastMessageAt)}</div>
                    </div>
                  ) : '—'}
                </td>

                <td>
                  <div className={styles.actionsRow}>
                  {dispute.chatId && (
                    <button
                      className={styles.joinButton}
                      onClick={() => openDisputeViewer(dispute)}
                      title="Открыть чат"
                      >
                      Открыть
                    </button>
                  )}

                  {!isConfirmed && (
                    <>
                      {dispute.status === 'awaiting_moderator' && (
                        <button
                          className={styles.joinButton}
                          onClick={() => handleJoinDispute(dispute.id, dispute.trip_id)}
                        >
                          Вступить в спор
                        </button>
                      )}

                      {dispute.status === 'in_progress' && (
                        <>
                          <button
                            className={styles.resolveButton}
                            onClick={() => isMyModerator ? handleResolveDispute(dispute.id) : null}
                            disabled={!isMyModerator}
                            title={isMyModerator ? 'Завершить спор (с выплатой/возвратом и закрытием)' : 'Только модератор может закрыть'}
                            >
                            Завершить спор
                          </button>

                          <button
                            className={styles.joinButton}
                            onClick={() => openDelegateModal(dispute)}
                            disabled={!isMyModerator}
                            title={isMyModerator ? 'Передать спор другому модератору' : 'Делегировать может только модератор'}
                          >
                            Делегировать
                          </button>
                        </>
                      )}
                    </>
                  )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* Модалка переписки диспута */}
      {viewerChat && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeViewer(); }}
        >
          <div
            style={{
              width: 'min(100vw - 40px, 980px)', height: 'min(100vh - 80px, 720px)',
              background: '#fff', borderRadius: 12, boxShadow: '0 15px 45px rgba(0,0,0,0.2)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ChatHeader
                  currentChat={viewerChat}
                  tripsMap={ viewerTrip ? { [viewerTrip.id]: { title: viewerTrip.title, image_urls: viewerTrip.image_urls || [] } } : {} }
                  profilesMap={viewerProfilesMap}
                  myUserId={user?.id}
                  titleString={renderChatTitle(
                    viewerChat,
                    viewerTrip ? { [viewerTrip.id]: { title: viewerTrip.title } } : {},
                    viewerProfilesMap,
                    user?.id
                  )}
                  participantsVisible={false}
                  setParticipantsVisible={() => {}}
                  styles={msgStyles}
                />
                <button
                  onClick={closeViewer}
                  title="Закрыть"
                  style={{
                    marginLeft: 'auto', border: '1px solid #e5e7eb',
                    borderRadius: 10, padding: '6px 10px', cursor: 'pointer', background: 'white',
                  }}
                >
                  Закрыть
                </button>
              </div>
            </div>

            {/* СПИСОК СООБЩЕНИЙ */}
            <div style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
              <div className={msgStyles.rightPanel} style={{ width: '100%' }}>
                <MessageList
                  messages={messages}
                  profilesMap={viewerProfilesMap}
                  currentChat={viewerChat}
                  myUserId={user?.id}
                  signFileUrl={signFileUrl}
                  chatMessagesRef={chatMessagesRef}
                  messagesEndRef={messagesEndRef}
                  styles={msgStyles}
                />
              </div>
            </div>

            {/* КОМПОЗЕР */}
            {viewerChat.chat_type === 'archived' ? (
              <div style={{ padding: '10px 16px', borderTop: '1px solid #e5e7eb', background: '#fff', fontSize: 14, opacity: 0.8 }}>
                Чат в архиве. Отправка сообщений недоступна.
              </div>
            ) : viewerCanSend ? (
              <MessageComposer
                isUploading={isUploading}
                pendingFiles={pendingFiles}
                onPickFiles={onPickFiles}
                removePending={removePending}
                sendWithMessage={async ({ text }) => {
                  const result = await sendWithMessage({
                    chatId: viewerChat.id,
                    tripId: viewerChat.trip_id,
                    userId: user?.id,
                    text,
                  });
                  return result;
                }}
                currentChat={viewerChat}
                myUserId={user?.id}
                styles={msgStyles}
                onMessageSent={({ message, files }) => {
                  setMessages((prev) => {
                    const exists = prev.some((m) => m.id === message.id);
                    return exists ? prev : [...prev, { ...message, chat_message_files: files }];
                  });
                  setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
                }}
              />
            ) : (
              <div className={msgStyles.chatInputRow} style={{ opacity: 0.6 }}>
                <input type="text" placeholder="Вступите в спор, чтобы писать..." className={msgStyles.chatInput} disabled />
                <button type="button" className={msgStyles.pmIconButton} title="Прикрепить файлы" disabled>
                  <img src="/skr.svg" alt="" style={{ width: 20, height: 20 }} />
                </button>
                <button className={msgStyles.sendButton} disabled>Отправить</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Модалка делегирования */}
      {delegatingDispute && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
          }}
          onClick={() => setDelegatingDispute(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 16, width: 560, maxWidth: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>
              Делегировать спор #{delegatingDispute.id.slice(0, 6)}
            </div>

            <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid #eee', borderRadius: 8 }}>
              {adminCandidates.length ? (
                adminCandidates.map((a) => {
                  const p = a.profile;
                  const label = p ? `${p.last_name || ''} ${p.first_name || ''}`.trim() : a.user_id;
                  const disabled = a.user_id === user?.id;
                  return (
                    <label
                      key={a.user_id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px', borderBottom: '1px solid #f3f4f6',
                        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="radio"
                        name="delegate_to_dispute"
                        value={a.user_id}
                        checked={delegateTo === a.user_id}
                        onChange={() => !disabled && setDelegateTo(a.user_id)}
                        disabled={disabled}
                      />
                      <img
                        src={p?.avatar_url || '/avatar-default.svg'}
                        alt=""
                        style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
                      />
                      <span>{label || a.user_id}</span>
                    </label>
                  );
                })
              ) : (
                <div style={{ padding: 10, opacity: 0.7 }}>Нет доступных модераторов с правом на диспуты</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className={styles.fileInput}
                onClick={() => { setDelegatingDispute(null); setDelegateTo(null); }}
                style={{ cursor: 'pointer', border: '1px solid #ddd', padding: '6px 10px', borderRadius: 8 }}
              >
                Отмена
              </button>
              <button className={styles.uploadButton} disabled={!delegateTo} onClick={handleDelegateConfirm}>
                Делегировать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка завершения спора: предложение + расчёты */}
      {closingModal.open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200,
          }}
          onClick={() => setClosingModal({ open: false, dispute: null, description: '', total: '', refundRub: '', refundPct: '', inputMode: 'rub', submitting: false })}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 16, width: 560, maxWidth: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Завершить спор — Предложение администрации</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 14, color: '#334155' }}>Общая сумма оплаты участника (₽)</span>
                <input
                  type="number"
                  min="0"
                  value={closingModal.total}
                  onChange={(e) => setClosingModal((s) => ({ ...s, total: e.target.value }))}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                />
              </label>

              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 14, color: '#334155' }}>Возврат участнику</span>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="radio"
                      name="refund_mode"
                      checked={closingModal.inputMode === 'rub'}
                      onChange={() => setClosingModal((s) => ({ ...s, inputMode: 'rub' }))}
                    /> в ₽
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="radio"
                      name="refund_mode"
                      checked={closingModal.inputMode === 'pct'}
                      onChange={() => setClosingModal((s) => ({ ...s, inputMode: 'pct' }))}
                    /> в %
                  </label>
                </div>

                {closingModal.inputMode === 'rub' ? (
                  <input
                    type="number"
                    min="0"
                    value={closingModal.refundRub}
                    onChange={(e) => setClosingModal((s) => ({ ...s, refundRub: e.target.value }))}
                    placeholder="Например, 1000"
                    style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                  />
                ) : (
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={closingModal.refundPct}
                    onChange={(e) => setClosingModal((s) => ({ ...s, refundPct: e.target.value }))}
                    placeholder="Например, 50"
                    style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                  />
                )}
              </div>

              {/* Итоговое резюме + комиссии */}
              {(() => {
                const total = Number(closingModal.total) || 0;
                const refund = closingModal.inputMode === 'rub'
                  ? Number(closingModal.refundRub || 0)
                  : +((total * ((Number(closingModal.refundPct || 0) / 100))).toFixed(2));
                const invalid = refund > total || refund < 0 || total <= 0;
                const payout = Math.max(total - refund, 0);

                return (
                  <div>
                    <div style={{
                      marginTop: 4,
                      padding: '10px 12px',
                      border: '1px dashed #e5e7eb',
                      borderRadius: 8,
                      background: '#fafafa',
                      fontSize: 14,
                      color: invalid ? '#b91c1c' : '#111827',
                    }}>
                      {invalid
                        ? 'Проверьте суммы: общая должна быть > 0, возврат — от 0 до общей суммы.'
                        : `Предложение: возврат участнику — ${fmtRub(refund)} ₽, выплата организатору — ${fmtRub(payout)} ₽.`}
                    </div>

                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      <div style={{ fontWeight: 600 }}>Возврат:</div>
                      <FeesInfo sum={refund} kind="refund" snapshot={getTripFeeSnapshot(closingModal.dispute?.trips)} />
                      <div style={{ fontWeight: 600, marginTop: 6 }}>Разбивка комиссий по выплате:</div>
                      <FeesInfo sum={payout} snapshot={getTripFeeSnapshot(closingModal.dispute?.trips)} />
                    </div>
                  </div>
                );
              })()}

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 14, color: '#334155' }}>Описание (почему такое решение)</span>
                <textarea
                  rows={4}
                  value={closingModal.description}
                  onChange={(e) => setClosingModal((s) => ({ ...s, description: e.target.value }))}
                  placeholder="Например: вернуть 50% стоимости, так как …"
                  style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, resize: 'vertical', outline: 'none' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className={styles.fileInput}
                onClick={() => setClosingModal({ open: false, dispute: null, description: '', total: '', refundRub: '', refundPct: '', inputMode: 'rub', submitting: false })}
                style={{ cursor: 'pointer', border: '1px solid #ddd', padding: '6px 10px', borderRadius: 8 }}
                disabled={closingModal.submitting}
              >
                Отмена
              </button>
              <button
                className={styles.uploadButton}
                onClick={confirmClosePrompt}
                disabled={closingModal.submitting ||
                  !Number.isFinite(Number(closingModal.total)) ||
                  Number(closingModal.total) <= 0 ||
                  (closingModal.inputMode === 'rub'
                    ? !Number.isFinite(Number(closingModal.refundRub)) || Number(closingModal.refundRub) < 0 || Number(closingModal.refundRub) > Number(closingModal.total)
                    : !Number.isFinite(Number(closingModal.refundPct)) || Number(closingModal.refundPct) < 0 || Number(closingModal.refundPct) > 100)}
              >
                Отправить предложение и запустить опрос
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ЕДИНАЯ модалка «Произвести выплаты и возврат» */}
      {settleModal.open && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1300,
          }}
          onClick={closeSettleModal}
        >
          <div
            style={{ background: '#fff', borderRadius: 12, padding: 16, width: 560, maxWidth: '92%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Произвести выплаты и возврат</div>

            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 14, color: '#334155' }}>Общая сумма оплаты (₽)</span>
                <input
                  type="number"
                  min="0"
                  value={settleModal.total}
                  onChange={(e) => setSettleModal((s) => ({ ...s, total: e.target.value }))}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 14, color: '#334155' }}>Сумма возврата участнику (₽)</span>
                <input
                  type="number"
                  min="0"
                  value={settleModal.refund}
                  onChange={(e) => setSettleModal((s) => ({ ...s, refund: e.target.value }))}
                  style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', outline: 'none' }}
                />
              </label>

              {/* Итоговое резюме + комиссии */}
              {(() => {
                const total = Number(settleModal.total) || 0;
                const refund = Number(settleModal.refund) || 0;
                const invalid = refund > total || refund < 0 || total <= 0;
                const payout = Math.max(total - refund, 0);

                let summaryLine = '';
                if (invalid) summaryLine = 'Ошибка: сумма возврата больше общей суммы, либо общая сумма ≤ 0.';
                else if (refund === 0) summaryLine = `Будет выполнена только выплата организатору: ${fmtRub(payout)} ₽.`;
                else if (refund === total) summaryLine = `Будет выполнен только возврат участнику: ${fmtRub(refund)} ₽.`;
                else summaryLine = `Будет выполнен возврат участнику: ${fmtRub(refund)} ₽ и выплата организатору: ${fmtRub(payout)} ₽.`;

                return (
                  <div>
                    <div style={{
                      marginTop: 4,
                      padding: '10px 12px',
                      border: '1px dashed #e5e7eb',
                      borderRadius: 8,
                      background: '#fafafa',
                      fontSize: 14,
                      color: invalid ? '#b91c1c' : '#111827',
                    }}>
                      {summaryLine}
                    </div>

                    <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                      <div style={{ fontWeight: 600 }}>Возврат:</div>
                      <FeesInfo sum={refund} kind="refund" snapshot={settleModal.feeSnapshot} />
                      <div style={{ fontWeight: 600, marginTop: 6 }}>Разбивка комиссий по выплате:</div>
                      <FeesInfo sum={payout} snapshot={settleModal.feeSnapshot} />
                    </div>
                  </div>
                );
              })()}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              <div>Лимит: не больше исходной оплаты участника — {fmtRub(settleModal.originalPaid || 0)} ₽</div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button
                className={styles.fileInput}
                onClick={closeSettleModal}
                style={{ cursor: 'pointer', border: '1px solid #ddd', padding: '6px 10px', borderRadius: 8 }}
                disabled={settleModal.loading}
              >
                Отмена
              </button>
              <button
                className={styles.uploadButton}
                onClick={handleSettleConfirm}
                disabled={
                  settleModal.loading ||
                  !Number.isFinite(Number(settleModal.total)) ||
                  Number(settleModal.total) <= 0 ||
                  !Number.isFinite(Number(settleModal.refund)) ||
                  Number(settleModal.refund) < 0 ||
                  Number(settleModal.refund) > Number(settleModal.total) ||
                  (Number(settleModal.originalPaid || 0) > 0 && Number(settleModal.total) > Number(settleModal.originalPaid) + 1e-6)
                }
              >
                {settleModal.loading ? 'Обработка…' : 'Произвести выплаты и возврат'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminDisputesPage;
