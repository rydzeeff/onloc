// pages/admindashboard/AdminChatsPage.js
// Только support-чаты, точечные обновления, и мгновенное скрытие чата при переводе в архив.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../_app";
import styles from "../../styles/admin-disputes.module.css";

import MessageList from "../../features/messages/desktop/MessageList";
import MessageComposer from "../../features/messages/desktop/MessageComposer";
import commonMsgStyles from "../../styles/messages-common.module.css";
import desktopMsgStyles from "../../styles/messages-desktop.module.css";
const msgStyles = { ...commonMsgStyles, ...desktopMsgStyles };

import { useChatAttachments } from "../../hooks/useChatAttachments";
import { useMessagesRealtime } from "../../features/messages/hooks/useMessagesRealtime";

export default function AdminChatsPage({
  permissions = { is_admin: false, can_tab: false },
}) {
  const { user } = useAuth();
  const canModerate = !!(permissions.is_admin || permissions.can_tab);

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  const [delegatingChat, setDelegatingChat] = useState(null);
  const [adminCandidates, setAdminCandidates] = useState([]);
  const [delegateTo, setDelegateTo] = useState(null);



  // ===== Модальная переписка
  const [viewerChat, setViewerChat] = useState(null); // { id, chat_type, is_group, trip_id, participantsUserIds }
  const [viewerProfiles, setViewerProfiles] = useState({});
  const closeViewer = () => {
    setViewerChat(null);
    setViewerProfiles({});
    resetPagination();
  };

  const {
    pendingFiles,
    isUploading,
    onPickFiles,
    removePending,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  } = useChatAttachments({ supabase, bucket: "trip_chat_files" });

  const {
    messages, setMessages,
    chatMessagesRef, messagesEndRef,
    fetchMessages,
    markAllMessagesAsRead,
    resetPagination,
  } = useMessagesRealtime({
    supabase,
    user,
    currentChat: viewerChat,
    preloadSignedUrlsForMessages,
    signFileUrl,
    notifications: null,
    updateUnreadCount: () => {},
  });

  async function fetchAdminCandidates() {
    const { data } = await supabase
      .from("user_admin_access")
      .select("user_id, is_admin, chats");
    const allowed = (data || []).filter((r) => r.is_admin || r.chats).map((r) => r.user_id);
    if (!allowed.length) return [];

    const { data: profs } = await supabase
      .from("profiles")
      .select("user_id, first_name, last_name, avatar_url")
      .in("user_id", allowed);

    const map = (profs || []).reduce((acc, p) => { acc[p.user_id] = p; return acc; }, {});
    return allowed.map((uid) => ({ user_id: uid, profile: map[uid] }));
  }

  // ⚠️ ТОЛЬКО support-чаты
  async function fetchSupportChats() {
    if (!user || !canModerate) return;
    setLoading(true);

    const { data: chats, error: chatsErr } = await supabase
      .from("chats")
      .select("id, title, chat_type, is_group, created_at, moderator_id, support_close_requested_at, support_close_confirmed")
      .eq("chat_type", "support")
      .order("created_at", { ascending: false });

    if (chatsErr) {
      console.error("AdminChats: load error", chatsErr);
      setToast("Ошибка загрузки чатов");
      setTimeout(() => setToast(""), 3000);
      setLoading(false);
      return;
    }

    const chatIds = (chats || []).map((c) => c.id);

    // участники
    let partsByChat = {};
    if (chatIds.length) {
      const { data: parts } = await supabase
        .from("chat_participants")
        .select("chat_id, user_id")
        .in("chat_id", chatIds);
      (parts || []).forEach((p) => { (partsByChat[p.chat_id] ||= []).push(p.user_id); });
    }

    const admins = await fetchAdminCandidates();
    const adminSet = new Set(admins.map((a) => a.user_id));

    const allUserIds = Array.from(new Set([].concat(...Object.values(partsByChat))));
    let profilesById = {};
    if (allUserIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, first_name, last_name, avatar_url")
        .in("user_id", allUserIds);
      profilesById = (profiles || []).reduce((acc, p) => { acc[p.user_id] = p; return acc; }, {});
    }

    async function unreadFor(chatId) {
      const { count } = await supabase
        .from("chat_messages")
        .select("id", { count: "exact" })
        .eq("chat_id", chatId)
        .neq("user_id", user.id)
        .eq("read", false);
      return count || 0;
    }

    async function lastMsgFor(chatId) {
      const { data } = await supabase
        .from("chat_messages")
        .select("id, content, created_at, user_id")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: false })
        .limit(1);
      return data?.[0] || null;
    }

    const result = [];
    for (const chat of chats || []) {
      const participantsUserIds = partsByChat[chat.id] || [];
      const ownerUserId =
        participantsUserIds.find((uid) => !adminSet.has(uid)) ||
        participantsUserIds[0] || null;

      result.push({
        chat,
        participantsUserIds,
        ownerUserId,
        profilesById,
        unreadCount: 0,
        lastMessage: null,
      });
    }

    await Promise.all(
      result.map(async (row) => {
        row.unreadCount = await unreadFor(row.chat.id);
        row.lastMessage = await lastMsgFor(row.chat.id);
      })
    );

    setList(result);
    setLoading(false);
  }

  useEffect(() => {
    if (canModerate) fetchSupportChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canModerate, user?.id]);

  // Realtime: точечное обновление (без полного refetch) по новым сообщениям
  useEffect(() => {
    if (!canModerate) return;

    const channel = supabase
      .channel("admin_support_messages")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        async (payload) => {
          const chatId = payload.new.chat_id;
          // только support
          const { data: ch } = await supabase
            .from("chats")
            .select("id, chat_type")
            .eq("id", chatId)
            .single();
          if (ch?.chat_type !== "support") return;

          // от пользователя?
          const { data: r } = await supabase
            .from("user_admin_access")
            .select("user_id, is_admin, chats")
            .eq("user_id", payload.new.user_id)
            .maybeSingle();
          const isFromAdmin = !!(r && (r.is_admin || r.chats));

          const viewerOpen = viewerChat?.id === chatId;
          if (viewerOpen) {
            try { await markAllMessagesAsRead(chatId); } catch {}
          }

          if (!isFromAdmin) {
            try {

            } catch {}
          }

          setList((prev) => {
            let found = false;
            const next = prev.map((row) => {
              if (row.chat.id !== chatId) return row;
              found = true;
              const inc = (!isFromAdmin && !viewerOpen) ? 1 : 0;
              return {
                ...row,
                unreadCount: Math.max(0, (row.unreadCount || 0) + inc),
                lastMessage: {
                  id: payload.new.id,
                  content: payload.new.content,
                  created_at: payload.new.created_at,
                  user_id: payload.new.user_id,
                },
              };
            });
            if (!found) fetchSupportChats(); // новый support-чат
            return next;
          });
        }
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [canModerate, viewerChat?.id, markAllMessagesAsRead]);

  // Realtime: мгновенно скрыть чат, когда он стал archived
  useEffect(() => {
    if (!canModerate) return;
    const ch = supabase
      .channel("admin_support_chats_updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chats" },
        (payload) => {
          const was = payload.old?.chat_type;
          const now = payload.new?.chat_type;
          const id = payload.new?.id;
          if (!id) return;

          if (was === "support" && now === "archived") {
            // убрать из таблицы сразу
            setList((prev) => prev.filter((row) => row.chat.id !== id));
            // если модалка этого чата открыта — закрыть
            if (viewerChat?.id === id) {
              closeViewer();
            }
          }
        }
      )
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [canModerate, viewerChat?.id]);

  function toastOnce(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }
  function deny() {
    toastOnce("Доступ запрещен: недостаточно прав");
  }
  function nameOf(uid) {
    const p = list[0]?.profilesById?.[uid];
    if (!p) return "Пользователь";
    return `${p.last_name || ""} ${p.first_name || ""}`.trim() || "Пользователь";
  }

  async function handleJoin(chatId) {
    if (!canModerate || !user) return deny();

    const { data: chat } = await supabase
      .from("chats")
      .select("id, moderator_id")
      .eq("id", chatId)
      .single();

    if (!chat) return toastOnce("Чат не найден");
    if (chat.moderator_id && chat.moderator_id !== user.id) {
      return toastOnce("Чат уже занят другим админом");
    }

    const { error: upErr } = await supabase
      .from("chats")
      .update({ moderator_id: user.id })
      .eq("id", chatId);
    if (upErr) return toastOnce("Ошибка назначения модератора");

    const { data: haveRow } = await supabase
      .from("chat_participants")
      .select("chat_id, user_id")
      .eq("chat_id", chatId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!haveRow) {
      await supabase.from("chat_participants").insert([{ chat_id: chatId, user_id: user.id }]);
    }

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: user.id,
      content: "Администратор вступил в чат",
      read: false,
    });

    toastOnce("Вы вступили в чат");
    setList((prev) =>
      prev.map((row) =>
        row.chat.id === chatId
          ? {
              ...row,
              lastMessage: {
                id: `local-${Date.now()}`,
                content: "Администратор вступил в чат",
                user_id: user.id,
              },
            }
          : row
      )
    );
  }

  async function openDelegateModal(row) {
    setDelegatingChat(row.chat);
    setDelegateTo(null);
    const list = await fetchAdminCandidates();
    setAdminCandidates(list);
  }

  async function handleDelegate() {
    if (!delegatingChat || !delegateTo || !user) return;

    const { error: upErr } = await supabase
      .from("chats")
      .update({ moderator_id: delegateTo })
      .eq("id", delegatingChat.id);
    if (upErr) return toastOnce("Ошибка делегирования");

    await supabase
      .from("chat_participants")
      .delete()
      .eq("chat_id", delegatingChat.id)
      .eq("user_id", user.id);

    const { data: haveNew } = await supabase
      .from("chat_participants")
      .select("chat_id, user_id")
      .eq("chat_id", delegatingChat.id)
      .eq("user_id", delegateTo)
      .maybeSingle();

    if (!haveNew) {
      await supabase.from("chat_participants").insert([{ chat_id: delegatingChat.id, user_id: delegateTo }]);
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("user_id", delegateTo)
      .single();
    const display = `${prof?.last_name || ""} ${prof?.first_name || ""}`.trim() || "новый администратор";

    await supabase.from("chat_messages").insert({
      chat_id: delegatingChat.id,
      user_id: user.id,
      content: `Чат передан: ${display}`,
      created_at: new Date().toISOString(),
      read: false,
    });

    setDelegatingChat(null);
    setDelegateTo(null);
    toastOnce("Чат делегирован");
  }

  async function handleFinishAsk(chatId) {
    if (!canModerate || !user) return deny();

    await supabase
      .from("chats")
      .update({ support_close_requested_at: new Date().toISOString(), support_close_confirmed: null })
      .eq("id", chatId);

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: user.id,
      content: "[CLOSE_PROMPT] Администратор считает, что задача выполнена. Закрыть чат? Ответьте «Да» или «Нет».",
      read: false,
    });

    toastOnce("Вопрос отправлен пользователю");
    setList((prev) =>
      prev.map((row) =>
        row.chat.id === chatId
          ? {
              ...row,
              lastMessage: {
                id: `local-${Date.now()}`,
                content:
                  "Администратор считает, что задача выполнена. Закрыть чат? Ответьте «Да» или «Нет».",
                user_id: user.id,
              },
            }
          : row
      )
    );
  }

  async function handleArchiveNow(chatId) {
    const { error } = await supabase.from("chats").update({ chat_type: "archived" }).eq("id", chatId);
    if (error) return toastOnce("Ошибка архивации");

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: user.id,
      content: "Чат переведён в архив администратором",
      created_at: new Date().toISOString(),
      read: false,
    });

    // Уберём из списка мгновенно
    setList((prev) => prev.filter((row) => row.chat.id !== chatId));
    // И закроем модалку, если это он
    if (viewerChat?.id === chatId) closeViewer();

    toastOnce("Чат архивирован");
  }

  const activeList = useMemo(() => list.filter((row) => row.chat.chat_type === "support"), [list]);

  if (!canModerate) return <div className={styles.error}>Доступ запрещен</div>;
  if (loading) return <div className={styles.container}>Загрузка…</div>;

  async function openChatViewer(row) {
    const chatObj = {
      id: row.chat.id,
      chat_type: row.chat.chat_type,
      is_group: false,
      trip_id: null,
      participantsUserIds: row.participantsUserIds || [],
    };
    setViewerProfiles(row.profilesById || {});
    setViewerChat(chatObj);
    resetPagination();
    await fetchMessages(chatObj.id, 1);
    await markAllMessagesAsRead(chatObj.id);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);

    setList((prev) =>
      prev.map((r) => (r.chat.id === chatObj.id ? { ...r, unreadCount: 0 } : r))
    );
  }

  return (
    <div className={styles.container}>
      <h2>Чаты поддержки</h2>
      {toast && <div className={styles.toast}>{toast}</div>}

      <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 14, opacity: 0.8 }}>
          Непрочитанных чатов: <b>{activeList.reduce((acc, row) => acc + (row.unreadCount > 0 ? 1 : 0), 0)}</b>
        </span>
      </div>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Чат</th>
            <th>Создан</th>
            <th>Автор обращения</th>
            <th>Модератор</th>
            <th>Непроч.</th>
            <th>Последнее сообщение</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {activeList.length ? (
            activeList.map((row) => {
              const { chat, ownerUserId, unreadCount, lastMessage } = row;
              const unread = unreadCount > 0;
              return (
                <tr
                  key={chat.id}
                  style={
                    unread
                      ? { boxShadow: "inset 3px 0 0 #ef4444", background: "#fff" }
                      : undefined
                  }
                >
                  <td style={{ position: "relative" }}>
                    {chat.title || `Поддержка #${chat.id.slice(0, 6)}`}
                    {unread ? (
                      <span
                        style={{
                          marginLeft: 8,
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "#ef4444",
                          verticalAlign: "middle",
                        }}
                        title="Непрочитанные сообщения"
                      />
                    ) : null}
                  </td>
                  <td>{new Date(chat.created_at).toLocaleString("ru-RU")}</td>
                  <td>{ownerUserId ? nameOf(ownerUserId) : "—"}</td>
                  <td>{chat.moderator_id ? nameOf(chat.moderator_id) : "—"}</td>
                  <td>{unreadCount}</td>
                  <td style={{ maxWidth: 340, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {lastMessage ? `${lastMessage.user_id === chat.moderator_id ? "Админ: " : ""}${lastMessage.content}` : "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className={styles.joinButton}
                      onClick={() => openChatViewer(row)}
                      title="Открыть окно переписки"
                      style={{ marginRight: 8 }}
                    >
                      Открыть
                    </button>

                    {!chat.moderator_id ? (
                      <button className={styles.joinButton} onClick={() => handleJoin(chat.id)}>
                        Вступить в чат
                      </button>
                    ) : (
                      <>
                        <button
                          className={styles.resolveButton}
                          onClick={() => handleFinishAsk(chat.id)}
                          title="Спросить у пользователя: закрыть чат?"
                        >
                          Задача выполнена?
                        </button>
                        <button
                          className={styles.uploadButton}
                          onClick={() => openDelegateModal(row)}
                          title="Передать чат другому администратору"
                        >
                          Делегировать
                        </button>
                        <button
                          className={styles.fileInput}
                          style={{ cursor: "pointer", border: "1px solid #ddd", padding: "6px 10px", borderRadius: 8 }}
                          onClick={() => handleArchiveNow(chat.id)}
                          title="Принудительно перевести в архив"
                        >
                          В архив
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={7} style={{ padding: 12, opacity: 0.7 }}>
                Нет активных чатов поддержки
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Модалка делегирования */}
      {delegatingChat && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => setDelegatingChat(null)}
        >
          <div
            style={{ background: "#fff", borderRadius: 12, padding: 16, width: 520, maxWidth: "90%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>
              Делегировать чат #{delegatingChat.id.slice(0, 6)}
            </div>
            <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #eee", borderRadius: 8 }}>
              {adminCandidates.length ? (
                adminCandidates.map((a) => {
                  const p = a.profile;
                  const label = p ? `${p.last_name || ""} ${p.first_name || ""}`.trim() : a.user_id;
                  return (
                    <label
                      key={a.user_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderBottom: "1px solid #f3f4f6",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="radio"
                        name="delegate_to"
                        value={a.user_id}
                        checked={delegateTo === a.user_id}
                        onChange={() => setDelegateTo(a.user_id)}
                      />
                      <img
                        src={p?.avatar_url || "/avatar-default.svg"}
                        alt=""
                        style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }}
                      />
                      <span>{label || a.user_id}</span>
                    </label>
                  );
                })
              ) : (
                <div style={{ padding: 10, opacity: 0.7 }}>Нет доступных администраторов</div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button
                className={styles.fileInput}
                onClick={() => setDelegatingChat(null)}
                style={{ cursor: "pointer", border: "1px solid #ddd", padding: "6px 10px", borderRadius: 8 }}
              >
                Отмена
              </button>
              <button
                className={styles.uploadButton}
                disabled={!delegateTo}
                onClick={handleDelegate}
              >
                Делегировать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка чата */}
      {viewerChat && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
          }}
          onClick={closeViewer}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              width: "min(980px, 96vw)",
              height: "min(80vh, 880px)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={msgStyles.chatHeader}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderBottom: "1px solid #e5e7eb" }}
            >
              <img src="/default-travel-image.png" alt="" className={msgStyles.chatAvatar} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontWeight: 600 }}>
                  {`Поддержка #${viewerChat.id.slice(0,6)}`}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Окно администратора</div>
              </div>
              <button
                onClick={closeViewer}
                style={{ marginLeft: "auto", border: "1px solid #e5e7eb", borderRadius: 10, padding: "6px 10px", cursor: "pointer", background: "white" }}
              >
                Закрыть
              </button>
            </div>

            <MessageList
              messages={messages}
              profilesMap={viewerProfiles}
              currentChat={viewerChat}
              myUserId={user.id}
              signFileUrl={signFileUrl}
              chatMessagesRef={chatMessagesRef}
              messagesEndRef={messagesEndRef}
              styles={msgStyles}
            />

            <div style={{ borderTop: "1px solid #e5e7eb", background: "#fff" }}>
              <MessageComposer
                isUploading={isUploading}
                pendingFiles={pendingFiles}
                onPickFiles={onPickFiles}
                removePending={removePending}
                sendWithMessage={sendWithMessage}
                currentChat={viewerChat}
                myUserId={user.id}
                styles={msgStyles}
                onMessageSent={async ({ message, files }) => {
                  setMessages((prev) => {
                    const exists = prev.some((m) => m.id === message.id);
                    return exists ? prev : [...prev, { ...message, chat_message_files: files }];
                  });
                  await fetchMessages(viewerChat.id, 1);
                  setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
