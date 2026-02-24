// pages/admindashboard/AdminCompaniesPage.js
import React, { useEffect, useState } from "react";
import styles from "../../styles/admin-disputes.module.css";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../_app";

import MessageList from "../../features/messages/desktop/MessageList";
import MessageComposer from "../../features/messages/desktop/MessageComposer";
import commonMsgStyles from "../../styles/messages-common.module.css";
import desktopMsgStyles from "../../styles/messages-desktop.module.css";
import { useChatAttachments } from "../../hooks/useChatAttachments";
import { useMessagesRealtime } from "../../features/messages/hooks/useMessagesRealtime";

const msgStyles = { ...commonMsgStyles, ...desktopMsgStyles };

// Разрешённые к изменению/отправке поля
const ALLOWED_FIELDS = [
  "name",
  "inn",
  "kpp",
  "ogrn",
  "legal_address",
  "phone",
  "bank_name",
  "payment_account",
  "payment_bik",
  "payment_corr_account",
  "payment_details",
  "ceo_last_name",
  "ceo_first_name",
  "ceo_middle_name",
  "okveds",
];

// Нормализация ОКВЭДов к [{code, name}]
function normalizeOkveds(value) {
  if (!value) return [];
  let arr = value;
  if (typeof value === "string") {
    try { arr = JSON.parse(value); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = arr
    .map((x) => {
      if (!x) return null;
      if (typeof x === "string") return { code: x.trim(), name: "" };
      if (typeof x === "object") {
        const code = (x.code || "").toString().trim();
        const name = (x.name || "").toString();
        if (!code) return null;
        return { code, name };
      }
      return null;
    })
    .filter(Boolean);
  const seen = new Set();
  return out.filter((it) => (seen.has(it.code) ? false : (seen.add(it.code), true)));
}

export default function AdminCompaniesPage({
  permissions = { is_admin: false, can_tab: false },
}) {
  const { user } = useAuth();
  const canModerate = !!(permissions.is_admin || permissions.can_tab);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");

  // Просмотр чата (оверлей)
  const [viewerChat, setViewerChat] = useState(null);
  const [viewerProfiles, setViewerProfiles] = useState({});
  const [viewerCanAct, setViewerCanAct] = useState(false);
  const [viewerOwnerCompany, setViewerOwnerCompany] = useState({});
  const [viewerHasOpenProposal, setViewerHasOpenProposal] = useState(false);
  const closeViewer = () => {
    setViewerChat(null);
    setViewerProfiles({});
    setViewerCanAct(false);
    setViewerOwnerCompany({});
    setViewerHasOpenProposal(false);
    resetPagination();
  };

  // Модалка "Сменить реквизиты"
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [reqForm, setReqForm] = useState({});
  const [reqTargetChatId, setReqTargetChatId] = useState(null);

  // Вложения/отправка сообщений
  const {
    pendingFiles,
    isUploading,
    onPickFiles,
    removePending,
    sendWithMessage,
    signFileUrl,
    preloadSignedUrlsForMessages,
  } = useChatAttachments({ supabase, bucket: "trip_chat_files" });

  // Рилтайм сообщений в оверлее
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
    notifications: { addListener: () => {}, removeListener: () => {}, getTotalUnread: () => 0, setUnreadCount: () => {}, unreadCounts: {} },
    updateUnreadCount: () => {},
  });

  function parseRequestTag(text) {
    return typeof text === "string" && text.startsWith("[COMPANY_CHANGE_REQUEST]");
  }

  async function fetchAdminIds() {
    const { data } = await supabase
      .from("user_admin_access")
      .select("user_id, is_admin, chats");
    return new Set(
      (data || []).filter((r) => r.is_admin || r.chats).map((r) => r.user_id)
    );
  }

  // Достаём активную компанию пользователя — только разрешённые поля (+ okveds)
  async function getOwnerCompanyFull(userId) {
    const { data } = await supabase
      .from("mycompany")
      .select(
        [
          "name",
          "inn",
          "kpp",
          "ogrn",
          "legal_address",
          "phone",
          "bank_name",
          "payment_account",
          "payment_bik",
          "payment_corr_account",
          "payment_details",
          "ceo_last_name",
          "ceo_first_name",
          "ceo_middle_name",
          "okveds",
        ].join(",")
      )
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();

    const clean = {};
    for (const k of ALLOWED_FIELDS) {
      if (k === "okveds") clean[k] = normalizeOkveds(data?.okveds);
      else clean[k] = data?.[k] ?? "";
    }
    return clean;
  }

  async function refresh() {
    if (!user || !canModerate) return;
    setLoading(true);

    // 1) последние сообщения-заявки
    const { data: reqMsgs, error: reqErr } = await supabase
      .from("chat_messages")
      .select("id, chat_id, user_id, content, created_at")
      .ilike("content", "[COMPANY_CHANGE_REQUEST]%")
      .order("created_at", { ascending: false });

    if (reqErr) {
      console.error("AdminCompanies: load error", reqErr);
      setToast("Ошибка загрузки заявок");
      setTimeout(() => setToast(""), 3000);
      setLoading(false);
      return;
    }

    const lastByChat = new Map();
    for (const m of reqMsgs || []) {
      if (!lastByChat.has(m.chat_id)) lastByChat.set(m.chat_id, m);
    }
    const chatIds = Array.from(lastByChat.keys());
    if (chatIds.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    // 2) чаты
    const { data: chats } = await supabase
      .from("chats")
      .select("id, title, chat_type, is_group, created_at, moderator_id")
      .in("id", chatIds);

    const chatMap = (chats || []).reduce((acc, c) => ((acc[c.id] = c), acc), {});

    // 3) участники и профили
    const { data: parts } = await supabase
      .from("chat_participants")
      .select("chat_id, user_id")
      .in("chat_id", chatIds);

    const admins = await fetchAdminIds();
    const partsByChat = {};
    const userIds = new Set();
    for (const p of parts || []) {
      (partsByChat[p.chat_id] ||= []).push(p.user_id);
      userIds.add(p.user_id);
    }
    const { data: profs } = await supabase
      .from("profiles")
      .select("user_id, first_name, last_name, avatar_url")
      .in("user_id", Array.from(userIds));
    const profilesById = (profs || []).reduce(
      (acc, p) => ((acc[p.user_id] = p), acc),
      {}
    );

    // 4) сообщения после заявки
    const minTs = Math.min(
      ...Array.from(lastByChat.values()).map((m) =>
        new Date(m.created_at).getTime()
      )
    );
    const minIso = new Date(minTs).toISOString();
    const { data: afterMsgs } = await supabase
      .from("chat_messages")
      .select("id, chat_id, user_id, content, created_at, read")
      .in("chat_id", chatIds)
      .gte("created_at", minIso)
      .order("created_at", { ascending: true });

    const afterByChat = {};
    for (const m of afterMsgs || []) (afterByChat[m.chat_id] ||= []).push(m);

    // 5) собираем строки + вычисляем наличие "открытого" предложения
    const rowsData = [];
    for (const chatId of chatIds) {
      const chat = chatMap[chatId];
      if (!chat) continue;
      const requestMsg = lastByChat.get(chatId);
      const after = (afterByChat[chatId] || []).filter(
        (m) => new Date(m.created_at) > new Date(requestMsg.created_at)
      );

      const participants = partsByChat[chatId] || [];
      const ownerUserId =
        participants.find((uid) => !admins.has(uid)) || participants[0] || null;

      let status = "new";
      if (chat.chat_type === "archived") status = "closed";
      else if (after.some((m) => String(m.content || "").startsWith("[COMPANY_CHANGE_CLOSED]")))
        status = "closed";
      // ✅ подтверждаем ТОЛЬКО при явном SUCCESS
      else if (after.some((m) => String(m.content || "").startsWith("[COMPANY_CHANGE_SUCCESS]")))
        status = "confirmed";
      else if (after.some((m) => String(m.content || "").startsWith("[COMPANY_CHANGE_TAKEN]")) || chat.moderator_id)
        status = "in_progress";

      // Последнее предложение
      const proposals = after.filter((m) =>
        String(m.content || "").startsWith("[COMPANY_CHANGE_PROPOSAL]")
      );
      const lastProposal = proposals.length ? proposals[proposals.length - 1] : null;

      let hasOpenProposal = false;
      if (lastProposal) {
        const afterProposal = after.filter(
          (m) => new Date(m.created_at) > new Date(lastProposal.created_at)
        );
        const decisionOrClose = afterProposal.some((m) => {
          const txt = (m.content || "").trim();
          return (
            txt === "Подтверждаю смену реквизитов" ||
            txt === "Пользователь не принял изменения" ||
            txt.startsWith("[COMPANY_CHANGE_CLOSED]")
          );
        });
        hasOpenProposal = !decisionOrClose && chat.chat_type !== "archived";
      }

      const ownerCompany = ownerUserId
        ? await getOwnerCompanyFull(ownerUserId)
        : {};
      const lastChangeAt = after.length
        ? after[after.length - 1].created_at
        : requestMsg.created_at;

      rowsData.push({
        chat,
        requestMsg,
        ownerUserId,
        profilesById,
        status,
        lastChangeAt,
        ownerCompany,
        hasOpenProposal, // ← блокируем повторную отправку
      });
    }

    const order = { new: 0, in_progress: 1, confirmed: 2, closed: 3 };
    rowsData.sort(
      (a, b) =>
        (order[a.status] - order[b.status]) ||
        new Date(b.requestMsg.created_at) - new Date(a.requestMsg.created_at)
    );

    setRows(rowsData);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, [user?.id, canModerate]); // eslint-disable-line react-hooks/exhaustive-deps

  const displayName = (uid, profilesMap) => {
    const p = profilesMap?.[uid];
    return p ? `${p.last_name || ""} ${p.first_name || ""}`.trim() : uid?.slice(0, 6);
  };

  async function takeInWork(chatId) {
    if (!user) return;
    await supabase
      .from("chats")
      .update({ moderator_id: user.id })
      .eq("id", chatId);
    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: user.id,
      content: "[COMPANY_CHANGE_TAKEN] Заявка взята в работу администратором",
      read: false,
    });
    setToast("Заявка взята в работу");
    setTimeout(() => setToast(""), 1500);
    await refresh();
  }

  async function closeRequest(chatId) {
    const ok =
      typeof window !== "undefined"
        ? window.confirm("Вы уверены, что хотите закрыть заявку без изменений?")
        : true;
    if (!ok) return;

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: user.id,
      content: "[COMPANY_CHANGE_CLOSED] Заявка закрыта без изменений",
      read: false,
    });
    await supabase.from("chats").update({ chat_type: "archived" }).eq("id", chatId);
    await refresh();
  }

  async function openChat(row) {
    const chatObj = {
      id: row.chat.id,
      chat_type: row.chat.chat_type,
      is_group: false,
      trip_id: null,
      participantsUserIds: [],
      moderator_id: row.chat.moderator_id,
    };
    setViewerProfiles(row.profilesById || {});
    setViewerChat(chatObj);
    setViewerCanAct(row.status === "in_progress" && !row.hasOpenProposal);
    setViewerOwnerCompany(row.ownerCompany || {});
    setViewerHasOpenProposal(!!row.hasOpenProposal);
    resetPagination();
    await fetchMessages(chatObj.id, 1);
    await markAllMessagesAsRead(chatObj.id);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  function openReqModal(row) {
    if (row.hasOpenProposal) {
      setToast("Есть неотвеченное предложение. Дождитесь ответа пользователя.");
      setTimeout(() => setToast(""), 2000);
      return;
    }
    // Предзаполнение только ALLOWED_FIELDS (+ okveds нормализуем)
    const initial = {};
    for (const k of ALLOWED_FIELDS) {
      if (k === "okveds") initial[k] = normalizeOkveds(row.ownerCompany?.okveds);
      else initial[k] = row.ownerCompany?.[k] || "";
    }
    setReqForm(initial);
    setReqTargetChatId(row.chat.id);
    setReqModalOpen(true);
  }

  function openReqModalFromViewer() {
    if (viewerHasOpenProposal) return; // блок
    const initial = {};
    for (const k of ALLOWED_FIELDS) {
      if (k === "okveds") initial[k] = normalizeOkveds(viewerOwnerCompany?.okveds);
      else initial[k] = viewerOwnerCompany?.[k] || "";
    }
    setReqForm(initial);
    setReqTargetChatId(viewerChat?.id || null);
    setReqModalOpen(true);
  }

  function addOkvedRow() {
    setReqForm((f) => ({ ...f, okveds: [...(f.okveds || []), { code: "", name: "" }] }));
  }
  function removeOkvedRow(idx) {
    setReqForm((f) => ({ ...f, okveds: (f.okveds || []).filter((_, i) => i !== idx) }));
  }
  function setOkvedField(idx, key, val) {
    setReqForm((f) => {
      const list = [...(f.okveds || [])];
      list[idx] = { ...(list[idx] || { code: "", name: "" }), [key]: val };
      return { ...f, okveds: list };
    });
  }

  async function sendReqToChat() {
    if (!reqTargetChatId) return;

    // безопасная проверка: нет ли "открытого" предложения сейчас
    const { data: msgs } = await supabase
      .from("chat_messages")
      .select("content, created_at")
      .eq("chat_id", reqTargetChatId)
      .order("created_at", { ascending: true });

    const lastProposal = (msgs || []).filter((m) =>
      String(m.content || "").startsWith("[COMPANY_CHANGE_PROPOSAL]")
    ).pop();
    const hasOpen = lastProposal
      ? !(msgs || []).some(
          (m) =>
            new Date(m.created_at) > new Date(lastProposal.created_at) &&
            (String(m.content || "").trim() === "Подтверждаю смену реквизитов" ||
              String(m.content || "").trim() === "Пользователь не принял изменения" ||
              String(m.content || "").startsWith("[COMPANY_CHANGE_CLOSED]"))
        )
      : false;
    if (hasOpen) {
      setReqModalOpen(false);
      setToast("Уже есть неотвеченное предложение. Повторная отправка запрещена.");
      setTimeout(() => setToast(""), 2000);
      return;
    }

    // Отправляем ТОЛЬКО разрешённые поля
    const payload = {};
    for (const k of ALLOWED_FIELDS) {
      if (k === "okveds") payload[k] = normalizeOkveds(reqForm?.okveds).filter((x) => x.code);
      else payload[k] = reqForm?.[k] ?? "";
    }

    await supabase.from("chat_messages").insert({
      chat_id: reqTargetChatId,
      user_id: user.id,
      content: "[COMPANY_CHANGE_PROPOSAL]\n" + JSON.stringify(payload, null, 2),
      read: false,
    });

    setReqModalOpen(false);
    setReqTargetChatId(null);
    setToast("Предложение отправлено пользователю");
    setTimeout(() => setToast(""), 1500);

    await refresh();
    if (viewerChat?.id === reqTargetChatId) {
      setViewerHasOpenProposal(true);
      setViewerCanAct(false);
      await fetchMessages(reqTargetChatId, 1);
    }
  }

  if (!canModerate) return <div className={styles.error}>Доступ запрещён</div>;
  if (loading) return <div className={styles.container}>Загрузка…</div>;

  return (
    <div>
      <h3>Запросы на смену реквизитов</h3>
      {toast && <div className={styles.toast}>{toast}</div>}

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Пользователь</th>
            <th>Создано</th>
            <th>Статус</th>
            <th>ИНН</th>
            <th>ОГРН</th>
            <th>Название</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => {
              const ownerName = displayName(row.ownerUserId, row.profilesById);
              const baseCanAct = row.status === "in_progress";
              const canAct = baseCanAct && !row.hasOpenProposal;
              return (
                <tr key={row.chat.id}>
                  <td>{ownerName}</td>
                  <td>{new Date(row.requestMsg.created_at).toLocaleString("ru-RU")}</td>
                  <td>
                    {row.status === "new" && (
                      <span style={{ color: "#ef4444", fontWeight: 700 }}>Новая</span>
                    )}
                    {row.status === "in_progress" && (
                      <span style={{ color: "#d97706", fontWeight: 700 }}>
                        В работе{row.hasOpenProposal ? " — предложение отправлено" : ""}
                      </span>
                    )}
                    {row.status === "confirmed" && (
                      <span style={{ color: "#10b981", fontWeight: 700 }}>Подтверждена</span>
                    )}
                    {row.status === "closed" && (
                      <span style={{ color: "#6b7280" }}>Закрыта</span>
                    )}
                  </td>
                  <td>{row.ownerCompany?.inn || "—"}</td>
                  <td>{row.ownerCompany?.ogrn || "—"}</td>
                  <td
                    style={{
                      maxWidth: 280,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.ownerCompany?.name || "—"}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {row.status === "new" && (
                      <button
                        className={styles.joinButton}
                        onClick={() => takeInWork(row.chat.id)}
                      >
                        Взять в работу
                      </button>
                    )}
                    <button
                      className={styles.joinButton}
                      onClick={() => openChat(row)}
                      style={{ marginLeft: 6 }}
                    >
                      Открыть чат
                    </button>
                    <button
                      className={styles.resolveButton}
                      onClick={() => openReqModal(row)}
                      style={{ marginLeft: 6, opacity: canAct ? 1 : 0.6 }}
                      disabled={!canAct}
                      title={
                        row.hasOpenProposal
                          ? "Уже есть неотвеченное предложение"
                          : baseCanAct
                          ? "Сменить реквизиты"
                          : "Доступно после «Взять в работу»"
                      }
                    >
                      Сменить реквизиты
                    </button>
                    <button
                      className={styles.fileInput}
                      onClick={() => closeRequest(row.chat.id)}
                      style={{
                        marginLeft: 6,
                        opacity: baseCanAct ? 1 : 0.6,
                      }}
                      disabled={!baseCanAct}
                      title={
                        baseCanAct ? "Закрыть без изменений" : "Доступно после «Взять в работу»"
                      }
                    >
                      Закрыть
                    </button>
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={7} style={{ textAlign: "center", padding: 16, opacity: 0.7 }}>
                Заявок нет
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Просмотр чата (оверлей) */}
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
            onClick={(e) => e.stopPropagation()}
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
          >
            <div
              className={msgStyles.chatHeader}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              <img src="/default-travel-image.png" alt="" className={msgStyles.chatAvatar} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontWeight: 600 }}>
                  Поддержка #{viewerChat.id.slice(0, 6)}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Окно администратора</div>
              </div>
              <button
                onClick={openReqModalFromViewer}
                style={{
                  marginLeft: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "6px 10px",
                  cursor: viewerCanAct ? "pointer" : "not-allowed",
                  background: "white",
                  opacity: viewerCanAct ? 1 : 0.6,
                }}
                title={
                  viewerHasOpenProposal
                    ? "Уже есть неотвеченное предложение"
                    : viewerCanAct
                    ? "Сменить реквизиты"
                    : "Доступно после «Взять в работу»"
                }
                disabled={!viewerCanAct || viewerHasOpenProposal}
              >
                Сменить реквизиты
              </button>
              <button
                onClick={closeViewer}
                style={{
                  marginLeft: 8,
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "6px 10px",
                  cursor: "pointer",
                  background: "white",
                }}
              >
                Закрыть окно
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
                  setMessages((prev) => [
                    ...prev,
                    { ...message, chat_message_files: files },
                  ]);
                  await fetchMessages(viewerChat.id, 1);
                  setTimeout(
                    () =>
                      messagesEndRef.current?.scrollIntoView({
                        behavior: "smooth",
                      }),
                    100
                  );
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Модалка «Сменить реквизиты» */}
      {reqModalOpen && (
        <div
          onClick={() => setReqModalOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 70,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 12,
              width: "min(820px,96vw)",
              maxHeight: "90vh",
              overflow: "auto",
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>
              Форма смены реквизитов (данные из Supabase)
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {[
                ["name", "Название / ФИО"],
                ["inn", "ИНН"],
                ["kpp", "КПП"],
                ["ogrn", "ОГРН/ОГРНИП"],
                ["legal_address", "Юр. адрес"],
                ["phone", "Телефон"],
                ["bank_name", "Банк"],
                ["payment_account", "Р/с"],
                ["payment_bik", "БИК"],
                ["payment_corr_account", "К/с"],
                ["payment_details", "Назначение платежа"],
                ["ceo_last_name", "Фамилия руководителя"],
                ["ceo_first_name", "Имя руководителя"],
                ["ceo_middle_name", "Отчество руководителя"],
              ].map(([key, label]) => (
                <div
                  key={key}
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <label style={{ fontSize: 12, opacity: 0.8 }}>{label}</label>
                  {key === "payment_details" || key === "legal_address" ? (
                    <textarea
                      value={reqForm[key] || ""}
                      onChange={(e) =>
                        setReqForm((f) => ({ ...f, [key]: e.target.value }))
                      }
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                      rows={2}
                    />
                  ) : (
                    <input
                      value={reqForm[key] || ""}
                      onChange={(e) =>
                        setReqForm((f) => ({ ...f, [key]: e.target.value }))
                      }
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>

            {/* ОКВЭДы */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>ОКВЭДы</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(reqForm.okveds || []).map((row, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "120px 1fr 90px",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <input
                      placeholder="Код"
                      value={row.code || ""}
                      onChange={(e) => setOkvedField(idx, "code", e.target.value)}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                    />
                    <input
                      placeholder="Наименование"
                      value={row.name || ""}
                      onChange={(e) => setOkvedField(idx, "name", e.target.value)}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "8px 10px",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => removeOkvedRow(idx)}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: "6px 10px",
                        background: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    onClick={addOkvedRow}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: "6px 10px",
                      background: "#fff",
                      cursor: "pointer",
                    }}
                  >
                    + Добавить ОКВЭД
                  </button>
                </div>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 12,
              }}
            >
              <button
                onClick={() => setReqModalOpen(false)}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "6px 10px",
                  background: "#fff",
                }}
              >
                Отмена
              </button>
              <button
                onClick={sendReqToChat}
                style={{
                  border: "1px solid #3b82f6",
                  borderRadius: 10,
                  padding: "6px 10px",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  fontWeight: 600,
                }}
                disabled={viewerHasOpenProposal}
                title={viewerHasOpenProposal ? "Уже есть неотвеченное предложение" : ""}
              >
                Отправить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
