// features/messages/hooks/useDmUnread.js
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Непрочитанные в ДМ (trip_private + archived DMs):
 * - refreshAllDmUnread: собираем DM chat_ids и одним RPC получаем counts по всем chat_id
 * - realtime: на INSERT в chat_messages:
 *   - локально инкрементим dmUnreadByTrip + unreadCount (мгновенно)
 *   - RPC пересчёт бейджа делаем ДЕБАУНСОМ (чтобы не дергать RPC на каждое сообщение)
 *
 * ВАЖНО:
 * - в realtime НЕ используем filter user_id=neq... (может быть нестабилен), фильтруем в JS
 * - НЕ мутируем notifications.unreadCounts напрямую (используем notifications.setUnreadCount)
 */
export function useDmUnread({ supabase, user, isChatsLoaded, notifications, currentChatId }) {
  const [dmUnreadByTrip, setDmUnreadByTrip] = useState({});
  const [unreadCount, setUnreadCount] = useState(notifications.unreadCounts || {});

  // { chat_id: { trip_id, otherId } }
  const dmIndexByChatIdRef = useRef({});
  const channelRef = useRef(null);

// текущий открытый чат (чтобы не накидывать unread, когда мы уже внутри)
const currentChatIdRef = useRef(null);
// ✅ синхронно, без окна гонки
currentChatIdRef.current = currentChatId || null;


  // дебаунс по RPC пересчёту бейджа на конкретный чат
  const unreadRpcTimersRef = useRef(new Map()); // chatId -> timeoutId
  const unreadRpcInFlightRef = useRef(new Set()); // chatIds currently calling RPC

  const clearAllRpcTimers = useCallback(() => {
    for (const t of unreadRpcTimersRef.current.values()) clearTimeout(t);
    unreadRpcTimersRef.current.clear();
  }, []);

  // --- helpers: safe notifications update ---
  const setUnreadCountLocal = useCallback(
    (chatId, n) => {
      if (!chatId) return;
      // 1) global notifications (чтобы бейджи/тайтл везде синхронизировались)
      if (notifications?.setUnreadCount) {
        notifications.setUnreadCount(chatId, n);
      }
      // 2) локальный стейт (на всякий, чтобы компонент сразу перерендерился)
      setUnreadCount((prev) => ({ ...(prev || {}), [chatId]: n }));
    },
    [notifications]
  );

  // --- RPC: bulk counts for many chats ---
  const getUnreadCountsBulk = useCallback(
    async (chatIds) => {
      if (!user?.id) return {};
      const ids = Array.from(new Set((chatIds || []).filter(Boolean)));
      if (!ids.length) return {};

      const { data: rows, error } = await supabase.rpc("get_unread_counts_for_chats", {
        p_chat_ids: ids,
        p_user_id: user.id,
      });

      if (error) {
        console.error("DM unread: get_unread_counts_for_chats failed", error);
        return {};
      }

      const out = {};
      (rows || []).forEach((r) => {
        if (!r?.chat_id) return;
        out[r.chat_id] = Number(r.unread_count || 0);
      });
      return out;
    },
    [supabase, user?.id]
  );

  // --- updateUnreadCount: single chat via same RPC (array of 1) ---
  const updateUnreadCount = useCallback(
    async (chatId) => {
      if (!chatId || !user?.id) return;

      // защита от параллельных дублей
      if (unreadRpcInFlightRef.current.has(chatId)) return;
      unreadRpcInFlightRef.current.add(chatId);

      try {
        const { data: rows, error } = await supabase.rpc("get_unread_counts_for_chats", {
          p_chat_ids: [chatId],
          p_user_id: user.id,
        });
        if (error) return;

        const n = Number(rows?.[0]?.unread_count || 0);
        setUnreadCountLocal(chatId, n);
      } finally {
        unreadRpcInFlightRef.current.delete(chatId);
      }
    },
    [supabase, user?.id, setUnreadCountLocal]
  );

  // --- debounced updateUnreadCount (for realtime bursts) ---
  const updateUnreadCountDebounced = useCallback(
    (chatId, delayMs = 350) => {
      if (!chatId) return;

      const prev = unreadRpcTimersRef.current.get(chatId);
      if (prev) clearTimeout(prev);

      const t = setTimeout(() => {
        unreadRpcTimersRef.current.delete(chatId);
        updateUnreadCount(chatId).catch(() => {});
      }, delayMs);

      unreadRpcTimersRef.current.set(chatId, t);
    },
    [updateUnreadCount]
  );

  // --- refreshAllDmUnread ---
  const refreshAllDmUnread = useCallback(async () => {
    if (!user?.id) return;

    // 1) мои ЛС (is_group=false) + trip_id, включая archived ЛС
    const { data: myDm, error: dmErr } = await supabase
      .from("chat_participants")
      .select("chat_id, chats!inner(id, trip_id, chat_type, is_group)")
      .eq("user_id", user.id)
      .eq("chats.is_group", false)
      .in("chats.chat_type", ["trip_private", "archived"]);

    if (dmErr) {
      console.error("DM unread: failed to fetch my DMs", dmErr);
      return;
    }

    const dm = (myDm || [])
      .map((r) => ({ chat_id: r.chat_id ?? r.chats?.id, trip_id: r.chats?.trip_id }))
      .filter((x) => x.chat_id && x.trip_id);

    const dmIds = dm.map((d) => d.chat_id);

    // 2) участники ЛС — нужен «второй» собеседник
    const otherByChat = {};
    if (dmIds.length) {
      const { data: parts, error: partsErr } = await supabase
        .from("chat_participants")
        .select("chat_id, user_id")
        .in("chat_id", dmIds);

      if (!partsErr) {
        (parts || []).forEach((p) => {
          (otherByChat[p.chat_id] ||= []).push(p.user_id);
        });
      }
    }

    // 3) ✅ одним RPC получаем unread по всем DM chat_id
    const countsByChat = await getUnreadCountsBulk(dmIds);

    // 4) собираем структуру по поездкам + индекс для RT
    const byTrip = {};
    const index = {};

    dm.forEach(({ chat_id, trip_id }) => {
      const others = (otherByChat[chat_id] || []).filter((x) => x !== user.id);
      const otherId = others[0] || null;

      if (!byTrip[trip_id]) byTrip[trip_id] = {};
      if (otherId) byTrip[trip_id][otherId] = countsByChat[chat_id] || 0;

      index[chat_id] = { trip_id, otherId };
    });

    dmIndexByChatIdRef.current = index;
    setDmUnreadByTrip(byTrip);

    // 5) синхронизируем бейджи по этим чатам (через notifications.setUnreadCount)
    //    + локальный unreadCount
    setUnreadCount((prev) => {
      const next = { ...(prev || {}) };

      // гарантируем наличие ключей
      dmIds.forEach((id) => {
        if (next[id] == null) next[id] = 0;
      });

      // применяем фактические значения
      Object.entries(countsByChat).forEach(([cid, n]) => {
        next[cid] = n;
        if (notifications?.setUnreadCount) notifications.setUnreadCount(cid, n);
      });

      return next;
    });
  }, [supabase, user?.id, notifications, getUnreadCountsBulk]);

  // Пересчёт после загрузки чатов
  useEffect(() => {
    if (user?.id && isChatsLoaded) refreshAllDmUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isChatsLoaded]);

  // Слушатель глобальных нотификаций: синхронизируем локальный unreadCount + title
  useEffect(() => {
    if (!user?.id) return;
    let t = null;

    const handle = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const globalMap = notifications.unreadCounts || {};
        setUnreadCount({ ...globalMap });

        const totalUnread = notifications.getTotalUnread();
        if (typeof document !== "undefined") {
          document.title = totalUnread > 0 ? `(${totalUnread}) Мои сообщения` : "Мои сообщения";
        }
      }, 50);
    };

    notifications.addListener(handle);
    return () => {
      clearTimeout(t);
      notifications.removeListener(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Realtime: INSERT в chat_messages — обновляем dmUnreadByTrip и unreadCount
  useEffect(() => {
    if (!user?.id) return;

    // cleanup old channel
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // cleanup timers (на всякий)
    clearAllRpcTimers();

    const channel = supabase
      .channel(`dm_unread_watch_${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        async (payload) => {
          const row = payload?.new;
          if (!row?.chat_id) return;

          // ✅ фильтруем "свои" сообщения тут (вместо neq-фильтра)
          if (row.user_id === user.id) return;

          let idx = dmIndexByChatIdRef.current[row.chat_id];
          const hadIndex = !!idx;

          // если это новый для нас DM — просто пересоберём карту
          if (!hadIndex) {
            await refreshAllDmUnread();
            idx = dmIndexByChatIdRef.current[row.chat_id];
            if (!idx) return; // всё равно не наш DM
          }

// ✅ если это сообщение в чате, который сейчас открыт — НЕ накидываем индикации
if (currentChatIdRef.current && row.chat_id === currentChatIdRef.current) {
const t = unreadRpcTimersRef.current.get(row.chat_id);
if (t) {
  clearTimeout(t);
  unreadRpcTimersRef.current.delete(row.chat_id);
} 
 // 1) бейдж самого чата в списке — 0
  setUnreadCountLocal(row.chat_id, 0);

  // 2) красная точка/цифра по ЛС (dmUnreadByTrip) — тоже 0
  const { trip_id, otherId } = idx || {};
  if (trip_id && otherId) {
    setDmUnreadByTrip((prev) => {
      const next = { ...(prev || {}) };
      const tripMap = { ...(next[trip_id] || {}) };
      tripMap[otherId] = 0;
      next[trip_id] = tripMap;
      return next;
    });
  }

  return; // ← важно: дальше не инкрементим
}


          // ✅ 1) мгновенно увеличим локальный unreadCount по chat_id (без RPC)
          setUnreadCount((prev) => {
            const next = { ...(prev || {}) };
            const cur = Number(next[row.chat_id] || 0);
            const n = cur + 1;

            next[row.chat_id] = n;
            // синхронизируем глобально тоже (быстро)
            if (notifications?.setUnreadCount) notifications.setUnreadCount(row.chat_id, n);

            return next;
          });

          // ✅ 2) мгновенно инкрементим dmUnreadByTrip (для красных точек по поездке)
          setDmUnreadByTrip((prev) => {
            const next = { ...prev };
            const { trip_id, otherId } = idx;
            if (!trip_id || !otherId) return next;

            // если чат только что появился, refreshAllDmUnread уже выставил правильное значение
            if (!hadIndex) return next;

            const tripMap = { ...(next[trip_id] || {}) };
            tripMap[otherId] = (tripMap[otherId] || 0) + 1;
            next[trip_id] = tripMap;
            return next;
          });

          // ✅ 3) авторитетный пересчёт бейджа — дебаунсом (на случай рассинхрона)
          updateUnreadCountDebounced(row.chat_id);
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      clearAllRpcTimers();
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, refreshAllDmUnread, updateUnreadCountDebounced, clearAllRpcTimers]);

  return {
    dmUnreadByTrip,
    refreshAllDmUnread,
    unreadCount,
    setUnreadCount,
    updateUnreadCount, // оставляем наружу (используется в useMessagesRealtime)
  };
}
