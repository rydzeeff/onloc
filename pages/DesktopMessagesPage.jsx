// pages/DesktopMessagesPage.jsx
import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { notifications } from "./_app";

import commonStyles from "../styles/messages-common.module.css";
import desktopStyles from "../styles/messages-desktop.module.css";
const styles = { ...commonStyles, ...desktopStyles };

import { useChatAttachments } from "../hooks/useChatAttachments";

import { useChats } from "../features/messages/hooks/useChats";
import { useDmUnread } from "../features/messages/hooks/useDmUnread";
import { useMessagesRealtime } from "../features/messages/hooks/useMessagesRealtime";

import ChatTabsAndSearch from "../features/messages/desktop/ChatTabsAndSearch";
import ChatList from "../features/messages/desktop/ChatList";
import ChatHeader from "../features/messages/desktop/ChatHeader";
import MessageList from "../features/messages/desktop/MessageList";
import MessageComposer from "../features/messages/desktop/MessageComposer";

import { renderChatTitle, dedupeFiles } from "../features/messages/utils/chatUtils";

export default function DesktopMessagesPage({ user, triggerAnimation }) {
  const [activeTab, setActiveTab] = useState("active");
  const [search, setSearch] = useState("");
  const [currentChat, setCurrentChat] = useState(null);

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

  // Какая ячейка слева подсвечена
  const [selectedListChatId, setSelectedListChatId] = useState(null);

  const [expandedChats, setExpandedChats] = useState(new Set());
  const [dmHighlightMap, setDmHighlightMap] = useState({});
  const [participantsVisible, setParticipantsVisible] = useState(false);

  // Метаданные диспута (для двухстороннего подтверждения / блокировки ввода)
  const [disputeMeta, setDisputeMeta] = useState(null);
  const disputeChannelRef = useRef(null);

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

  // Realtime по составу участников чатов
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`chat_participants_watch_${user.id}`)
      // Новый участник добавлен в чат
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_participants" },
        async (payload) => {
          const row = payload.new;
          if (!row?.chat_id || !row?.user_id) return;

          // 1) Обновляем participantsUserIds в массиве чатов
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

          // 2) Обновляем currentChat.participantsUserIds
          setCurrentChat((prev) => {
            if (!prev || prev.id !== row.chat_id) return prev;
            const ids = prev.participantsUserIds || [];
            if (ids.includes(row.user_id)) return prev;
            return { ...prev, participantsUserIds: [...ids, row.user_id] };
          });

          // 3) Перечитываем чаты, чтобы обновить profilesMap
          await fetchChats();

          // 4) Если открыт этот групповой чат — обновляем правую панель участников
          if (currentChat && currentChat.id === row.chat_id && currentChat.is_group) {
            fetchParticipantsForChat(currentChat);
          }
        }
      )
      // Участника удалили из чата
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "chat_participants" },
        async (payload) => {
          const row = payload.old;
          if (!row?.chat_id || !row?.user_id) return;

          // 1) Убираем из participantsUserIds в chats
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

          // 2) Убираем из currentChat.participantsUserIds
          setCurrentChat((prev) => {
            if (!prev || prev.id !== row.chat_id) return prev;
            const idsOld = prev.participantsUserIds || [];
            const ids = idsOld.filter((id) => id !== row.user_id);
            if (ids.length === idsOld.length) return prev;
            return { ...prev, participantsUserIds: ids };
          });

          // 3) Перечитываем чаты
          await fetchChats();

          // 4) Обновляем правую панель, если открыт этот чат
          if (currentChat && currentChat.id === row.chat_id && currentChat.is_group) {
            fetchParticipantsForChat(currentChat);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    user?.id,
    currentChat?.id,
    currentChat?.is_group,
    setChats,
    fetchChats,
    fetchParticipantsForChat,
  ]);

  const {
    pendingFiles,
    isUploading,
    onPickFiles,
    removePending,
    addPendingFiles,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  } = useChatAttachments({ supabase, bucket: "trip_chat_files" });

const { dmUnreadByTrip, refreshAllDmUnread, unreadCount, setUnreadCount, updateUnreadCount } =
  useDmUnread({ supabase, user, isChatsLoaded, notifications, currentChatId: currentChat?.id });


  const {
    messages,
    setMessages,
    chatMessagesRef,
    messagesEndRef,
    fetchMessages,
    markAllMessagesAsRead,
    resetPagination,
  } = useMessagesRealtime({
    supabase,
    user,
    currentChat,
    preloadSignedUrlsForMessages,
    signFileUrl,
    notifications,
    updateUnreadCount,
  });

  // карта: trip_id -> id группового чата (для корректного groupChatId при открытии ЛС из любого места)
  const groupChatIdByTrip = useMemo(() => {
    const m = {};
    for (const c of chats) {
      if (c && c.is_group && c.trip_id) {
        // ✅ групповой чат поездки может быть trip_group или archived
        if (c.chat_type === "trip_group" || c.chat_type === "archived") {
          m[c.trip_id] = c.id;
        }
      }
    }
    return m;
  }, [chats]);

  // Сбрасываем подсветки ЛС только при переходе в НЕ trip_private
  const prevChatIdRef = useRef(null);
  useEffect(() => {
    const prev = prevChatIdRef.current;
    const now = currentChat?.id || null;
    if (prev && now && now !== prev) {
      if (currentChat?.chat_type !== "trip_private") {
        setDmHighlightMap({});
      }
    }
    prevChatIdRef.current = now;
  }, [currentChat?.id, currentChat?.chat_type]);

  // ВКЛАДКИ: «Поддержка» включает support | dispute | company_edit
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

      return isArchivedTripGroup || isArchivedSupportLike;
    }

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
    return chatsWithTitles
      .filter(chatMatchesTab)
      .filter((c) => (c._titleString || "").toLowerCase().includes(q));
  }, [chatsWithTitles, search, activeTab]);

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

  const tabCounts = useMemo(() => {
    let active = 0,
      support = 0,
      archived = 0;

    for (const chat of chats) {
      const tripStatus = chat.trip_id ? tripsMap[chat.trip_id]?.status || null : null;

      if (chat.chat_type === "support" || chat.chat_type === "dispute" || chat.chat_type === "company_edit") {
        support++;
        continue;
      }

      const isActiveTripGroup = chat.is_group && chat.chat_type === "trip_group" && tripStatus !== "archived";

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

  const unreadByTab = useMemo(() => {
    const byId = unreadCount || {};
    let active = 0,
      support = 0,
      archived = 0;

    for (const c of chats) {
      const n = byId[c.id] || 0;
      if (!n) continue;

      const tripStatus = c.trip_id ? tripsMap[c.trip_id]?.status || null : null;

      if (c.chat_type === "support" || c.chat_type === "dispute" || c.chat_type === "company_edit") {
        support += n;
        continue;
      }

      if (!c.trip_id) {
        if (c.chat_type === "archived") archived += n;
        else active += n;
        continue;
      }

      const tripIsArchived = tripStatus === "archived";
      if (tripIsArchived) {
        archived += n;
        continue;
      }

      if (c.is_group && c.chat_type === "trip_group") {
        active += n;
        continue;
      }

      if (!c.is_group && c.trip_id) {
        if (c.chat_type === "archived") archived += n;
        else active += n;
        continue;
      }

      active += n;
    }

    return { active, support, archived };
  }, [unreadCount, chats, tripsMap]);

  // после «Да/Нет» в саппорте перезагружаем список
  useEffect(() => {
    function refetchOnFinish() {
      fetchChats();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("support-finish-updated", refetchOnFinish);
      return () => window.removeEventListener("support-finish-updated", refetchOnFinish);
    }
  }, [fetchChats]);

  // ✅ фикс: при archive события — синхронизируем и notifications тоже (а не только локальный setUnreadCount)
  useEffect(() => {
    function onArchived(e) {
      const id = e?.detail?.chatId;
      if (!id) return;

      setChats((prev) => prev.map((c) => (c.id === id ? { ...c, chat_type: "archived" } : c)));

      // ✅ authoritative: используем notifications.setUnreadCount, чтобы общий state был консистентен
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

  function toggleExpand(chatId, tripId, openNow) {
    setExpandedChats((prev) => {
      const next = new Set(prev);
      const shouldOpen = openNow ?? !next.has(chatId);
      if (shouldOpen) next.add(chatId);
      else next.delete(chatId);
      return next;
    });

    if (openNow !== false) refreshAllDmUnread().catch(() => {});
  }

  // ===== Реалтайм для красной точки «Поддержка», даже если открыта вкладка «Активные»
  const supportIdsKey = useMemo(
    () =>
      chats
        .filter((c) => c.chat_type === "support" || c.chat_type === "dispute" || c.chat_type === "company_edit")
        .map((c) => c.id)
        .sort()
        .join(","),
    [chats]
  );

  // ✅ улучшение: при support-инсертах тоже синхронизируем notifications.setUnreadCount, иначе title/общая сумма может не обновиться
  useEffect(() => {
    if (!user?.id) return;
    if (activeTab === "support") return;

    const supportIds = supportIdsKey ? supportIdsKey.split(",").filter(Boolean) : [];
    if (!supportIds.length) return;

    const channel = supabase
      .channel(`support_unread_${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
        const chatId = payload.new?.chat_id;
        if (!chatId || !supportIds.includes(chatId)) return;
        if (payload.new.user_id === user.id) return;
        if (currentChat?.id === chatId) return;

        // локально + глобально
        setUnreadCount((prev) => {
          const next = { ...(prev || {}) };
          next[chatId] = (next[chatId] || 0) + 1;
          if (notifications?.setUnreadCount) notifications.setUnreadCount(chatId, next[chatId]);
          return next;
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, activeTab, supportIdsKey, currentChat?.id]);

  // ====== Загрузка и подписка на метаданные ДИСПУТА для текущего чата
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

  // ✅ общий помощник: тяжёлые действия после открытия чата — в фоне (без await)
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


  async function openChat(chatOrIntent) {
    // ===== из «Состава»: открыть/создать ЛС
    if (chatOrIntent?.__openDm) {
      const { tripId, userId: otherUserId, groupChatId } = chatOrIntent.__openDm;
      if (!user || !otherUserId || !tripId) return;

      const trip = tripsMap[tripId];
      const isTripArchived = trip?.status === "archived";

      const stableGroupId = groupChatId || groupChatIdByTrip[tripId];
      if (stableGroupId) setExpandedChats((prev) => new Set(prev).add(stableGroupId));
      setSelectedListChatId(null);
      setDmHighlightMap(stableGroupId ? { [stableGroupId]: otherUserId } : {});

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
          resetPagination();
          schedulePostOpenActions(found);
          return;
        }

        const { data: chatRows } = await supabase
          .from("chats")
          .select("id, title, chat_type, is_group, created_at, trip_id, moderator_id")
          .eq("id", existingCommon)
          .limit(1);

        if (chatRows?.[0]) {
          const c = chatRows[0];
          const { data: parts } = await supabase
            .from("chat_participants")
            .select("chat_id, user_id")
            .eq("chat_id", c.id);

          const merged = { ...c, participantsUserIds: (parts || []).map((p) => p.user_id) };
          setChats((prev) => (prev.some((x) => x.id === merged.id) ? prev : [merged, ...prev]));
          setCurrentChat(merged);
          resetPagination();
          schedulePostOpenActions(merged);
        }
        return;
      }

      // ⛔ архивная поездка — новые ЛС нельзя
      if (isTripArchived) {
        if (typeof window !== "undefined") {
          window.alert(
            "Для архивных поездок новые личные сообщения недоступны.\n" +
              "Можно только просматривать уже существующий диалог."
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
      resetPagination();
      schedulePostOpenActions(newChat);

      fetchChats().catch(() => {});
      return;
    }

    // ===== клик по виртуальной «Администрации сайта» — создать support-чат
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

      const { error: partsErr } = await supabase
        .from("chat_participants")
        .insert([{ chat_id: chatId, user_id: user.id }]);

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
      resetPagination();
      setCurrentChat(opened);
      schedulePostOpenActions(opened);

      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
      return;
    }

    // ===== обычное открытие чата из левого списка
    const chat = chatOrIntent;

    if (chat?.chat_type !== "trip_private") {
      setSelectedListChatId(chat.id);
    }

    resetPagination();
    setCurrentChat(chat);
    schedulePostOpenActions(chat);
  }

  // Сплэш "Загрузка..." показываем только при первичном получении чатов.
  if (isLoading && !isChatsLoaded) {
    return <div className={styles.loading}>Загрузка...</div>;
  }

  return (
    <div className={`${styles.container} ${triggerAnimation ? styles["fade-in"] : ""}`}>
      {/* LEFT */}
      <div className={styles.leftPanel} style={{ flex: "0 0 370px", flexShrink: 0 }}>
        <ChatTabsAndSearch
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          search={search}
          setSearch={setSearch}
          tabCounts={tabCounts}
          unreadByTab={unreadByTab}
          styles={styles}
          commonStyles={commonStyles}
        />

        <ChatList
          filteredChats={leftList}
          tripsMap={tripsMap}
          profilesMap={profilesMap}
          unreadCount={unreadCount}
          currentChat={currentChat}
          selectedListChatId={selectedListChatId}
          expandedChats={expandedChats}
          dmUnreadByTrip={dmUnreadByTrip}
          dmHighlightMap={dmHighlightMap}
          setDmHighlightMap={setDmHighlightMap}
          myUserId={user.id}
          onOpenChat={openChat}
          onToggleExpand={toggleExpand}
          styles={styles}
  // ✅ NEW
  titleMaxChars={25}
  footerUnreadMode="dot"
  chevronSize={26}
        />
      </div>

      {/* RIGHT */}
      <div className={styles.rightPanel} style={{ minWidth: 0 }}>
        {currentChat ? (
          <>
            <ChatHeader
              currentChat={currentChat}
              tripsMap={tripsMap}
              profilesMap={profilesMap}
              myUserId={user.id}
              titleString={renderChatTitle(currentChat, tripsMap, profilesMap, user.id)}
              participantsVisible={participantsVisible}
              setParticipantsVisible={setParticipantsVisible}
              styles={styles}
            />

            {/* Состав участников (только для групповых чатов) */}
            {currentChat?.is_group && participantsVisible && (
              <div style={{ borderTop: "1px solid #eee", padding: 10 }}>
                {participantsLoading ? (
                  <div style={{ padding: 8, opacity: 0.7 }}>Загрузка участников…</div>
                ) : participantsForCurrentChat.length ? (
                  <div
                    style={{
                      maxHeight: 240,
                      overflowY: "auto",
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                      gap: 10,
                      paddingRight: 4,
                    }}
                  >
                    {participantsForCurrentChat.map((p) => {
                      const organizerId = currentChat?.trip_id ? tripsMap[currentChat.trip_id]?.creator_id : null;
                      const isOrg = p.user_id === organizerId;
                      const isMe = p.user_id === user.id;

                      const displayName =
                        currentChat?.chat_type === "dispute" && currentChat?.moderator_id === p.user_id
                          ? "Администрация сайта"
                          : (p.first_name || "") + " " + (p.last_name || "");

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
                          {!isMe && !["dispute", "support", "company_edit"].includes(currentChat?.chat_type) && (
                            <button
                              onClick={() =>
                                openChat({
                                  __openDm: {
                                    tripId: currentChat.trip_id,
                                    userId: p.user_id,
                                    groupChatId: groupChatIdByTrip[currentChat.trip_id],
                                  },
                                })
                              }
                              style={{
                                marginLeft: 6,
                                border: "1px solid #e5e7eb",
                                borderRadius: 8,
                                padding: "6px 10px",
                                cursor: "pointer",
                                background: "white",
                                flex: "0 0 auto",
                              }}
                              title="ЛС"
                              type="button"
                            >
                              ЛС
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
              myUserId={user.id}
              signFileUrl={signFileUrl}
              chatMessagesRef={chatMessagesRef}
              messagesEndRef={messagesEndRef}
              styles={styles}
              disputeMeta={disputeMeta}
            />

            {/* В архивные и "залоченные" диспуты писать нельзя */}
            {currentChat.chat_type === "archived" ||
            (currentChat.chat_type === "dispute" &&
              (disputeMeta?.locked || (disputeMeta?.initiator_confirmed && disputeMeta?.respondent_confirmed))) ? (
              <div
                style={{
                  padding: "10px 16px",
                  borderTop: "1px solid #e5e7eb",
                  background: "#fff",
                  fontSize: 14,
                  opacity: 0.8,
                }}
              >
                {currentChat.chat_type === "archived"
                  ? "Чат в архиве. Отправка сообщений недоступна."
                  : "Стороны подтвердили завершение спора. Ожидается действие администратора. Отправка сообщений недоступна."}
              </div>
            ) : (
              <MessageComposer
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

  // если уже есть (пришло через realtime) — МЕРЖИМ файлы
  const cur = prev[idx];
  const mergedFiles = dedupeFiles([...(cur.chat_message_files || []), ...incoming]);

  const next = prev.slice();
  next[idx] = { ...cur, ...message, chat_message_files: mergedFiles };
  return next;
});

                  setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
                  return result;
                }}
                currentChat={currentChat}
                myUserId={user.id}
                styles={styles}
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
                  setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
                }}
              />
            )}
          </>
        ) : (
          <div className={styles.noChatSelected}>Выберите чат слева</div>
        )}
      </div>
    </div>
  );
}
