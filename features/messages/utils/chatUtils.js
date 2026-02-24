export function dedupeMessages(list = []) {
  const byId = new Map();
  for (const m of list) {
    if (!m || m.id == null) continue;
    const prev = byId.get(m.id);
    if (!prev) byId.set(m.id, m);
    else {
      const a = new Date(prev.created_at || 0).getTime();
      const b = new Date(m.created_at || 0).getTime();
      byId.set(m.id, b >= a ? m : prev);
    }
  }
  return Array.from(byId.values()).sort(
    (x, y) => new Date(x.created_at) - new Date(y.created_at)
  );
}

export function dedupeFiles(list = []) {
  const seen = new Set();
  const out = [];
  for (const f of list || []) {
    const key = f?.id ?? `${f?.bucket || ""}:${f?.path || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function getOrganizerId(chat, tripsMap) {
  return chat?.trip_id ? (tripsMap[chat.trip_id]?.creator_id || null) : null;
}

export function getOtherParticipantId(chat, myId) {
  const ids = chat?.participantsUserIds || [];
  return ids.find((id) => id !== myId) || null;
}

export function renderChatTitle(chat, tripsMap, profilesMap, myId) {
  if (!chat) return "";

  // Лейбл даты: 01.01.2025
  const createdLabel = chat.created_at
    ? new Date(chat.created_at).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : null;

  // Архивный чат поддержки: не групповой, без поездки, тип archived
  const isArchivedSupportLike =
    chat.chat_type === "archived" &&
    !chat.is_group &&
    !chat.trip_id;

  // Обычные живые чаты поддержки (вкладка "Поддержка")
  if (chat.chat_type === "support" || chat.chat_type === "company_edit") {
    return chat.title || "Поддержка";
  }

  // Архивные чаты поддержки во вкладке "Архивные"
  if (isArchivedSupportLike) {
    return createdLabel
      ? `Чат поддержки от ${createdLabel}`
      : "Чат поддержки (архив)";
  }

  // Далее — логика как была
  const tripTitle = chat.trip_id ? (tripsMap[chat.trip_id]?.title || "") : "";

  if (chat.chat_type === "trip_private") {
    const otherId = getOtherParticipantId(chat, myId);
    const other = otherId ? profilesMap[otherId] : null;
    const name = other ? `${other.first_name || ""} ${other.last_name || ""}`.trim() : "";
    return name || tripTitle || "Личный чат";
  }

  return tripTitle || chat.title || `Групповой чат ${chat.id}`;
}

export function groupMessagesByDate(messages = []) {
  return messages.reduce((acc, msg) => {
    const date = new Date(msg.created_at).toLocaleDateString("ru-RU", {
      day: "numeric", month: "long", year: "numeric",
    });
    (acc[date] ||= []).push(msg);
    return acc;
  }, {});
}

export function formatDateDivider(dateStr) {
  const today = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  if (dateStr === today) return "Сегодня";
  if (dateStr === yesterday) return "Вчера";
  return dateStr;
}

export function computeTabCounts(chats = [], tripsMap = {}) {
  const counters = { active: 0, support: 0, archived: 0 };

  for (const c of chats) {
    const tripStatus = c.trip_id ? (tripsMap[c.trip_id]?.status || null) : null;
    const isSupport = c.chat_type === "support" || c.chat_type === "company_edit";

    if (isSupport) {
      counters.support++;
      continue;
    }

    const isActiveTripGroup =
      c.is_group && c.chat_type === "trip_group" && tripStatus !== "archived";

    // ✅ как в chatMatchesTab:
    const isArchivedTripGroup =
      c.is_group &&
      (
        (c.chat_type === "trip_group" && tripStatus === "archived") ||
        (c.chat_type === "archived" && !!c.trip_id)
      );

    const isArchivedSupportLike =
      c.chat_type === "archived" && !c.is_group && !c.trip_id;

    const isArchivedChat = isArchivedTripGroup || isArchivedSupportLike;

    if (isActiveTripGroup) counters.active++;
    else if (isArchivedChat) counters.archived++;
  }

  return counters;
}
