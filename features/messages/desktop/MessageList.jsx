// features/messages/desktop/MessageList.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import MessageAttachments from "../../../components/MessageAttachments";
import { groupMessagesByDate, formatDateDivider } from "../utils/chatUtils";
import { supabase } from "../../../lib/supabaseClient";

// Вспомогательная: нормализация ОКВЭДов
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

// Вспомогательная: скрыть системные теги при показе
function stripSystemTags(text = "") {
  if (typeof text !== "string") return "";
  return text.replace(
    /^\[(?:COMPANY_CHANGE_REQUEST|COMPANY_CHANGE_PROPOSAL|COMPANY_CHANGE_SUCCESS|COMPANY_CHANGE_FAIL|COMPANY_CHANGE_TAKEN|COMPANY_CHANGE_CLOSED|CLOSE_PROMPT|ADMIN_DECISION_PROPOSAL)\]\s*/i,
    ""
  );
}

/** ===== ReadReceipts (inline) =====
 * Под сообщением рисует до 5 аватарок прочитавших + бейдж для раскрытия поповера
 * со списками "Прочитали / Не прочитали".
 *
 * Ожидает на сообщении: chat_message_reads?: [{ user_id, read_at }]
 * Для вычисления «не прочитали» используется currentChat.participantsUserIds (если есть).
 */
function ReadReceiptsInline({
  message,
  participantsUserIds = [],
  profilesMap = {},
  align = "right", // "left" | "right" — куда выравнивать поповер
}) {
  const containerRef = useRef(null);
  const [open, setOpen] = useState(false);

  const rawReaders = Array.isArray(message?.chat_message_reads) ? message.chat_message_reads : [];
  const readersSet = useMemo(() => new Set(rawReaders.map((r) => r.user_id)), [rawReaders]);

  // Аудитория: все участники, кроме автора сообщения (если есть список участников)
  const audience = useMemo(() => {
    const set = new Set(participantsUserIds);
    if (set.size > 0) set.delete(message.user_id);
    if (set.size === 0 && rawReaders.length) {
      // fallback: когда нет списка участников, строим аудиторию по читателям (без автора)
      return Array.from(readersSet).filter((uid) => uid !== message.user_id);
    }
    return Array.from(set);
  }, [participantsUserIds, message.user_id, rawReaders, readersSet]);

  const readers = useMemo(
    () => audience.filter((uid) => readersSet.has(uid)),
    [audience, readersSet]
  );
  const nonReaders = useMemo(
    () => audience.filter((uid) => !readersSet.has(uid)),
    [audience, readersSet]
  );

  const topReaders = readers.slice(0, 5);
  const restCount = Math.max(0, readers.length - topReaders.length);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const getName = (uid) => {
    const p = profilesMap?.[uid];
    const full = `${p?.first_name || ""} ${p?.last_name || ""}`.trim();
    return full || uid;
  };
  const getAvatar = (uid) => profilesMap?.[uid]?.avatar_url || "/avatar-default.svg";

  if (audience.length === 0 || readers.length === 0) return null;

  return (
    <div ref={containerRef} style={{ marginTop: 4, display: "flex", justifyContent: "flex-end", gap: 4, userSelect: "none" }}>
      {/* до 5 аватарок */}
      {topReaders.map((uid) => (
        <img
          key={`${message.id}:reader:${uid}`}
          src={getAvatar(uid)}
          alt={getName(uid)}
          title={getName(uid)}
          style={{
            width: 16, height: 16, borderRadius: "9999px",
            border: "1px solid #fff", boxShadow: "0 1px 2px rgba(0,0,0,0.1)", cursor: "default"
          }}
        />
      ))}
      {/* кликабельный бейдж: +N или общее число, если ≤5 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Показать список прочитавших и непрочитавших"
        style={{
          fontSize: 11, padding: "0 6px", lineHeight: "18px",
          borderRadius: 999, background: "#e5e7eb", color: "#374151",
          border: "1px solid #e5e7eb", cursor: "pointer"
        }}
      >
        {restCount > 0 ? `+${restCount}` : `${readers.length}`}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            zIndex: 50,
            marginTop: 24,
            width: 300,
            borderRadius: 12,
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            border: "1px solid #e5e7eb",
            background: "#fff",
            padding: 12,
            ...(align === "left" ? { left: 8 } : { right: 8 }),
          }}
        >
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
            Сообщение #{message.id}
          </div>

          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
            Прочитали <span style={{ color: "#9ca3af", fontWeight: 500 }}>({readers.length})</span>
          </div>
          <ul style={{ maxHeight: 176, overflowY: "auto", paddingRight: 4, margin: 0, paddingLeft: 0 }}>
            {readers.map((uid) => (
              <li key={`read:${uid}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <img
                    src={getAvatar(uid)}
                    alt={getName(uid)}
                    style={{ width: 24, height: 24, borderRadius: 999, border: "1px solid #e5e7eb" }}
                  />
                  <div
                    title={getName(uid)}
                    style={{ fontSize: 13, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {getName(uid)}
                  </div>
                </div>
              </li>
            ))}
            {readers.length === 0 && (
              <li style={{ fontSize: 12, color: "#6b7280", padding: "4px 0" }}>Пока пусто</li>
            )}
          </ul>

          <div style={{ height: 1, background: "#e5e7eb", margin: "10px 0" }} />

          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
            Не прочитали <span style={{ color: "#9ca3af", fontWeight: 500 }}>({nonReaders.length})</span>
          </div>
          <ul style={{ maxHeight: 176, overflowY: "auto", paddingRight: 4, margin: 0, paddingLeft: 0 }}>
            {nonReaders.map((uid) => (
              <li key={`unread:${uid}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <img
                    src={getAvatar(uid)}
                    alt={getName(uid)}
                    style={{ width: 24, height: 24, borderRadius: 999, border: "1px solid #e5e7eb", opacity: 0.65 }}
                  />
                  <div
                    title={getName(uid)}
                    style={{ fontSize: 13, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {getName(uid)}
                  </div>
                </div>
              </li>
            ))}
            {nonReaders.length === 0 && (
              <li style={{ fontSize: 12, color: "#6b7280", padding: "4px 0" }}>Все прочитали</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function MessageList({
  messages = [],
  profilesMap = {},
  currentChat,
  myUserId,
  signFileUrl,
  chatMessagesRef,
  messagesEndRef,
  styles,
  disputeMeta,
  isMobileUI = false,
}) {

const isMobile =
    isMobileUI || (typeof window !== "undefined" && window.innerWidth <= 640);
  
const grouped = useMemo(() => groupMessagesByDate(messages), [messages]);

  const isSupportChat =
    currentChat?.chat_type === "support" || currentChat?.chat_type === "company_edit";
  const isDisputeChat = currentChat?.chat_type === "dispute";

  const [myCompany, setMyCompany] = useState(null);
  useEffect(() => {
    const load = async () => {
      if (!myUserId) return;
      const { data } = await supabase
        .from("mycompany")
        .select("*")
        .eq("user_id", myUserId)
        .eq("is_active", true)
        .maybeSingle();
      setMyCompany(data || null);
    };
    load();
  }, [myUserId]);

  const [confirmModal, setConfirmModal] = useState({
    open: false,
    proposal: null,
    diff: {},
    anchorMsgId: null,
  });

  // ===== stick-to-bottom: если пользователь был внизу, держим внизу даже когда "дорастут" вложения/reads =====
  const stickToBottomRef = useRef(true);

  const isNearBottom = (el, threshold = 140) => {
    if (!el) return true;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    return dist < threshold;
  };

const contentRef = useRef(null);

// замени scrollToBottom
const scrollToBottom = (behavior = "auto") => {
  if (!stickToBottomRef.current) return;
  const el = chatMessagesRef?.current;
  if (!el) return;

  if (behavior === "smooth") {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
};

  // ✅ При входе в чат: считаем что мы "внизу" и докручиваем после первичного рендера
  // (важно: 2 RAF + timeout — чтобы пережить появление плеера/галок/аватарок)
  useEffect(() => {
    stickToBottomRef.current = true;

    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => scrollToBottom("auto"));
      // контрольный “пинок” после догрузки signed_url/metadata
      const t = setTimeout(() => scrollToBottom("auto"), 250);

      return () => {
        cancelAnimationFrame(raf2);
        clearTimeout(t);
      };
    });

    return () => {
      cancelAnimationFrame(raf1);
    };
    // важно именно id чата, чтобы срабатывало при открытии другого чата
  }, [currentChat?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ✅ Любые изменения высоты списка (плеер → добавился футер/reads/картинка догрузилась)
useEffect(() => {
  const contentEl = contentRef?.current;
  if (!contentEl) return;
  if (typeof ResizeObserver === "undefined") return;

  const ro = new ResizeObserver(() => {
    scrollToBottom("auto");
  });

  ro.observe(contentEl);
  return () => ro.disconnect();
}, [currentChat?.id]); // chatMessagesRef тут уже не нужен

  // ✅ Новые сообщения: если пользователь был внизу — остаёмся внизу
  useEffect(() => {
    scrollToBottom("auto");
  }, [messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps


  async function answerClosePrompt(yes) {
  if (!currentChat) return;
  const chatId = currentChat.id;

  if (yes) {
    // 1) Сначала добавляем финальное сообщение «Да, чат можно закрыть»
    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: myUserId,
      content: "Да, чат можно закрыть",
      read: false,
    });

    // 2) Потом помечаем ВСЕ сообщения этого чата прочитанными
    // (и у пользователя, и у админа не останется висящих "непрочитанных")
    await supabase
      .from("chat_messages")
      .update({ read: true })
      .eq("chat_id", chatId)
      .or("read.is.null,read.eq.false");

    // 3) И только ПОСЛЕ этого переводим чат в архив
    await supabase
      .from("chats")
      .update({ chat_type: "archived", support_close_confirmed: true })
      .eq("id", chatId);

    // 4) Уведомляем UI
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("support-chat-archived", { detail: { chatId } })
      );
      window.dispatchEvent(new CustomEvent("support-finish-updated"));
    }
  } else {
    // Ветка "Нет, ещё есть вопросы" остаётся как была
    await supabase
      .from("chats")
      .update({ support_close_requested_at: null })
      .eq("id", chatId);

    await supabase.from("chat_messages").insert({
      chat_id: chatId,
      user_id: myUserId,
      content: "Нет, ещё есть вопросы",
      read: false,
    });

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("support-finish-updated"));
    }
  }
}


  async function answerDisputeProposal(yes, proposalTextRaw) {
    if (!currentChat || !disputeMeta) return;
    const chatId = currentChat.id;
    const myId = myUserId;
    const isInitiator = disputeMeta.initiator_id === myId;
    const isRespondent = disputeMeta.respondent_id === myId;
    if (!isInitiator && !isRespondent) return;

    if (yes) {
      const cleanedText = typeof proposalTextRaw === "string"
        ? proposalTextRaw.replace(/^\[(?:CLOSE_PROMPT|ADMIN_DECISION_PROPOSAL)\]\s*/i, "").trim()
        : (disputeMeta.close_proposal_text || null);

      const updates = {
        close_proposal_text: cleanedText,
        close_proposal_at: disputeMeta.close_proposal_at || new Date().toISOString(),
      };
      if (isInitiator) updates.initiator_confirmed = true;
      if (isRespondent) updates.respondent_confirmed = true;

      const { data: upd } = await supabase
        .from("disputes")
        .update(updates)
        .eq("id", disputeMeta.id)
        .select()
        .single();

      await supabase.from("chat_messages").insert({
        chat_id: chatId,
        user_id: myUserId,
        content: "Я подтверждаю завершение спора",
        read: false,
      });

      if (upd && upd.initiator_confirmed && upd.respondent_confirmed) {
        await supabase
          .from("disputes")
          .update({ locked: true, confirmed_at: new Date().toISOString() })
          .eq("id", disputeMeta.id);
        await supabase.from("chats").update({ support_close_confirmed: true }).eq("id", chatId);
      }
    } else {
      await supabase
        .from("disputes")
        .update({
          initiator_confirmed: false,
          respondent_confirmed: false,
          close_proposal_text: null,
          close_proposal_at: null,
          locked: false,
        })
        .eq("id", disputeMeta.id);

      await supabase.from("chat_messages").insert({
        chat_id: chatId,
        user_id: myUserId,
        content: "Нет, вопрос ещё не решён",
        read: false,
      });
    }
  }

  function parseProposal(text) {
    if (typeof text !== "string") return null;
    if (!text.startsWith("[COMPANY_CHANGE_PROPOSAL]")) return null;
    try {
      const json = text.replace("[COMPANY_CHANGE_PROPOSAL]", "").trim();
      return JSON.parse(json || "{}");
    } catch {
      return null;
    }
  }

  function buildDiff(oldRow, proposal) {
    const old = oldRow || {};
    const map = {
      name: ["name", old.name],
      inn: ["inn", old.inn],
      kpp: ["kpp", old.kpp],
      ogrn: ["ogrn", old.ogrn],
      legal_address: ["legal_address", old.legal_address || old.legalAddress],
      phone: ["phone", old.phone],
      bank_name: ["bank_name", old.bank_name],
      payment_account: ["payment_account", old.payment_account],
      payment_bik: ["payment_bik", old.payment_bik],
      payment_corr_account: ["payment_corr_account", old.payment_corr_account],
      payment_details: ["payment_details", old.payment_details],
      ceo_last_name: ["ceo_last_name", old.ceo_last_name],
      ceo_first_name: ["ceo_first_name", old.ceo_first_name],
      ceo_middle_name: ["ceo_middle_name", old.ceo_middle_name],
      okveds: ["okveds", normalizeOkveds(old.okveds)],
    };
    const out = {};
    Object.entries(map).forEach(([k, [, oldVal]]) => {
      const newVal = proposal?.[k];
      if (k === "okveds") {
        const oldN = normalizeOkveds(oldVal);
        const newN = normalizeOkveds(newVal);
        const changed = JSON.stringify(oldN) !== JSON.stringify(newN);
        out[k] = { oldVal: oldN, newVal: newN, changed };
      } else {
        out[k] = {
          oldVal: oldVal || "",
          newVal: newVal || "",
          changed: (oldVal || "") !== (newVal || ""),
        };
      }
    });
    return out;
  }

  function hasUserRespondedToProposal(propMsg) {
    const propTime = new Date(propMsg.created_at).getTime();
    return (messages || []).some((m) => {
      if (new Date(m.created_at).getTime() <= propTime) return false;
      if (m.user_id !== myUserId) return false;
      const txt = (m.content || "").trim();
      return (
        txt === "Подтверждаю смену реквизитов" ||
        txt === "Пользователь не принял изменения"
      );
    });
  }

// 🔹 НОВОЕ: проверка, отвечал ли пользователь на вопрос «Закрыть чат?»
  function hasUserAnsweredClosePrompt(propMsg) {
    const propTime = new Date(propMsg.created_at).getTime();
    return (messages || []).some((m) => {
      if (m.user_id !== myUserId) return false;
      if (new Date(m.created_at).getTime() <= propTime) return false;
      const txt = (m.content || "").trim();
      return (
        txt === "Да, чат можно закрыть" ||
        txt === "Нет, ещё есть вопросы"
      );
    });
  }

  async function confirmApplyChanges(proposal, anchorMsgId) {
    if (!currentChat?.id || !myUserId || !proposal) return;

    // фиксируем согласие пользователя
    await supabase.from("chat_messages").insert({
      chat_id: currentChat.id,
      user_id: myUserId,
      content: "Подтверждаю смену реквизитов",
      read: false,
    });

    // текущая компания
    const { data: currentRow } = await supabase
      .from("mycompany")
      .select("company_id, tbank_shop_code, tbank_code")
      .eq("user_id", myUserId)
      .eq("is_active", true)
      .single();

    if (!currentRow?.company_id) {
      setConfirmModal({ open: false, proposal: null, diff: {}, anchorMsgId: null });
      return;
    }

    // Сначала Т-Банк
    const shopCode =
      (currentRow.tbank_shop_code && /^\d+$/.test(String(currentRow.tbank_shop_code)))
        ? String(currentRow.tbank_shop_code)
        : ((currentRow.tbank_code && /^\d+$/.test(String(currentRow.tbank_code))) ? String(currentRow.tbank_code) : null);

    let tbResp = null;
    let tbOk = false;
    let tbMsg = "";

    try {
      if (shopCode) {
        const body = {
          shopCode,
          name: proposal.name || null,
          inn: proposal.inn || null,
          kpp: proposal.kpp || null,
          ogrn: proposal.ogrn || null,
          legal_address: proposal.legal_address || null,
          phone: proposal.phone || null,
          bank_name: proposal.bank_name || null,
          payment_account: proposal.payment_account || null,
          payment_bik: proposal.payment_bik || null,
          payment_corr_account: proposal.payment_corr_account || null,
          payment_details: proposal.payment_details || null,
        };
        const resp = await fetch("/api/tbank/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        tbResp = await resp.json().catch(() => ({}));
        tbOk = resp.ok && tbResp?.success !== false;

        if (!tbOk) {
          const steps = tbResp?.steps || {};
          const errs = [];
          if (steps.bankAccount?.status === "error") errs.push(steps.bankAccount.message);
          if (steps.inn?.status === "error") errs.push(steps.inn.message);
          if (steps.kpp?.status === "error") errs.push(steps.kpp.message);
          if (steps.ogrn?.status === "error") errs.push(steps.ogrn.message);
          if (steps.legal_address?.status === "error") errs.push(steps.legal_address.message);
          if (steps.phone?.status === "error") errs.push(steps.phone.message);
          if (steps.general?.status === "error") errs.push(steps.general.message);
          const base = errs.length
            ? `Не удалось применить изменения в Т-Банк: ${errs.join(" ")}`
            : (tbResp?.error || "Не удалось применить изменения в Т-Банк.");
          tbMsg = `[COMPANY_CHANGE_FAIL] ${base}`;
        }
      } else {
        tbOk = false;
        tbMsg = `[COMPANY_CHANGE_FAIL] Синхронизация с Т-Банк невозможна: отсутствует код магазина (shopCode).`;
      }
    } catch (e) {
      tbOk = false;
      tbMsg = `[COMPANY_CHANGE_FAIL] Ошибка при синхронизации с Т-Банк: ${e?.message || "неизвестная ошибка"}.`;
    }

    if (tbOk) {
      // затем — наша БД
      const patch = {
        name: proposal.name || null,
        inn: proposal.inn || null,
        kpp: proposal.kpp || null,
        ogrn: proposal.ogrn || null,
        legal_address: proposal.legal_address || null,
        phone: proposal.phone || null,
        bank_name: proposal.bank_name || null,
        payment_account: proposal.payment_account || null,
        payment_bik: proposal.payment_bik || null,
        payment_corr_account: proposal.payment_corr_account || null,
        payment_details: proposal.payment_details || null,
        ceo_last_name: proposal.ceo_last_name || null,
        ceo_first_name: proposal.ceo_first_name || null,
        ceo_middle_name: proposal.ceo_middle_name || null,
        okveds: normalizeOkveds(proposal.okveds) || [],
      };
      await supabase.from("mycompany").update(patch).eq("company_id", currentRow.company_id);

      await supabase.from("chat_messages").insert({
        chat_id: currentChat.id,
        user_id: myUserId,
        content: "[COMPANY_CHANGE_SUCCESS] Т-Банк принял изменения. Платформа ОНЛОК обновила реквизиты.",
        read: false,
      });
      await supabase
  .from("chats")
  .update({ chat_type: "archived", support_close_confirmed: true })
  .eq("id", currentChat.id);

// ✅ синхронизируем UI сразу, без перезагрузки
if (typeof window !== "undefined") {
  window.dispatchEvent(new CustomEvent("support-chat-archived", { detail: { chatId: currentChat.id } }));
  window.dispatchEvent(new CustomEvent("support-finish-updated"));
}

    } else {
      // ошибка — статус «в работе», ОНЛОК не обновляем
      await supabase.from("chat_messages").insert({
        chat_id: currentChat.id,
        user_id: myUserId,
        content: tbMsg,
        read: false,
      });
    }

    setConfirmModal({ open: false, proposal: null, diff: {}, anchorMsgId: null });
  }

  async function rejectChanges(anchorMsgId) {
    if (!currentChat?.id || !myUserId) return;
    await supabase.from("chat_messages").insert({
      chat_id: currentChat.id,
      user_id: myUserId,
      content: "Пользователь не принял изменения",
      read: false,
    });
    setConfirmModal({ open: false, proposal: null, diff: {}, anchorMsgId: null });
  }

  function renderMessage(msg) {
    const sender = profilesMap[msg.user_id];
    const senderNameRaw = sender
      ? `${sender.first_name || ""} ${sender.last_name || ""}`.trim()
      : "Участник";
    const senderName =
      isDisputeChat && currentChat?.moderator_id && msg.user_id === currentChat.moderator_id
        ? "Администрация сайта"
        : senderNameRaw;
    const isMine = msg.user_id === myUserId;

    // читаем квитанции прочтения (chat_message_reads) — приходят по Realtime
    const readersArr = Array.isArray(msg.chat_message_reads)
      ? msg.chat_message_reads
      : [];

    // если есть хотя бы одна квитанция от кого-то (в саппорте это другой участник),
    // считаем, что сообщение "прочитано собеседником"
    const hasAnyReader = readersArr.length > 0;

    // финальный статус для галочек:
    //  - msg.read оставляем для совместимости со старой логикой
    //  - hasAnyReader — новая, более точная логика по квитанциям
    const isDoubleTick = msg.read || hasAnyReader;


    const isClosePrompt =
      typeof msg.content === "string" && msg.content.startsWith("[CLOSE_PROMPT]");
    const isAdminDecisionPrompt =
      typeof msg.content === "string" && msg.content.startsWith("[ADMIN_DECISION_PROPOSAL]");

    // Для диспутов опрос должен реагировать на тег ADMIN_DECISION_PROPOSAL
    const isDisputeProposal = isDisputeChat && isAdminDecisionPrompt;

    const canRespondDispute =
      isDisputeProposal &&
      !isMine &&
      !!disputeMeta &&
      ((myUserId === disputeMeta.initiator_id && !disputeMeta.initiator_confirmed) ||
        (myUserId === disputeMeta.respondent_id && !disputeMeta.respondent_confirmed));

const canRespondClosePrompt =
      isSupportChat && isClosePrompt && !isMine && !hasUserAnsweredClosePrompt(msg);

    const proposal = parseProposal(msg.content || "");
    const canRespondRequisites =
      isSupportChat && !!proposal && !isMine && !hasUserRespondedToProposal(msg);

    const visibleText = stripSystemTags(msg.content || "");

    return (
      <div
        key={msg.id}
        className={`${styles.message} ${isMine ? styles.messageSent : styles.messageReceived}`}
      >
        <div className={styles.messageBubble}>
          {currentChat.is_group && !isMine && (
            <div className={styles.messageSenderName}>{senderName || "Участник"}</div>
          )}

          {canRespondDispute ? (
            /* Диспутный опрос */
            <div className={styles.messageContent}>
              <div style={{ marginBottom: 6 }}>
                {visibleText /* уже без [ADMIN_DECISION_PROPOSAL] */}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={styles.sendButton}
                  onClick={() => answerDisputeProposal(true, msg.content)}
                >
                  Да
                </button>
                <button
                  className={styles.pmIconButton}
                  onClick={() => answerDisputeProposal(false, msg.content)}
                >
                  Нет
                </button>
              </div>
            </div>
          ) : canRespondClosePrompt ? (
            /* Ветка: пользователь ещё НЕ отвечал — активные кнопки */
            <div className={styles.messageContent}>
              <div style={{ marginBottom: 6 }}>
                {visibleText /* уже без [CLOSE_PROMPT] */}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className={styles.sendButton}
                  onClick={() => answerClosePrompt(true)}
                >
                  Да
                </button>
                <button
                  className={styles.pmIconButton}
                  onClick={() => answerClosePrompt(false)}
                >
                  Нет
                </button>
              </div>
            </div>
          ) : isSupportChat && isClosePrompt && !isMine && hasUserAnsweredClosePrompt(msg) ? (
            /* Ветка: пользователь УЖЕ ответил — кнопки есть, но затемнены и disabled */
            <div className={styles.messageContent}>
              <div style={{ marginBottom: 6 }}>
                {visibleText /* уже без [CLOSE_PROMPT] */}
              </div>
              <div style={{ display: "flex", gap: 8, opacity: 0.5 }}>
                <button className={styles.sendButton} disabled>
                  Да
                </button>
                <button className={styles.pmIconButton} disabled>
                  Нет
                </button>
              </div>
            </div>
          ) : proposal ? (
            <div className={styles.messageContent}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Администрация сменила реквизиты компании. Подтвердите изменения.
              </div>

              {canRespondRequisites ? (
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button
                    className={styles.sendButton}
                    onClick={() =>
                      setConfirmModal({
                        open: true,
                        proposal,
                        diff: buildDiff(myCompany, proposal),
                        anchorMsgId: msg.id,
                      })
                    }
                  >
                    Подтвердить
                  </button>
                  <button
                    className={styles.pmIconButton}
                    onClick={() => rejectChanges(msg.id)}
                  >
                    Нет
                  </button>
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  {isMine ? "" : "Ответ уже был дан или ожидается следующий этап."}
                </div>
              )}
            </div>
          ) : (
            msg.content && (
              <p className={styles.messageContent}>
                {visibleText /* любая прочая фраза без служебных тегов */}
              </p>
            )
          )}

          {Array.isArray(msg.chat_message_files) && msg.chat_message_files.length > 0 && (
            <>
              <MessageAttachments files={msg.chat_message_files} signFileUrl={signFileUrl} />
              {isSupportChat && (
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  Файл будет удалён через 5 дней после завершения решения вашего вопроса.
                </div>
              )}
            </>
          )}

{/* Футер пузыря: время + статус для своих сообщений */}
<div className={styles.messageFooter}>
  <span className={styles.messageTime}>
    {new Date(msg.created_at).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    })}
  </span>

  {isMine && (
    <span className={styles.messageStatus}>
      {isDoubleTick ? "✓✓" : "✓"}
    </span>
  )}
</div>


          {/* NEW: квитанции прочтения — только в групповых чатах */}
          {currentChat.is_group && (
            <ReadReceiptsInline
              message={msg}
              participantsUserIds={Array.isArray(currentChat?.participantsUserIds) ? currentChat.participantsUserIds : []}
              profilesMap={profilesMap}
              align={isMine ? "right" : "left"}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <>
<div
  ref={chatMessagesRef}
  className={styles.chatMessages}
  onScroll={(e) => {
    const el = e.currentTarget;
    stickToBottomRef.current = isNearBottom(el, 140);
  }}
>
  <div ref={contentRef}>
    {Object.keys(grouped).map((date) => (
      <div key={date}>
        <div className={styles.dateDivider}>{formatDateDivider(date)}</div>
        {grouped[date].map((msg) => renderMessage(msg))}
      </div>
    ))}
    <div ref={messagesEndRef} />
  </div>
</div>

{confirmModal.open && (
  <div
    onClick={() => setConfirmModal({ open: false, proposal: null, diff: {}, anchorMsgId: null })}
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.35)",
      display: "flex",
      alignItems: isMobile ? "flex-end" : "center",
      justifyContent: "center",
      zIndex: 80,
      padding: isMobile ? "10px" : 0,
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: "#fff",
        borderRadius: 12,
        width: isMobile ? "100%" : "min(760px,96vw)",
        maxHeight: isMobile ? "85vh" : "90vh",
        overflow: "auto",
        padding: isMobile ? 12 : 16,
        boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
      }}
    >
      <div style={{ fontWeight: 800, fontSize: isMobile ? 16 : 15, marginBottom: 10 }}>
        Подтвердить изменения реквизитов?
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", // ✅ мобилка = 1 колонка
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
        ].map(([key, label]) => {
          const cell = confirmModal.diff[key] || { newVal: "", oldVal: "", changed: false };
          const newText = cell.newVal ? String(cell.newVal) : "—";
          const oldText = cell.oldVal ? String(cell.oldVal) : "—";

          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>

              <div
                style={{
                  border: "1px solid " + (cell.changed ? "#fdba74" : "#e5e7eb"),
                  borderRadius: 10,
                  padding: "10px 10px",
                  background: cell.changed ? "#fff7ed" : "#fff",
                  fontSize: isMobile ? 14 : 13,
                  lineHeight: 1.25,
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                }}
              >
                {newText}
              </div>

              {cell.changed ? (
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.7,
                    lineHeight: 1.25,
                    wordBreak: "break-word",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  Было: {oldText}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>ОКВЭДы</div>
        {(() => {
          const cell = confirmModal.diff.okveds || { newVal: [], oldVal: [], changed: false };
          const newArr = Array.isArray(cell.newVal) ? cell.newVal : [];
          const oldArr = Array.isArray(cell.oldVal) ? cell.oldVal : [];

          return (
            <div
              style={{
                border: "1px solid " + (cell.changed ? "#fdba74" : "#e5e7eb"),
                borderRadius: 10,
                padding: "10px 10px",
                background: cell.changed ? "#fff7ed" : "#fff",
                fontSize: isMobile ? 14 : 13,
                lineHeight: 1.25,
              }}
            >
              {newArr.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {newArr.map((x, i) => (
                    <li key={`${x.code}-${i}`} style={{ wordBreak: "break-word" }}>
                      {x.name ? `${x.code} — ${x.name}` : x.code}
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              )}

              {cell.changed ? (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                  Было:{" "}
                  {(oldArr || [])
                    .map((x) => (x?.name ? `${x.code} — ${x.name}` : x?.code || ""))
                    .filter(Boolean)
                    .join("; ") || "—"}
                </div>
              ) : null}
            </div>
          );
        })()}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button
          onClick={() => setConfirmModal({ open: false, proposal: null, diff: {}, anchorMsgId: null })}
          className={styles.pmIconButton}
        >
          Нет
        </button>
        <button
          onClick={() => confirmApplyChanges(confirmModal.proposal, confirmModal.anchorMsgId)}
          className={styles.sendButton}
        >
          Да
        </button>
      </div>
    </div>
  </div>
)}

    </>
  );
}
