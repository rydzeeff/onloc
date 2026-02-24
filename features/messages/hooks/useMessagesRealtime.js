// features/messages/hooks/useMessagesRealtime.js
import { useCallback, useEffect, useRef, useState } from "react";
import { dedupeFiles, dedupeMessages } from "../utils/chatUtils";

const PAGE_SIZE = 30; // как в последней оптимизации
const UNREAD_DEBOUNCE_MS = 300; // чтобы не дергать RPC на каждое read

export function useMessagesRealtime({
  supabase,
  user,
  currentChat,
  preloadSignedUrlsForMessages,
  signFileUrl,
  notifications, // оставлено для совместимости (может не использоваться тут)
  updateUnreadCount, // IMPORTANT: внутри useDmUnread сделай через get_unread_counts_for_chats
}) {
  const [messages, setMessages] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

 const didInitialLoadRef = useRef(false);     // первая страница уже загрузилась
 const fetchTokenRef = useRef(0);             // защита от race в finally
 const pagingLockRef = useRef(false);         // чтобы не накрутить page много раз на одном "топе"

  const messagesEndRef = useRef(null);
  const chatMessagesRef = useRef(null);

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

// ✅ если file-insert пришёл раньше, чем msg появился в state
const pendingFilesRef = useRef(new Map()); // messageId(string) -> file[]

  useEffect(() => {
    // при смене чата чистим pending, чтобы не копилось
    pendingFilesRef.current.clear();
   didInitialLoadRef.current = false;
   pagingLockRef.current = false;
  }, [currentChat?.id]);

  // чтобы не применять результаты "старого" fetch после смены чата/пагинации
  const fetchSeqRef = useRef(0);
  const activeChatIdRef = useRef(null);
  useEffect(() => {
    activeChatIdRef.current = currentChat?.id || null;
  }, [currentChat?.id]);

  // защита от повторного markMessageAsRead на один и тот же msg (всплеск realtime)
  const markingRef = useRef(new Set());

  // debounce обновления unread (особенно важно, если updateUnreadCount -> RPC)
  const unreadTimersRef = useRef(new Map()); // chatId -> timeoutId

  const scheduleUnreadUpdate = useCallback(
    (chatId, { immediate = false } = {}) => {
      if (!chatId) return;

      const prev = unreadTimersRef.current.get(chatId);
      if (prev) {
        clearTimeout(prev);
        unreadTimersRef.current.delete(chatId);
      }

      if (immediate) {
        // "прямо сейчас" (например, после markAll)
        updateUnreadCount?.(chatId);
        return;
      }

      const t = setTimeout(() => {
        unreadTimersRef.current.delete(chatId);
        updateUnreadCount?.(chatId);
      }, UNREAD_DEBOUNCE_MS);

      unreadTimersRef.current.set(chatId, t);
    },
    [updateUnreadCount]
  );

  // cleanup таймеров
  useEffect(() => {
    return () => {
      try {
        for (const t of unreadTimersRef.current.values()) clearTimeout(t);
        unreadTimersRef.current.clear();
      } catch {}
    };
  }, []);

  // Помощник: аккуратно обновить массив readers у одного сообщения
const mergeReads = useCallback((msgId, newRead) => {
  const mid = String(msgId);

  setMessages((prev) =>
    prev.map((m) => {
      if (String(m.id) !== mid) return m;

      const existed = Array.isArray(m.chat_message_reads)
        ? m.chat_message_reads
        : [];

      const has = existed.some((r) => String(r.user_id) === String(newRead.user_id));
      return has ? m : { ...m, chat_message_reads: [...existed, newRead] };
    })
  );
}, []);

  /**
   * ✅ Быстрая загрузка страниц:
   * - без count: "exact"
   * - hasMore через PAGE_SIZE + 1
   * - сначала показываем сообщения без signed urls
   * - подписываем вложения фоном
   */
  const fetchMessages = useCallback(
    async (chatId, pageNum = page) => {
      if (!chatId) return;

     const myToken = ++fetchTokenRef.current;
     pagingLockRef.current = true; // закрываем "доп. page++" пока грузим

      const seq = ++fetchSeqRef.current;
      const from = (pageNum - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE; // +1 запись (inclusive range)

     try {
       const { data: rows, error } = await supabase
        .from("chat_messages")
         .select(`
           id, chat_id, user_id, content, created_at, read,
           chat_message_files (id, message_id, bucket, path, mime, size, created_at),
           chat_message_reads (user_id, read_at)
         `)
         .eq("chat_id", chatId)
         .order("created_at", { ascending: false })
         .range(from, to);

      // если пока грузили — чат переключили/сбросили пагинацию
      if (seq !== fetchSeqRef.current) return;
      if (activeChatIdRef.current !== chatId) return;

      if (error) {
        console.error("Messages: Ошибка загрузки сообщений:", error);
        return;
      }

      const got = rows || [];
      const hasExtra = got.length > PAGE_SIZE;
      const pageRows = hasExtra ? got.slice(0, PAGE_SIZE) : got;

      // Приводим в возрастающий порядок (для рендера)
      const pageMsgsAsc = pageRows.reverse();

      // ✅ Быстро показываем сообщения сразу (без signed urls)
      setMessages((prev) => dedupeMessages([...prev, ...pageMsgsAsc]));
      setHasMore(hasExtra);

       if (pageNum === 1) {
         didInitialLoadRef.current = true; // ✅ первая страница уже есть
       }

      // ✅ Прокрутка к низу при page=1
      if (pageNum === 1) {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        }, 80);
      }

      // ✅ Подписываем файлы в фоне только если есть вложения
      const needSign = pageMsgsAsc.some(
        (m) => Array.isArray(m.chat_message_files) && m.chat_message_files.length
      );
      if (!needSign) return;

      (async () => {
        try {
          const subset = pageMsgsAsc.filter(
            (m) => Array.isArray(m.chat_message_files) && m.chat_message_files.length
          );

          const enrichedSubset = await preloadSignedUrlsForMessages(subset);

          // если пока подписывали — чат сменился/запрос устарел
          if (seq !== fetchSeqRef.current) return;
          if (activeChatIdRef.current !== chatId) return;

          setMessages((prev) => dedupeMessages([...prev, ...enrichedSubset]));
        } catch {
          // мягкий фэйл — сообщения уже показаны без ссылок
        }
      })();
     } finally {
       // ✅ открываем пагинацию обратно, но аккуратно (если это последний активный fetch)
       if (myToken === fetchTokenRef.current) {
         pagingLockRef.current = false;
       }
     }
    },
    [page, supabase, preloadSignedUrlsForMessages]
  );

  // Realtime по текущему чату: сообщения + read-флаг + квитанции
  useEffect(() => {
    if (!user || !currentChat) return;

    const chatId = currentChat.id;
    const channel = supabase.channel(`chat_${chatId}`);

    const isDev =
      typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
    if (isDev) {
      console.log("[messagesRT] subscribe channel", { chatId, userId: user.id });
    }

    channel
      // Новые сообщения
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => {
          const msg = payload.new;
          if (!msg) return;

          // ✅ не добавляем дубликаты
          const mid = String(msg.id);
if (messagesRef.current.some((m) => String(m.id) === mid)) return;

          if (isDev) {
            console.log("[messagesRT] insert chat_messages", {
              chatId: msg.chat_id,
              id: msg.id,
            });
          }

setMessages((prev) => {
  const msgId = String(msg.id);

  // ✅ если файлы пришли раньше — достаём их
  const pending = pendingFilesRef.current.get(msgId) || [];
  if (pending.length) pendingFilesRef.current.delete(msgId);

  return dedupeMessages([
    ...prev,
    {
      ...msg,
      chat_message_files: pending,  // ✅ тут главное
      chat_message_reads: [],
    },
  ]);
});


          if (msg.user_id !== user.id) {
            setTimeout(() => {
              messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
            }, 80);
            markMessageAsRead(msg.id, msg.chat_id);
          }
        }
      )
      // Обновления read-флага (совместимость)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "chat_messages",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => {
          if (!payload?.new) return;
          const updated = payload.new;

setMessages((prev) =>
  prev.map((m) => (String(m.id) === String(updated.id) ? { ...m, read: updated.read } : m))
);
        }
      )

  // ✅ ВОТ СЮДА ВСТАВИТЬ (до chat_message_reads)
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "chat_message_files" },
    async (payload) => {
      const f = payload?.new;
      if (!f?.message_id) return;

      const msgId = String(f.message_id);

      // 0) Быстрый фильтр: если сообщение уже есть — проверим чат
      const localMsg = messagesRef.current.find((m) => String(m.id) === msgId);
      if (localMsg && String(localMsg.chat_id) !== String(chatId)) return;

      // 1) Если сообщения нет — проверим в БД, что файл относится к текущему чату
      if (!localMsg) {
        const { data: msgRow } = await supabase
          .from("chat_messages")
          .select("id, chat_id")
          .eq("id", f.message_id)
          .single();

        if (!msgRow || String(msgRow.chat_id) !== String(chatId)) return;
      }

      // 2) Подпишем URL
      const signedUrl = await signFileUrl(f.bucket, f.path);
      const fileWithUrl = { ...f, signed_url: signedUrl };

      // 3) Если сообщения ещё нет в state — кладём в pending
      const existsInState = messagesRef.current.some((m) => String(m.id) === msgId);
      if (!existsInState) {
        const arr = pendingFilesRef.current.get(msgId) || [];
        pendingFilesRef.current.set(msgId, dedupeFiles([...arr, fileWithUrl]));
        return;
      }

      // 4) Сообщение есть — приклеиваем файл
      setMessages((prev) => {
        const idx = prev.findIndex((m) => String(m.id) === msgId);
        if (idx === -1) return prev;

        const cur = prev[idx];
        const merged = dedupeFiles([...(cur.chat_message_files || []), fileWithUrl]);

        const next = prev.slice();
        next[idx] = { ...cur, chat_message_files: merged };
        return next;
      });
    }
  )

      // Квитанции прочтения (кто прочитал)
.on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_message_reads" }, (payload) => {
  const row = payload?.new;
  if (!row) return;

  const msg = messagesRef.current.find((m) => String(m.id) === String(row.message_id));
  if (!msg || String(msg.chat_id) !== String(chatId)) return;

  mergeReads(row.message_id, {
    user_id: row.user_id,
    read_at: row.read_at,
  });
})


      .subscribe();

    return () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentChat?.id, supabase, mergeReads]);

  // Мост от глобального realtime в _app: chat-message-insert -> текущий чат
  useEffect(() => {
    if (!user || !currentChat) return;

    const chatId = currentChat.id;
    const isDev =
      typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

    const handleGlobalInsert = (e) => {
      const msg = e?.detail?.message;
      if (!msg) return;
      if (msg.chat_id !== chatId) return;

      // ✅ не добавляем дубликаты
     const mid = String(msg.id);
if (messagesRef.current.some((m) => String(m.id) === mid)) return;

      if (isDev) {
        console.log("[messagesRT] global insert for current chat", {
          chatId,
          msgId: msg.id,
        });
      }

setMessages((prev) => {
  const msgId = String(msg.id);

  const pending = pendingFilesRef.current.get(msgId) || [];
  if (pending.length) pendingFilesRef.current.delete(msgId);

  const incomingFiles = Array.isArray(msg.chat_message_files) ? msg.chat_message_files : [];
  const mergedFiles = dedupeFiles([...incomingFiles, ...pending]);

  return dedupeMessages([
    ...prev,
    {
      ...msg,
      chat_message_reads: Array.isArray(msg.chat_message_reads) ? msg.chat_message_reads : [],
      chat_message_files: mergedFiles,
    },
  ]);
});


      if (msg.user_id !== user.id) {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 80);
        markMessageAsRead(msg.id, msg.chat_id);
      }
    };

    window.addEventListener("chat-message-insert", handleGlobalInsert);
    return () => window.removeEventListener("chat-message-insert", handleGlobalInsert);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, currentChat?.id]);

  // Внешняя вставка файла
  useEffect(() => {
    if (!currentChat) return;
    const chatId = currentChat.id;

    const onFileInsert = async (e) => {
  const f = e.detail;
  if (!f?.message_id) return;

  const msgId = String(f.message_id);

  // ✅ проверяем что это сообщение из текущего чата
  const existsLocally = messagesRef.current.some((m) => String(m.id) === msgId);

  if (!existsLocally) {
    const { data: msgRow } = await supabase
      .from("chat_messages")
      .select("id, chat_id")
      .eq("id", f.message_id)
      .single();

    if (!msgRow || msgRow.chat_id !== chatId) return;
  }

  const signedUrl = await signFileUrl(f.bucket, f.path);
  const fileWithUrl = { ...f, signed_url: signedUrl };

  setMessages((prev) => {
    const idx = prev.findIndex((m) => String(m.id) === msgId);

    // ✅ если сообщения ещё нет — сохраняем файл в pending и выходим
    if (idx === -1) {
      const arr = pendingFilesRef.current.get(msgId) || [];
      pendingFilesRef.current.set(msgId, dedupeFiles([...arr, fileWithUrl]));
      return prev;
    }

    // ✅ сообщение есть — мержим файл в chat_message_files
    const cur = prev[idx];
    const merged = dedupeFiles([...(cur.chat_message_files || []), fileWithUrl]);

    const next = prev.slice();
    next[idx] = { ...cur, chat_message_files: merged };
    return next;
  });
};


    window.addEventListener("chat-file-insert", onFileInsert);
    return () => window.removeEventListener("chat-file-insert", onFileInsert);
  }, [currentChat?.id, supabase, signFileUrl]);

  // Пагинация по скроллу
useEffect(() => {
  if (!currentChat || !hasMore) return;
  const el = chatMessagesRef.current;
  if (!el) return;

  const handleScroll = () => {
    // пока первая страница не загрузилась — не даём page++
    if (!didInitialLoadRef.current) return;

    // если контент не скроллится — не триггерим пагинацию скроллом
    if (el.scrollHeight <= el.clientHeight + 20) return;

    // защита от многократных page++ пока не завершился fetch
    if (pagingLockRef.current) return;

    if (el.scrollTop <= 10 && hasMore) {
      pagingLockRef.current = true;
      setPage((p) => p + 1);
    }
  };

  el.addEventListener("scroll", handleScroll, { passive: true });
  return () => el.removeEventListener("scroll", handleScroll);
}, [currentChat?.id, hasMore]);


  // загрузка страниц при смене чата/страницы
  useEffect(() => {
    if (!currentChat) return;
    fetchMessages(currentChat.id, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChat?.id, page]);

  // Помечаем одно сообщение прочитанным (read=true + квитанция в chat_message_reads)
async function markMessageAsRead(messageId, chatIdOverride) {
  const chatId = chatIdOverride || currentChat?.id;

  if (!messageId) return;
  if (markingRef.current.has(messageId)) return;
  markingRef.current.add(messageId);

  try {
    // 1) read=true (совместимость)
    const { error } = await supabase
      .from("chat_messages")
      .update({ read: true })
      .eq("id", messageId);

    if (!error) {
      setMessages((prev) =>
        prev.map((msg) =>
  String(msg.id) === String(messageId) ? { ...msg, read: true } : msg
)
      );
    }

    // 2) квитанция (ВАЖНО: сначала пишем её в БД)
    const nowIso = new Date().toISOString();
    await supabase
      .from("chat_message_reads")
      .upsert(
        {
          message_id: messageId,
          user_id: user.id,
          read_at: nowIso,
        },
        { onConflict: "message_id,user_id" }
      );

    // 3) локально добавляем читателя
    mergeReads(messageId, { user_id: user.id, read_at: nowIso });

    // ✅ 4) и только ПОСЛЕ квитанции — пересчёт unread (debounce)
    if (chatId) scheduleUnreadUpdate(chatId);
  } catch {
    // ignore
  } finally {
    markingRef.current.delete(messageId);
  }
}
  // Помечаем все чужие сообщения в чате прочитанными (read=true + kvit. батчем)
// Помечаем все чужие сообщения в чате прочитанными (server-side, чтобы не зависеть от pagination)
async function markAllMessagesAsRead(chatId) {
  if (!chatId || !user?.id) return;

  try {
    // ✅ ВАЖНО: это должно вставить chat_message_reads для ВСЕХ сообщений чата (а не только загруженных)
    const { error } = await supabase.rpc("mark_chat_read", {
      p_chat_id: chatId,
      p_user_id: user.id,
    });

    if (error) {
      console.error("mark_chat_read rpc error:", error);
      return;
    }

    // локально для UI (галки/статусы) — обновим то, что сейчас в памяти
    const nowIso = new Date().toISOString();
    setMessages((prev) =>
      prev.map((m) => {
        if (m.chat_id !== chatId) return m;
        if (m.user_id === user.id) return m;

        const existed = Array.isArray(m.chat_message_reads) ? m.chat_message_reads : [];
        const hasMe = existed.some((r) => r.user_id === user.id);

        return {
          ...m,
          read: true,
          chat_message_reads: hasMe ? existed : [...existed, { user_id: user.id, read_at: nowIso }],
        };
      })
    );
  } catch (e) {
    console.error("markAllMessagesAsRead error:", e);
  } finally {
    // ✅ после server-side mark — пересчитать unread по RPC
    scheduleUnreadUpdate(chatId, { immediate: true });
  }
}


  function resetPagination() {
    // ✅ отменяем "старые" fetch/подписи
    fetchSeqRef.current += 1;

   didInitialLoadRef.current = false;
   pagingLockRef.current = false;

    setPage(1);
    setHasMore(true);
    setMessages([]);
  }

  return {
    messages,
    setMessages,
    page,
    setPage,
    hasMore,
    setHasMore,
    chatMessagesRef,
    messagesEndRef,
    fetchMessages,
    markMessageAsRead,
    markAllMessagesAsRead,
    resetPagination,
  };
}
