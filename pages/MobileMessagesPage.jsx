// pages/MobileMessagesPage.jsx
import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { notifications } from "./_app";

import commonStyles from "../styles/messages-common.module.css";
import mobileStyles from "../styles/messages-mobile.module.css";

// hooks (как на PC)
import { useChatAttachments } from "../hooks/useChatAttachments";
import { useChats } from "../features/messages/hooks/useChats";
import { useDmUnread } from "../features/messages/hooks/useDmUnread";
import { useMessagesRealtime } from "../features/messages/hooks/useMessagesRealtime";

// utils (как на PC)
import { computeTabCounts, renderChatTitle, dedupeFiles } from "../features/messages/utils/chatUtils";

// PC-компоненты сообщений/композера (самый безопасный путь “как PC”)
import ChatHeader from "../features/messages/desktop/ChatHeader";
import MessageList from "../features/messages/desktop/MessageList";
import MessageComposer from "../features/messages/desktop/MessageComposer";

const styles = { ...commonStyles, ...mobileStyles };

export default function MobileMessagesPage({ user, triggerAnimation, onChatOpen, hideSidebar }) {
  const [activeTab, setActiveTab] = useState("active");
  const [search, setSearch] = useState("");

  const [currentChat, setCurrentChat] = useState(null);

 useEffect(() => {
    return () => {
      if (typeof onChatOpen === "function") onChatOpen(false);
    };
  }, [onChatOpen]);

// ✅ говорим глобальному realtime (_app), какой чат сейчас открыт
useEffect(() => {
  if (typeof window === "undefined") return;
  window.__onlocActiveChatId = currentChat?.id || null;
}, [currentChat?.id]);

// ✅ на размонтировании страницы — очистить
useEffect(() => {
  return () => {
    if (typeof window !== "undefined") window.__onlocActiveChatId = null;
  };
}, []);

  // подсветка/раскрытия как на PC
  const [selectedListChatId, setSelectedListChatId] = useState(null);
  const [expandedChats, setExpandedChats] = useState(new Set());
  const [participantsVisible, setParticipantsVisible] = useState(false);

  // dispute meta (как на PC)
  const [disputeMeta, setDisputeMeta] = useState(null);
  const disputeChannelRef = useRef(null);

  // ======= DATA =======
  const {
    chats,
    setChats,
    profilesMap,
    tripsMap,
    isLoading,
    isChatsLoaded,
    fetchChats,
    fetchParticipantsForChat,
    participantsForCurrentChat,
    participantsLoading,
  } = useChats({ supabase, user });

  const {
    pendingFiles,
    isUploading,
    onPickFiles,
    addPendingFiles,
    removePending,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  } = useChatAttachments({ supabase, bucket: "trip_chat_files" });

const { dmUnreadByTrip, refreshAllDmUnread, unreadCount, setUnreadCount, updateUnreadCount } =
  useDmUnread({ supabase, user, isChatsLoaded, notifications, currentChatId: currentChat?.id });


  const { messages, setMessages, chatMessagesRef, messagesEndRef, markAllMessagesAsRead, resetPagination } =
    useMessagesRealtime({
      supabase,
      user,
      currentChat,
      preloadSignedUrlsForMessages,
      signFileUrl,
      notifications,
      updateUnreadCount,
    });

  // карта: trip_id -> id группового чата
const groupChatIdByTrip = useMemo(() => {
  const m = {};
  for (const c of chats) {
    if (!c?.trip_id) continue;
    if (!c.is_group) continue;

    const t = String(c._titleString || c.title || "").toLowerCase();

    const looksLikeTripChat = c.chat_type === "trip_group" || t.includes("чат поездки");
    const looksLikeDispute = !!c.moderator_id || t.includes("диспут");
    const looksLikeSupport =
      !!c.support_close_requested_at || !!c.support_close_confirmed || t.includes("поддерж");
    const looksLikeCompanyEdit = t.includes("реквиз") || t.includes("компани");

    // ✅ берём только "Чат поездки", но НЕ диспут/поддержку/реквизиты
    if (!looksLikeTripChat) continue;
    if (looksLikeDispute || looksLikeSupport || looksLikeCompanyEdit) continue;

    // ✅ приоритет: настоящий trip_group не перетираем archived
    if (!m[c.trip_id] || c.chat_type === "trip_group") {
      m[c.trip_id] = c.id;
    }
  }
  return m;
}, [chats]);



const supportIdsKey = useMemo(
  () =>
    (chats || [])
      .filter((c) => c.chat_type === "support" || c.chat_type === "dispute" || c.chat_type === "company_edit")
      .map((c) => c.id)
      .filter(Boolean)
      .sort()
      .join(","),
  [chats]
);

// ✅ Первичный пересчёт непрочитанных для вкладки "Поддержка"
// (чтобы бейджи появились сразу, а не только после realtime)
useEffect(() => {
  if (!user?.id || !isChatsLoaded) return;

  const supportIds = (chats || [])
    .filter(
      (c) =>
        c.chat_type === "support" ||
        c.chat_type === "dispute" ||
        c.chat_type === "company_edit"
    )
    .map((c) => c.id)
    .filter(Boolean);

  if (!supportIds.length) return;

  (async () => {
    const { data: rows, error } = await supabase.rpc("get_unread_counts_for_chats", {
      p_chat_ids: supportIds,
      p_user_id: user.id,
    });
    if (error) return;

    setUnreadCount((prev) => {
      const next = { ...(prev || {}) };
      (rows || []).forEach((r) => {
        const cid = r?.chat_id;
        const n = Number(r?.unread_count || 0);
        if (!cid) return;
        next[cid] = n;
        notifications?.setUnreadCount?.(cid, n);
      });
      return next;
    });
  })();
}, [user?.id, isChatsLoaded, supportIdsKey, setUnreadCount]);

// ✅ realtime-индикация: новые сообщения в чатах поддержки поднимают бейдж вкладки
useEffect(() => {
  if (!user?.id) return;

  const supportIds = supportIdsKey ? supportIdsKey.split(",").filter(Boolean) : [];
  if (!supportIds.length) return;

  const channel = supabase
    .channel(`support_unread_mobile_${user.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
      const chatId = payload.new?.chat_id;
      if (!chatId || !supportIds.includes(chatId)) return;
      if (payload.new.user_id === user.id) return;
      if (currentChat?.id === chatId) return;

      setUnreadCount((prev) => {
        const next = { ...(prev || {}) };
        next[chatId] = (next[chatId] || 0) + 1;
        notifications?.setUnreadCount?.(chatId, next[chatId]);
        return next;
      });
    })
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, [user?.id, supportIdsKey, currentChat?.id, setUnreadCount]);


  // ======= Realtime по составу участников (как на PC) =======
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`chat_participants_watch_${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_participants" }, async (payload) => {
        const row = payload.new;
        if (!row?.chat_id || !row?.user_id) return;

        // 1) participantsUserIds в chats
        setChats((prev) => {
          let changed = false;
          const next = prev.map((c) => {
            if (c.id !== row.chat_id) return c;
            const ids = c.participantsUserIds || [];
            if (ids.includes(row.user_id)) return c;
            changed = true;
            return { ...c, participantsUserIds: [...ids, row.user_id] };
          });
          return changed ? next : prev;
        });

        // 2) currentChat.participantsUserIds
        setCurrentChat((prev) => {
          if (!prev || prev.id !== row.chat_id) return prev;
          const ids = prev.participantsUserIds || [];
          if (ids.includes(row.user_id)) return prev;
          return { ...prev, participantsUserIds: [...ids, row.user_id] };
        });

        // 3) перечитать чаты для profilesMap (как у тебя: только если это "я" или открыт этот чат)
        if (row.user_id === user.id || currentChat?.id === row.chat_id) {
          await fetchChats();
        }

        // 4) если открыт этот групповой чат — обновим панель участников
        if (currentChat && currentChat.id === row.chat_id && currentChat.is_group) {
          fetchParticipantsForChat(currentChat);
        }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_participants" }, async (payload) => {
        const row = payload.old;
        if (!row?.chat_id || !row?.user_id) return;

        // 1) убрать из chats.participantsUserIds
        setChats((prev) => {
          let changed = false;
          const next = prev.map((c) => {
            if (c.id !== row.chat_id) return c;
            const idsOld = c.participantsUserIds || [];
            const ids = idsOld.filter((id) => id !== row.user_id);
            if (ids.length === idsOld.length) return c;
            changed = true;
            return { ...c, participantsUserIds: ids };
          });
          return changed ? next : prev;
        });

        // 2) убрать из currentChat.participantsUserIds
        setCurrentChat((prev) => {
          if (!prev || prev.id !== row.chat_id) return prev;
          const idsOld = prev.participantsUserIds || [];
          const ids = idsOld.filter((id) => id !== row.user_id);
          if (ids.length === idsOld.length) return prev;
          return { ...prev, participantsUserIds: ids };
        });

        // 3) перечитать чаты
        if (row.user_id === user.id || currentChat?.id === row.chat_id) {
          await fetchChats();
        }

        // 4) обновить участников, если открыт этот чат
        if (currentChat && currentChat.id === row.chat_id && currentChat.is_group) {
          fetchParticipantsForChat(currentChat);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, currentChat?.id, currentChat?.is_group, setChats, fetchChats, fetchParticipantsForChat]);

  // ======= вкладки/фильтрация (как на PC) =======
  const chatMatchesTab = (chat) => {
    const tripStatus = chat.trip_id ? tripsMap[chat.trip_id]?.status || null : null;

    if (activeTab === "support") {
      return chat.chat_type === "support" || chat.chat_type === "dispute" || chat.chat_type === "company_edit";
    }

    if (activeTab === "archived") {
      const isArchivedTripGroup =
        chat.is_group &&
        ((chat.chat_type === "trip_group" && tripStatus === "archived") ||
          (chat.chat_type === "archived" && !!chat.trip_id));

      const isArchivedSupportLike = chat.chat_type === "archived" && !chat.is_group && !chat.trip_id;

      // trip_private сюда не попадают
      return isArchivedTripGroup || isArchivedSupportLike;
    }

    // active
    const isGroupTripChat = chat.is_group && chat.chat_type === "trip_group";
    const isTripArchived = tripStatus === "archived";
    return isGroupTripChat && !isTripArchived;
  };

  const chatsWithTitles = useMemo(() => {
    return chats.map((c) => ({
      ...c,
      _titleString: renderChatTitle(c, tripsMap, profilesMap, user?.id),
    }));
  }, [chats, tripsMap, profilesMap, user?.id]);

  const filteredChats = useMemo(() => {
    const q = (search || "").toLowerCase();
    return chatsWithTitles.filter(chatMatchesTab).filter((c) => (c._titleString || "").toLowerCase().includes(q));
  }, [chatsWithTitles, search, activeTab]);

  // stub поддержки (как на PC)
  const leftList = useMemo(() => {
    let list = filteredChats;
    if (activeTab === "support" && list.length === 0) {
      list = [
        {
          id: "__support_stub__",
          chat_type: "support",
          is_group: false,
          created_at: new Date().toISOString(),
          trip_id: null,
          participantsUserIds: [user?.id].filter(Boolean),
          _titleString: "Администрация сайта",
          _isStub: true,
        },
      ];
    }
    return list;
  }, [filteredChats, activeTab, user?.id]);

  // Счётчики вкладок
  const tabCounts = useMemo(() => {
    // если у тебя computeTabCounts уже есть и учитывает archived/support — можно использовать его,
    // но оставляем "как PC" (ручной расчёт) чтобы не зависеть от utils
    let active = 0,
      support = 0,
      archived = 0;

    for (const chat of chats) {
      const tripStatus = chat.trip_id ? tripsMap[chat.trip_id]?.status || null : null;

      // support tab
      if (chat.chat_type === "support" || chat.chat_type === "dispute" || chat.chat_type === "company_edit") {
        support++;
        continue;
      }

      // active tab: только trip_group и поездка не archived
      const isActiveTripGroup = chat.is_group && chat.chat_type === "trip_group" && tripStatus !== "archived";

      // archived tab: только как в chatMatchesTab
      const isArchivedTripGroup =
        chat.is_group &&
        ((chat.chat_type === "trip_group" && tripStatus === "archived") ||
          (chat.chat_type === "archived" && !!chat.trip_id));

      const isArchivedSupportLike = chat.chat_type === "archived" && !chat.is_group && !chat.trip_id;

      const isArchivedChat = isArchivedTripGroup || isArchivedSupportLike;

      if (isActiveTripGroup) active++;
      else if (isArchivedChat) archived++;
    }

    return { active, support, archived };
  }, [chats, tripsMap]);

  // Непрочитанные по вкладкам (для красных точек)
  const unreadByTab = useMemo(() => {
    const byId = unreadCount || {};
    let active = 0,
      support = 0,
      archived = 0;

    for (const c of chats) {
  const n = byId[c.id] || 0;
  if (!n) continue;

  const tripStatus = c.trip_id ? tripsMap[c.trip_id]?.status || null : null;

  // support-like
  if (c.chat_type === "support" || c.chat_type === "dispute" || c.chat_type === "company_edit") {
    support += n;
    continue;
  }

  // ✅ DM (лички по поездке)
  const isTripDm = !c.is_group && !!c.trip_id && (c.chat_type === "trip_private" || c.chat_type === "archived");
  if (isTripDm) {
    const goesToArchived = c.chat_type === "archived" || tripStatus === "archived";
    if (goesToArchived) archived += n;
    else active += n;
    continue;
  }

  // group trip chats
  const isActiveTripGroup = c.is_group && c.chat_type === "trip_group" && tripStatus !== "archived";
  const isArchivedTripGroup =
    c.is_group &&
    ((c.chat_type === "trip_group" && tripStatus === "archived") || (c.chat_type === "archived" && !!c.trip_id));

  const isArchivedSupportLike = c.chat_type === "archived" && !c.is_group && !c.trip_id;
  const isArchivedChat = isArchivedTripGroup || isArchivedSupportLike;

  if (isActiveTripGroup) active += n;
  else if (isArchivedChat) archived += n;
}


    return { active, support, archived };
  }, [unreadCount, chats, tripsMap]);

  // ======= events (как на PC) =======
  useEffect(() => {
    function refetchOnFinish() {
      fetchChats();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("support-finish-updated", refetchOnFinish);
      return () => window.removeEventListener("support-finish-updated", refetchOnFinish);
    }
  }, [fetchChats]);

  // ✅ фикс: archive события — синхронизируем и notifications тоже (как в Desktop)
  useEffect(() => {
    function onArchived(e) {
      const id = e?.detail?.chatId;
      if (!id) return;

      setChats((prev) => prev.map((c) => (c.id === id ? { ...c, chat_type: "archived" } : c)));

      if (notifications?.setUnreadCount) notifications.setUnreadCount(id, 0);
      setUnreadCount((prev) => ({
        ...(prev || {}),
        [id]: 0,
      }));

      if (currentChat?.id === id) {
        setCurrentChat((prev) => (prev && prev.id === id ? { ...prev, chat_type: "archived" } : prev));
        setSelectedListChatId(null);
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("support-chat-archived", onArchived);
      return () => window.removeEventListener("support-chat-archived", onArchived);
    }
  }, [currentChat?.id, setChats, setUnreadCount]);


  // ======= dispute meta (как на PC) =======
  useEffect(() => {
    if (!currentChat) {
      setDisputeMeta(null);
      return;
    }

    if (currentChat.chat_type === "dispute") {
      loadDisputeMeta(currentChat.trip_id);
    } else {
      setDisputeMeta(null);
      if (disputeChannelRef.current) {
        supabase.removeChannel(disputeChannelRef.current);
        disputeChannelRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat?.id, currentChat?.chat_type, currentChat?.trip_id]);

  async function loadDisputeMeta(tripId) {
    if (!tripId) {
      setDisputeMeta(null);
      return;
    }

    const { data } = await supabase
      .from("disputes")
      .select("*")
      .eq("trip_id", tripId)
      .in("status", ["awaiting_moderator", "in_progress", "resolved"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    setDisputeMeta(data || null);

    if (disputeChannelRef.current) {
      supabase.removeChannel(disputeChannelRef.current);
      disputeChannelRef.current = null;
    }

    const ch = supabase
      .channel(`dispute_meta_${tripId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "disputes", filter: `trip_id=eq.${tripId}` },
        (payload) => {
          setDisputeMeta((prev) => {
            if (!prev || prev.id === payload.new.id) return payload.new;
            return prev;
          });
        }
      )
      .subscribe();

    disputeChannelRef.current = ch;
  }

  function toggleExpand(chatId, tripId, openNow) {
    setExpandedChats((prev) => {
      const next = new Set(prev);
      const shouldOpen = openNow ?? !next.has(chatId);
      if (shouldOpen) next.add(chatId);
      else next.delete(chatId);
      return next;
    });

    if (openNow !== false) {
      refreshAllDmUnread().catch(() => {});
    }
  }

  // ✅ общий помощник: тяжёлые действия после открытия чата — в фоне (как в Desktop)
const schedulePostOpenActions = useCallback(
  (openedChat) => {
    if (!openedChat?.id) return;

    // markAllRead — чуть позже, чтобы UI не блокировать
    setTimeout(async () => {
      try {
        await markAllMessagesAsRead(openedChat.id);
      } catch {}

      // ✅ ВАЖНО: dmUnread пересчитываем ПОСЛЕ markAll
      if (openedChat.trip_id) {
        refreshAllDmUnread().catch(() => {});
      }
    }, 350);

    if (openedChat.is_group && openedChat.trip_id) {
      fetchParticipantsForChat(openedChat);
    }
  },
  [markAllMessagesAsRead, fetchParticipantsForChat, refreshAllDmUnread]
);


  // ======= OPEN CHAT (как на PC по поведению, но с мобильным оверлеем) =======
  async function openChat(chatOrIntent) {
    // Вход из "ЛС" (участники/список DM)
    if (chatOrIntent?.__openDm) {
      const { tripId, userId: otherUserId, groupChatId } = chatOrIntent.__openDm;
      if (!user || !otherUserId || !tripId) return;

      const trip = tripsMap[tripId];
      const isTripArchived = trip?.status === "archived";

      const stableGroupId = groupChatId || groupChatIdByTrip[tripId];
      if (stableGroupId) setExpandedChats((prev) => new Set(prev).add(stableGroupId));
      setSelectedListChatId(null);

      // ищем существующий ЛС (включая archived)
      const { data: myPrivate } = await supabase
        .from("chat_participants")
        .select("chat_id, chats!inner(id, trip_id, chat_type, is_group)")
        .eq("user_id", user.id)
        .eq("chats.trip_id", tripId)
        .eq("chats.is_group", false)
        .in("chats.chat_type", ["trip_private", "archived"]);

      const myChatIds = myPrivate?.map((x) => x.chat_id).filter(Boolean) || [];
      let existingCommon = null;

      if (myChatIds.length) {
        const { data: theirInMy } = await supabase
          .from("chat_participants")
          .select("chat_id")
          .eq("user_id", otherUserId)
          .in("chat_id", myChatIds);

        if (theirInMy?.length) existingCommon = theirInMy[0].chat_id;
      }

      if (existingCommon) {
        const found = chats.find((c) => c.id === existingCommon);
        if (found) {
          setCurrentChat(found);
          setParticipantsVisible(false); // на мобилке не раскрываем состав сразу
          resetPagination();
          schedulePostOpenActions(found);
          if (typeof onChatOpen === "function") onChatOpen(true);
          return;
        }

        // если в state нет — подтянем минимум и добавим
        const { data: chatRows } = await supabase
          .from("chats")
          .select("id, title, chat_type, is_group, created_at, trip_id, moderator_id")
          .eq("id", existingCommon)
          .limit(1);

        if (chatRows?.[0]) {
          const c = chatRows[0];
          const { data: parts } = await supabase.from("chat_participants").select("chat_id, user_id").eq("chat_id", c.id);

          const merged = { ...c, participantsUserIds: (parts || []).map((p) => p.user_id) };
          setChats((prev) => (prev.some((x) => x.id === merged.id) ? prev : [merged, ...prev]));
          setCurrentChat(merged);
          setParticipantsVisible(false);
          resetPagination();
          schedulePostOpenActions(merged);
          if (typeof onChatOpen === "function") onChatOpen(true);
        }
        return;
      }

      // ⛔ архивная поездка — новые ЛС нельзя
      if (isTripArchived) {
        if (typeof window !== "undefined") {
          window.alert(
            "Для архивных поездок новые личные сообщения недоступны.\n" + "Можно только просматривать уже существующий диалог."
          );
        }
        return;
      }

      // создаём новый ЛС
      const { data: inserted, error: insErr } = await supabase
        .from("chats")
        .insert([{ trip_id: tripId, chat_type: "trip_private", is_group: false, title: null }])
        .select()
        .single();

      if (insErr || !inserted?.id) {
        console.error("Ошибка создания личного чата:", insErr);
        return;
      }

      const chatId = inserted.id;
      const { error: partsInsErr } = await supabase.from("chat_participants").insert([
        { chat_id: chatId, user_id: user.id },
        { chat_id: chatId, user_id: otherUserId },
      ]);

      if (partsInsErr) {
        console.error("Ошибка добавления участников в личный чат:", partsInsErr);
        return;
      }

      const newChat = { ...inserted, participantsUserIds: [user.id, otherUserId] };
      setChats((prev) => [newChat, ...prev]);
      setCurrentChat(newChat);
      setParticipantsVisible(false);
      resetPagination();
      schedulePostOpenActions(newChat);
      fetchChats().catch(() => {});
      if (typeof onChatOpen === "function") onChatOpen(true);
      return;
    }

    // клик по stub "Администрация сайта" — создать support-чат (как на PC)
    if (chatOrIntent?.id === "__support_stub__") {
      const ok = typeof window !== "undefined" ? window.confirm("Создать чат с поддержкой сайта?") : true;
      if (!ok) return;

      const { data: inserted, error: insErr } = await supabase
        .from("chats")
        .insert([{ chat_type: "support", is_group: false, title: null }])
        .select()
        .single();

      if (insErr || !inserted) {
        console.error("Ошибка создания support-чата:", insErr);
        return;
      }

      const chatId = inserted.id;

      const { error: partsErr } = await supabase.from("chat_participants").insert([{ chat_id: chatId, user_id: user.id }]);
      if (partsErr) {
        console.error("Ошибка добавления участника в support-чат:", partsErr);
        return;
      }

      await supabase.from("chat_messages").insert({
        chat_id: chatId,
        user_id: user.id,
        content: "Здравствуйте! Нужна помощь.",
        created_at: inserted.created_at,
        read: false,
      });

      await fetchChats();

      const opened = { ...inserted, participantsUserIds: [user.id] };
      setSelectedListChatId(chatId);
      setCurrentChat(opened);
      setParticipantsVisible(false);
      resetPagination();
      schedulePostOpenActions(opened);

      setTimeout(() => {
  const el = chatMessagesRef.current;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}, 200);
      if (typeof onChatOpen === "function") onChatOpen(true);
      return;
    }

    // обычное открытие чата из списка
    const chat = chatOrIntent;

    // подсветка только для не-trip_private
    if (chat?.chat_type !== "trip_private") setSelectedListChatId(chat.id);

    setCurrentChat(chat);
    setParticipantsVisible(false); // на мобилке по умолчанию состав скрыт
    resetPagination();
    schedulePostOpenActions(chat);

    if (typeof onChatOpen === "function") onChatOpen(true);
  }

  const handleBack = () => {
    setCurrentChat(null);
    setTimeout(() => {
      if (typeof onChatOpen === "function") onChatOpen(false);
    }, 300);
  };

  // Сплэш как на PC: только при первичной загрузке
  if (isLoading && !isChatsLoaded) {
    return <div className={styles.loading}>Загрузка...</div>;
  }

  // Блокировка ввода (как на PC)
  const inputBlocked =
    currentChat?.chat_type === "archived" ||
    (currentChat?.chat_type === "dispute" &&
      (disputeMeta?.locked || (disputeMeta?.initiator_confirmed && disputeMeta?.respondent_confirmed)));

  const inputBlockedText =
    currentChat?.chat_type === "archived"
      ? "Чат в архиве. Отправка сообщений недоступна."
      : "Стороны подтвердили завершение спора. Ожидается действие администратора. Отправка сообщений недоступна.";

// ✅ "реальный" тип текущего чата, даже если chat_type = archived
const effectiveCurrentType = (() => {
  if (!currentChat) return null;

  // если тип не archived — он и есть реальный
  if (currentChat.chat_type && currentChat.chat_type !== "archived") return currentChat.chat_type;

  // иначе пытаемся понять по признакам
  const t = String(currentChat._titleString || currentChat.title || "").toLowerCase();

  if (currentChat.moderator_id || t.includes("диспут")) return "dispute";
  if (
    currentChat.support_close_requested_at ||
    currentChat.support_close_confirmed ||
    t.includes("поддерж")
  )
    return "support";
  if (t.includes("реквиз") || t.includes("компани")) return "company_edit";

  return "archived";
})();


  // Мелкий UI для табов (без правок CSS — чтобы сразу завелось)
  // Мелкий UI для табов (без правок CSS — чтобы сразу завелось)
const TabButton = ({ id, label, count, unread = 0 }) => {
  const active = activeTab === id;
  const n = Number(unread || 0);
  const badge = n > 99 ? "99+" : String(n);

  return (
    <button
      type="button"
      onClick={() => setActiveTab(id)}
      style={{
        cursor: "pointer",
        border: "1px solid " + (active ? "#3b82f6" : "#e5e7eb"),
        background: active ? "#eff6ff" : "#fff",
        color: active ? "#1d4ed8" : "#111827",
        borderRadius: 999,
        padding: "8px 12px",
        fontSize: 13,
        fontWeight: 600,
        userSelect: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span>
        {label}
        {typeof count === "number" ? ` (${count})` : ""}
      </span>

      {n > 0 ? (
        <span
          title={`Непрочитанных: ${n}`}
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 6px",
            borderRadius: 999,
            background: "#ef4444",
            color: "#fff",
            fontSize: 11,
            fontWeight: 800,
            lineHeight: "18px",
            textAlign: "center",
          }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
};


  return (
    <div className={`${mobileStyles.container} ${triggerAnimation ? "fade-in" : ""}`}>
      {/* LIST */}
      <div className={mobileStyles.chatListContainer}>
        <div className={mobileStyles.header}>
          <span className={mobileStyles.chatTitleHeader}>Сообщения</span>
        </div>

<div
  className={mobileStyles.tabsRow}
  style={{
    padding: "8px 12px",
    display: "flex",
    gap: 8,
    flexWrap: "nowrap",         // ✅ одна линия
    overflowX: "auto",          // ✅ свайп влево/вправо
    overflowY: "hidden",
    WebkitOverflowScrolling: "touch",
    touchAction: "pan-x",       // ✅ не мешает вертикальному скроллу страницы
  }}
>
  <TabButton
    id="active"
    label="Активные"
    count={tabCounts?.active || 0}
    unread={unreadByTab?.active || 0}
  />
  <TabButton
    id="support"
    label="Поддержка"
    count={tabCounts?.support || 0}
    unread={unreadByTab?.support || 0}
  />
  <TabButton
    id="archived"
    label="Архив"
    count={tabCounts?.archived || 0}   // тут count не показываем (иконка), но можно оставить на будущее
    unread={unreadByTab?.archived || 0}
  />
</div>

        <div className={mobileStyles.searchBar}>
          <input
            type="text"
            placeholder="Поиск по чатам..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={mobileStyles.searchInput}
          />
        </div>

        <div className={mobileStyles.chatList}>
          {leftList.length > 0 ? (
            leftList.map((chat) => {
              const trip = chat.trip_id ? tripsMap[chat.trip_id] : null;
              const img =
                trip?.image_urls?.[0] ||
                (chat.chat_type === "support" || chat.chat_type === "company_edit" || chat.chat_type === "dispute"
                  ? "/default-travel-image.png"
                  : "/default-travel-image.png");

              const unread = (unreadCount || {})[chat.id] || 0;
              const isSelected = selectedListChatId === chat.id || currentChat?.id === chat.id;

              const canExpand =
                chat.is_group &&
                (chat.chat_type === "trip_group" || (chat.chat_type === "archived" && !!chat.trip_id));

              const expanded = expandedChats.has(chat.id);

              return (
                <div key={chat.id} style={{ width: "100%" }}>
                  <div
                    onClick={() => openChat(chat)}
                    className={`${mobileStyles.chatItem} ${unread > 0 ? mobileStyles.unreadChat : ""}`}
                    style={{
                      outline: isSelected ? "2px solid #111827" : "none",
                      outlineOffset: 2,
                      position: "relative",
                      overflow: "hidden",
                      paddingRight: canExpand ? 76 : undefined,
                    }}
                  >
                    <img src={img} alt="" className={mobileStyles.chatImage} />

                    <div className={mobileStyles.chatInfo} style={{ minWidth: 0 }}>
                      <div className={mobileStyles.chatTitleWrapper}>
                        {(() => {
  const s = chat._titleString || chat.title || `Чат ${chat.id}`;
  const isSupportLike =
    chat.chat_type === "support" ||
    chat.chat_type === "company_edit" ||
    chat.chat_type === "dispute";

  // ✅ Для поддержки — показываем полностью (без "…")
  if (isSupportLike) {
    return (
      <span
        className={mobileStyles.chatTitle}
        data-full-title={s}
        style={{
          whiteSpace: "normal",     // ✅ можно в 2 строки
          overflow: "visible",
          textOverflow: "clip",
          lineHeight: 1.2,
        }}
      >
        {s}
      </span>
    );
  }

  // ✅ Для остальных — оставляем как было (коротко)
  const max = 15;
  const cut = s.length > max ? s.slice(0, max) + "…" : s;

  return (
    <span className={mobileStyles.chatTitle} data-full-title={s}>
      {cut}
    </span>
  );
})()}

                      </div>

                      <div className={mobileStyles.chatUserInfo}>
                        {(() => {
                          const titleLower = String(chat._titleString || chat.title || "").toLowerCase();
                          const effectiveType =
                            chat.chat_type !== "archived"
                              ? chat.chat_type
                              : chat.moderator_id || titleLower.includes("диспут")
                              ? "dispute"
                              : chat.support_close_requested_at ||
                                chat.support_close_confirmed ||
                                titleLower.includes("поддерж")
                              ? "support"
                              : titleLower.includes("реквиз") || titleLower.includes("компани")
                              ? "company_edit"
                              : "archived";

                          const isArchivedSupportLike = chat.chat_type === "archived" && !chat.is_group && !chat.trip_id;

                          if (chat.is_group) return `Участников: ${(chat.participantsUserIds || []).length}`;
                          if (effectiveType === "support" || effectiveType === "dispute" || isArchivedSupportLike) return "Чат поддержки";
                          if (effectiveType === "company_edit") return "Редактирование компании";
                          return "Чат поддержки";
                        })()}
                      </div>
                    </div>

                    {/* 1) Бейдж непрочитанных ГРУППОВОГО чата */}
                    {/* ✅ Бейдж непрочитанных (группы + поддержка тоже) */}
{unread > 0 ? (
  <span
    className={mobileStyles.unreadBadge}
    style={{
      position: "absolute",
      top: 6,
      right: canExpand ? 84 : 10,
      zIndex: 3,
    }}
    title="Непрочитанные в чате"
  >
    {unread}
  </span>
) : null}

                    {/* 2) Правый “отрезанный” блок Состав */}
                    {canExpand ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleExpand(chat.id, chat.trip_id);
                        }}
                        title="Состав"
                        style={{
                          position: "absolute",
                          top: 0,
                          right: 0,
                          height: "100%",
                          width: 76,
                          border: "none",
                          borderLeft: "1px solid #e5e7eb",
                          background: "#fff",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          padding: "6px 8px",
                          overflow: "hidden",
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>Состав</div>
                        <div style={{ fontSize: 36, lineHeight: 1 }}>{expanded ? "▴" : "▾"}</div>

                        {/* красная точка (небольшая) */}
                        {(() => {
                          const dmUnreadMap = dmUnreadByTrip?.[chat.trip_id] || {};
                          const dmUnreadSum = Object.values(dmUnreadMap).reduce((a, b) => a + b, 0);
                          return dmUnreadSum > 0 ? (
                            <span
                              title="Есть непрочитанные ЛС"
                              style={{
                                position: "absolute",
                                right: 10,
                                bottom: 8,
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: "#ef4444",
                              }}
                            />
                          ) : null;
                        })()}
                      </button>
                    ) : null}
                  </div>

                  {/* Состав + ЛС под групповым чатом */}
                  {canExpand && expanded ? (
                    <div style={{ padding: "6px 10px 10px 56px" }}>
                      {(() => {
                        const organizerId = chat?.trip_id ? tripsMap?.[chat.trip_id]?.creator_id : null;
                        const dmUnreadMap = dmUnreadByTrip?.[chat.trip_id] || {};

                        const participantsProfiles = (chat?.participantsUserIds || [])
                          .map((id) => profilesMap?.[id])
                          .filter(Boolean)
                          .sort((a, b) => {
                            if (a.user_id === organizerId) return -1;
                            if (b.user_id === organizerId) return 1;
                            const an = `${a.last_name || ""} ${a.first_name || ""}`.trim().toLowerCase();
                            const bn = `${b.last_name || ""} ${b.first_name || ""}`.trim().toLowerCase();
                            return an.localeCompare(bn, "ru");
                          });

                        if (!participantsProfiles.length) {
                          return <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 10 }}>Участников нет.</div>;
                        }

                        return (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Участники</div>

                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {participantsProfiles.map((p) => {
                                const isMe = p.user_id === user?.id;
                                const isOrg = organizerId && p.user_id === organizerId;

                                const isDispute = chat?.chat_type === "dispute";
                                const isAdminModerator =
                                  isDispute && chat?.moderator_id && p.user_id === chat.moderator_id;

                                const displayName = isAdminModerator
                                  ? "Администрация сайта"
                                  : `${p.first_name || ""} ${p.last_name || ""}`.trim() || "Пользователь";

                                const roleLabel = isOrg ? "Организатор" : isAdminModerator ? "Администратор" : "Участник";

const titleLower = String(chat?._titleString || chat?.title || "").toLowerCase();

const effectiveType =
  chat?.chat_type !== "archived"
    ? chat?.chat_type
    : (chat?.moderator_id || titleLower.includes("диспут"))
    ? "dispute"
    : (chat?.support_close_requested_at ||
       chat?.support_close_confirmed ||
       titleLower.includes("поддерж"))
    ? "support"
    : (titleLower.includes("реквиз") || titleLower.includes("компани"))
    ? "company_edit"
    : "archived";

const isNoPmChat = ["dispute", "support", "company_edit"].includes(effectiveType);
const canPm = !isMe && !isNoPmChat;

                                const dmUnread = dmUnreadMap?.[p.user_id] || 0;

                                return (
                                  <div
                                    key={p.user_id}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 10,
                                      border: "1px solid #e5e7eb",
                                      borderRadius: 12,
                                      padding: "8px 10px",
                                      background: "#fff",
                                    }}
                                  >
                                    <img
                                      src={p.avatar_url || "/avatar-default.svg"}
                                      alt=""
                                      style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }}
                                    />

                                    <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                                      <div
                                        style={{
                                          fontSize: 13,
                                          fontWeight: 600,
                                          lineHeight: 1.2,
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          maxWidth: 220,
                                        }}
                                        title={displayName}
                                      >
                                        {displayName}
                                      </div>

                                      <div style={{ marginTop: 4 }}>
                                        <span
                                          style={{
                                            fontSize: 11,
                                            padding: "2px 8px",
                                            borderRadius: 999,
                                            border: "1px solid " + (isOrg ? "#f59e0b" : "#e5e7eb"),
                                            background: isOrg ? "#fff7ed" : "#f8fafc",
                                            color: "#111827",
                                          }}
                                          title={roleLabel}
                                        >
                                          {roleLabel}
                                        </span>
                                      </div>
                                    </div>

                                    {canPm ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          openChat({
                                            __openDm: {
                                              tripId: chat.trip_id,
                                              userId: p.user_id,
                                              groupChatId: groupChatIdByTrip[chat.trip_id] || chat.id,
                                            },
                                          })
                                        }
                                        style={{
                                          marginLeft: "auto",
                                          border: "1px solid #e5e7eb",
                                          borderRadius: 10,
                                          background: "#fff",
                                          cursor: "pointer",
                                          width: 44,
                                          height: 32,
                                          padding: 0,
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                        }}
                                        title="Личное сообщение"
                                        aria-label="Личное сообщение"
                                      >
                                        {(() => {
                                          const n = dmUnread || 0;
                                          const label = n > 99 ? "99+" : String(n);

                                          return (
                                            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                                              <path
                                                d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
                                                fill={n > 0 ? "#ef4444" : "none"}
                                                stroke={n > 0 ? "#ef4444" : "#9ca3af"}
                                                strokeWidth="2"
                                                strokeLinejoin="round"
                                              />
                                              {n > 0 ? (
                                                <text
                                                  x="12"
                                                  y="13"
                                                  textAnchor="middle"
                                                  dominantBaseline="middle"
                                                  fontSize={label.length >= 3 ? "7" : "9"}
                                                  fontWeight="700"
                                                  fill="#ffffff"
                                                >
                                                  {label}
                                                </text>
                                              ) : null}
                                            </svg>
                                          );
                                        })()}
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className={mobileStyles.noChatSelected}>Нет чатов для отображения</div>
          )}
        </div>
      </div>

      {/* CHAT VIEW (оверлей) */}
      <div className={`${mobileStyles.chatViewContainer} ${currentChat ? mobileStyles.active : ""}`}>
        {currentChat ? (
          <>
            <div className={mobileStyles.header} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={handleBack} className={mobileStyles.backButton}>
                Назад
              </button>
            </div>

            <ChatHeader
              currentChat={currentChat}
              tripsMap={tripsMap}
              profilesMap={profilesMap}
              myUserId={user?.id}
              titleString={renderChatTitle(currentChat, tripsMap, profilesMap, user?.id)}
              participantsVisible={participantsVisible}
              setParticipantsVisible={setParticipantsVisible}
              styles={styles}
            />

            {/* Состав (раскрывается кнопкой в ChatHeader) */}
            {currentChat?.is_group && participantsVisible && (
              <div style={{ borderTop: "1px solid #eee", padding: 10 }}>
                {participantsLoading ? (
                  <div style={{ padding: 8, opacity: 0.7 }}>Загрузка участников…</div>
                ) : participantsForCurrentChat.length ? (
                  <div
                    style={{
                      maxHeight: 240,
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      paddingRight: 4,
                    }}
                  >
                    {participantsForCurrentChat.map((p) => {
                      const organizerId = currentChat?.trip_id ? tripsMap[currentChat.trip_id]?.creator_id : null;
                      const isOrg = p.user_id === organizerId;
                      const isMe = p.user_id === user?.id;

                      const dmUnreadMap = dmUnreadByTrip?.[currentChat?.trip_id] || {};
                      const dmUnread = dmUnreadMap?.[p.user_id] || 0;

                      const displayName =
                        currentChat?.chat_type === "dispute" && currentChat?.moderator_id === p.user_id
                          ? "Администрация сайта"
                          : `${p.first_name || ""} ${p.last_name || ""}`.trim() || "Пользователь";

                      return (
                        <div
                          key={p.user_id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            border: isOrg ? "1px solid #f59e0b" : "1px solid #eee",
                            borderRadius: 12,
                            padding: "8px 10px",
                            background: isOrg ? "#fff7ed" : "#fafafa",
                            minWidth: 0,
                          }}
                          title={isOrg ? "Организатор" : "Участник"}
                        >
                          <img
                            src={p.avatar_url || "/avatar-default.svg"}
                            alt=""
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: "50%",
                              objectFit: "cover",
                              flex: "0 0 auto",
                            }}
                          />

                          <span
                            style={{
                              fontSize: 14,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                            title={displayName}
                          >
                            {displayName}
                          </span>

                          {/* В диспутах ЛС запрещены */}
                          {!isMe && !["dispute", "support", "company_edit"].includes(effectiveCurrentType) && (
                            <button
                              type="button"
                              onClick={() =>
                                openChat({
                                  __openDm: {
                                    tripId: currentChat.trip_id,
                                    userId: p.user_id,
                                    groupChatId: groupChatIdByTrip[currentChat.trip_id] || currentChat.id,
                                  },
                                })
                              }
                              style={{
                                marginLeft: "auto",
                                border: "1px solid #e5e7eb",
                                borderRadius: 10,
                                background: "#fff",
                                cursor: "pointer",
                                width: 44,
                                height: 32,
                                padding: 0,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flex: "0 0 auto",
                              }}
                              title="Личное сообщение"
                              aria-label="Личное сообщение"
                            >
                              {(() => {
                                const n = dmUnread || 0;
                                const label = n > 99 ? "99+" : String(n);

                                return (
                                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                                    <path
                                      d="M21 12c0 4.418-4.03 8-9 8a10.6 10.6 0 0 1-3.61-.62L3 21l1.78-4.12A7.62 7.62 0 0 1 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z"
                                      fill={n > 0 ? "#ef4444" : "none"}
                                      stroke={n > 0 ? "#ef4444" : "#9ca3af"}
                                      strokeWidth="2"
                                      strokeLinejoin="round"
                                    />
                                    {n > 0 ? (
                                      <text
                                        x="12"
                                        y="13"
                                        textAnchor="middle"
                                        dominantBaseline="middle"
                                        fontSize={label.length >= 3 ? "7" : "9"}
                                        fontWeight="700"
                                        fill="#ffffff"
                                      >
                                        {label}
                                      </text>
                                    ) : null}
                                  </svg>
                                );
                              })()}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ padding: 8, opacity: 0.7 }}>Участников нет</div>
                )}
              </div>
            )}

            <MessageList
              messages={messages}
              profilesMap={profilesMap}
              currentChat={currentChat}
              myUserId={user?.id}
              signFileUrl={signFileUrl}
              chatMessagesRef={chatMessagesRef}
              messagesEndRef={messagesEndRef}
              styles={styles}
              disputeMeta={disputeMeta}
              isMobileUI={true}
            />

            {inputBlocked ? (
              <div
                style={{
                  padding: "10px 16px",
                  borderTop: "1px solid #e5e7eb",
                  background: "#fff",
                  fontSize: 14,
                  opacity: 0.85,
                }}
              >
                {inputBlockedText}
              </div>
            ) : (
              <div className={hideSidebar ? mobileStyles.sidebarHidden : ""}>
                <MessageComposer
  styles={styles}               // ✅ ВАЖНО
  currentChat={currentChat}     // ✅ ВАЖНО
  myUserId={user?.id}

                  isUploading={isUploading}
                  pendingFiles={pendingFiles}
                  onPickFiles={onPickFiles}
                  addPendingFiles={addPendingFiles}
                  removePending={removePending}
sendWithMessage={async ({ chatId, tripId, userId, text, files }) => {
  const result = await sendWithMessage({ chatId, tripId, userId, text, files });
  if (!result) return null;

  const { message, files: saved } = result;

setMessages((prev) => {
  const msgId = String(message.id);
  const incoming = Array.isArray(saved) ? saved : [];

  const idx = prev.findIndex((m) => String(m.id) === msgId);

  // если сообщения ещё нет — добавляем
  if (idx === -1) {
    return [...prev, { ...message, chat_message_files: incoming }];
  }

  // если уже есть (пришло через realtime) — мержим файлы
  const cur = prev[idx];
  const mergedFiles = dedupeFiles([...(cur.chat_message_files || []), ...incoming]);

  const next = prev.slice();
  next[idx] = { ...cur, ...message, chat_message_files: mergedFiles };
  return next;
});

  requestAnimationFrame(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });

  return result;
}}
onMessageSent={({ message, files }) => {
setMessages((prev) => {
  const msgId = String(message.id);
  const incoming = Array.isArray(files) ? files : [];

  const idx = prev.findIndex((m) => String(m.id) === msgId);

  if (idx === -1) {
    return [...prev, { ...message, chat_message_files: incoming }];
  }

  const cur = prev[idx];
  const mergedFiles = dedupeFiles([...(cur.chat_message_files || []), ...incoming]);

  const next = prev.slice();
  next[idx] = { ...cur, ...message, chat_message_files: mergedFiles };
  return next;
});


  requestAnimationFrame(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}}
                />
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
