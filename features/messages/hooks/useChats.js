import { useEffect, useMemo, useState } from "react";

export function useChats({ supabase, user }) {
  const [chats, setChats] = useState([]);
  const [profilesMap, setProfilesMap] = useState({});
  const [tripsMap, setTripsMap] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [isChatsLoaded, setIsChatsLoaded] = useState(false);

  // участники для текущего (панель вверху справа)
  const [participantsForCurrentChat, setParticipantsForCurrentChat] = useState([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);

  useEffect(() => {
    if (!isChatsLoaded && chats.length === 0) fetchChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChatsLoaded, user?.id]);

  async function fetchChats() {
    if (!user) return;
    setIsLoading(true);

    // 1) мои чаты (фильтр по участию — через !inner),
    // но не используем эту вложенную связь для списка участников
    const { data: myChatsRows, error: myChatsErr } = await supabase
      .from("chats")
      .select(`
        id, title, chat_type, is_group, created_at, trip_id, moderator_id,
        chat_participants!inner(user_id)
      `)
      .eq("chat_participants.user_id", user.id)
      .order("created_at", { ascending: false });

    if (myChatsErr) {
      console.error("Messages: Ошибка загрузки чатов:", myChatsErr);
      setIsLoading(false);
      setIsChatsLoaded(true);
      return;
    }

    // 2) сформируем базовые карточки чатов
    const dedup = new Map();
    const chatIds = [];
    const tripIds = new Set();

    (myChatsRows || []).forEach((row) => {
      if (!dedup.has(row.id)) {
        dedup.set(row.id, {
          id: row.id,
          title: row.title,
          chat_type: row.chat_type,
          is_group: row.is_group,
          created_at: row.created_at,
          trip_id: row.trip_id,
          moderator_id: row.moderator_id || null,
          participantsUserIds: [], // заполним ниже из отдельного запроса
        });
        chatIds.push(row.id);
        if (row.trip_id) tripIds.add(row.trip_id);
      }
    });

    // 3) ПОЛНЫЙ список участников для этих чатов (не только текущего пользователя)
    if (chatIds.length) {
      const { data: participants, error: partsErr } = await supabase
        .from("chat_participants")
        .select("chat_id, user_id")
        .in("chat_id", chatIds);

      if (!partsErr) {
        (participants || []).forEach((p) => {
          const c = dedup.get(p.chat_id);
          if (c) c.participantsUserIds.push(p.user_id);
        });
      }
    }

    // 4) Профили всех уникальных участников
    const allUserIds = Array.from(
      new Set(
        Array.from(dedup.values()).flatMap((c) => c.participantsUserIds || [])
      )
    );

    let profilesById = {};
    if (allUserIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, first_name, last_name, avatar_url")
        .in("user_id", allUserIds);

      profilesById = (profiles || []).reduce((acc, pr) => {
        acc[pr.user_id] = pr;
        return acc;
      }, {});
    }

    // 5) Карточки поездок (с fallback если "status" недоступен по политике)
    let tripsById = {};
    if (tripIds.size) {
      const ids = Array.from(tripIds);
      let trips = null;

      const withStatus = await supabase
        .from("trips")
        .select("id, title, image_urls, creator_id, status")
        .in("id", ids);

      if (withStatus.error) {
        const fallback = await supabase
          .from("trips")
          .select("id, title, image_urls, creator_id")
          .in("id", ids);
        trips = fallback.data;
      } else {
        trips = withStatus.data;
      }

      tripsById = (trips || []).reduce((acc, t) => {
        acc[t.id] = t;
        return acc;
      }, {});
    }

    setProfilesMap(profilesById);
    setTripsMap(tripsById);
    setChats(Array.from(dedup.values()));
    setIsLoading(false);
    setIsChatsLoaded(true);
  }

  // Состав чата (панель справа, вверху)
  async function fetchParticipantsForChat(chat) {
    if (!chat?.id) return;
    setParticipantsLoading(true);

    const { data: participants, error: partsErr } = await supabase
      .from("chat_participants")
      .select("chat_id, user_id")
      .eq("chat_id", chat.id);

    let profiles = [];
    if (!partsErr && participants?.length) {
      const ids = participants.map((p) => p.user_id);
      const { data: profilesRows } = await supabase
        .from("profiles")
        .select("user_id, first_name, last_name, avatar_url")
        .in("user_id", ids);
      profiles = profilesRows || [];
    }

    const organizerId = chat.trip_id ? tripsMap[chat.trip_id]?.creator_id : null;
    const sorted = [...profiles].sort((a, b) => {
      if (a.user_id === organizerId) return -1;
      if (b.user_id === organizerId) return 1;
      const an = `${a.last_name || ""} ${a.first_name || ""}`.trim().toLowerCase();
      const bn = `${b.last_name || ""} ${b.first_name || ""}`.trim().toLowerCase();
      return an.localeCompare(bn, "ru");
    });

    setParticipantsForCurrentChat(sorted);
    setParticipantsLoading(false);
  }

  return useMemo(
    () => ({
      chats, setChats,
      profilesMap, tripsMap,
      isLoading, isChatsLoaded,
      fetchChats,

      // участники текущего (правый верх)
      fetchParticipantsForChat,
      participantsForCurrentChat,
      participantsLoading,
    }),
    [
      chats, profilesMap, tripsMap, isLoading, isChatsLoaded,
      participantsForCurrentChat, participantsLoading
    ]
  );
}
