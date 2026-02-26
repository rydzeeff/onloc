import { useState, useEffect, useLayoutEffect, createContext, useContext } from 'react';
import { useRouter } from 'next/router';
import { supabase } from '../lib/supabaseClient';
import { initializeRealtime, cleanupRealtime } from '../lib/realtime';
import 'react-image-crop/dist/ReactCrop.css';
import '../styles/foundation.css';
import '../styles/globals.css';

export const AuthContext = createContext();
export const useAuth = () => useContext(AuthContext);

/* ---------------- notifications (глобальные счётчики) ---------------- */
export const notifications = {
  unreadCounts: {},
  listeners: [],
  addListener(listener) { this.listeners.push(listener); },
  removeListener(listener) { this.listeners = this.listeners.filter((l) => l !== listener); },

  notifyListeners() {
    this.listeners.forEach((l) => l(this.unreadCounts));
    try {
      console.groupCollapsed("[notify] chat-unread-changed");
      console.log("payload:", { ...this.unreadCounts });
      console.groupEnd();
      window.dispatchEvent(
        new CustomEvent("chat-unread-changed", {
          detail: { source: "notifications", unread: { ...this.unreadCounts } },
        })
      );
    } catch {}
  },

  setUnreadCount(chatId, count) { this.unreadCounts[chatId] = count; this.notifyListeners(); },
  incrementUnreadCount(chatId) { this.unreadCounts[chatId] = (this.unreadCounts[chatId] || 0) + 1; this.notifyListeners(); },
  resetUnreadCount(chatId) { this.unreadCounts[chatId] = 0; this.notifyListeners(); },
  getTotalUnread() { return Object.values(this.unreadCounts).reduce((a, b) => a + b, 0); },
};

/* ---------------- звук: обвязка ---------------- */
let lastSoundTime = 0;
const soundCooldown = 1000;
const playedMessages = new Set();
const myChatMembership = new Set();

const SOUND_CHANNEL_NAME = 'chat_sound_channel';
let isLeaderTab = false;
let broadcastChannel = null;

/* ---------------- helpers ---------------- */
const getCookieHasProfile = () => {
  try { return document.cookie.split('; ').some((c) => c === 'onloc_hp=1'); } catch { return false; }
};
const setCookieHasProfile = (val) => {
  try {
    if (val) document.cookie = `onloc_hp=1; path=/; max-age=31536000; samesite=lax`;
    else document.cookie = `onloc_hp=; path=/; max-age=0; samesite=lax`;
  } catch {}
};

function MyApp({ Component, pageProps }) {
  const router = useRouter();

  // auth/session
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  // audio
  const [audioContext, setAudioContext] = useState(null);
  const [soundBuffer, setSoundBuffer] = useState(null);
  const [pendingSounds, setPendingSounds] = useState([]);

  // misc ui state
  const [geolocation, setGeolocation] = useState(null);
  const [geolocationLoading, setGeolocationLoading] = useState(true);
  const [profileChecked, setProfileChecked] = useState(false);
  const [hasProfile, setHasProfile] = useState(null); // null = неизвестно, true/false = подтверждено
  const [isLocalStorageAvailable, setIsLocalStorageAvailable] = useState(true);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [isProcessing, setProcessing] = useState(false);

// ✅ показываем оверлей "processing" только если загрузка длится дольше порога (чтобы не мигал)
const [showProcessingOverlay, setShowProcessingOverlay] = useState(false);

useEffect(() => {
  let t;
  if (isProcessing) {
    t = setTimeout(() => setShowProcessingOverlay(true), 450); // порог под себя
  } else {
    setShowProcessingOverlay(false);
  }
  return () => t && clearTimeout(t);
}, [isProcessing]);

  // После завершения навигации разрешаем следующие redirect-guards.
  useEffect(() => {
    const releaseRedirectLock = () => setIsRedirecting(false);
    router.events.on('routeChangeComplete', releaseRedirectLock);
    router.events.on('routeChangeError', releaseRedirectLock);
    return () => {
      router.events.off('routeChangeComplete', releaseRedirectLock);
      router.events.off('routeChangeError', releaseRedirectLock);
    };
  }, [router.events]);


  // блокируем рендер сетапа на клиенте до редиректа
  const [blockSetupRender, setBlockSetupRender] = useState(false);

  /* --- CSS var для моб. высоты --- */
  useEffect(() => {
    const setVhVariable = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setVhVariable();
    window.addEventListener('resize', setVhVariable);
    return () => window.removeEventListener('resize', setVhVariable);
  }, []);

  /* --- Авторизация + BroadcastChannel лидер-вкладки --- */
  useEffect(() => {
    try {
      localStorage.setItem('test', 'test');
      localStorage.removeItem('test');
      setIsLocalStorageAvailable(true);
    } catch {
      setIsLocalStorageAvailable(false);
    }

    // SPEED: жёсткий предел первичного лоадера
    const INITIAL_CAP_MS = 1200;
    const capTimer = setTimeout(() => {
      setIsInitialLoading(false);
      setLoading(false);
    }, INITIAL_CAP_MS);

    // SPEED: вместо тяжёлого getSession с 10с таймаутом подписываемся и используем session из колбэка
    const { data: authListener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      console.log('[authStateChange] Event:', event);
      setSession(nextSession || null);
      setUser(nextSession?.user ?? null);
      setLoading(false);
      // как только хоть какая сессия пришла — снимаем первичный лоадер
      setIsInitialLoading(false);
    });

    // SPEED: пытаемся быстро прочитать локальную сессию (не блокируем UI)
    supabase.auth.getSession()
      .then(({ data: { session: s } }) => {
        if (s) {
          setSession(s);
          setUser(s.user ?? null);
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setIsInitialLoading(false);
      });

    // BroadcastChannel: выбираем лидер-вкладку
    console.time('broadcastChannelSetup');
    broadcastChannel = new BroadcastChannel(SOUND_CHANNEL_NAME);
    const tabId = Math.random().toString(36).slice(2);
    broadcastChannel.postMessage({ type: 'CHECK_LEADER', tabId });
    let leaderTimeout = setTimeout(() => {
      isLeaderTab = true;
      broadcastChannel.postMessage({ type: 'SET_LEADER', tabId });
      console.log('[broadcastChannel] Tab became leader:', tabId);
    }, 500);

    broadcastChannel.onmessage = (event) => {
      const { type, tabId: sender } = event.data || {};
      if (type === 'CHECK_LEADER' && isLeaderTab) {
        broadcastChannel.postMessage({ type: 'LEADER_EXISTS', tabId });
      } else if (type === 'LEADER_EXISTS' && sender !== tabId) {
        clearTimeout(leaderTimeout);
        isLeaderTab = false;
        console.log('[broadcastChannel] Leader exists, tab is not leader:', tabId);
      } else if (type === 'SET_LEADER' && sender !== tabId) {
        isLeaderTab = false;
        console.log('[broadcastChannel] Other tab set as leader:', sender);
      } else if (type === 'PLAY_SOUND' && sender !== tabId) {
        playedMessages.add(event.data.messageId);
      }
    };
    console.timeEnd('broadcastChannelSetup');

    return () => {
      authListener.subscription.unsubscribe();
      clearTimeout(capTimer);
      clearTimeout(leaderTimeout);
      try { broadcastChannel?.close(); } catch {}
      isLeaderTab = false;
    };
  }, [router]);

  /* --- РАННИЙ guard: не показывать /profile/setup, если уже заполнено --- */
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    if (router.pathname !== '/profile/setup') { setBlockSetupRender(false); return; }

    console.time('checkProfileSetup');
    const ls = (() => {
      try { return localStorage.getItem('hasProfile'); } catch { return null; }
    })();
    const cookieHas = getCookieHasProfile();
    const cachedHasProfile = (ls === 'true') || cookieHas;

    if (cachedHasProfile) {
      setBlockSetupRender(true);
      router.replace('/trips');
      console.log('[checkProfileSetup] Redirecting to /trips due to positive cache');
    } else {
      setBlockSetupRender(false);
    }
    console.timeEnd('checkProfileSetup');
  }, [router.pathname]);

  /* --- Геолокация (как было, с кэшем) --- */
  useEffect(() => {
    const setInitialGeolocation = async () => {
      console.time('setInitialGeolocation');
      const authRoutes = ['/auth', '/auth/register', '/auth/recover', '/auth/update-password'];
      if (authRoutes.includes(router.pathname)) {
        setGeolocation(null);
        setGeolocationLoading(false);
        console.log('[setInitialGeolocation] Skipped: auth route');
        console.timeEnd('setInitialGeolocation');
        return;
      }

      if (isLocalStorageAvailable) {
        const cachedCoords = localStorage.getItem('geolocationCoords');
        const geolocationAllowed = localStorage.getItem('geolocationAllowed');
        const geolocationDenied = localStorage.getItem('geolocationDenied');
        const deniedData = geolocationDenied ? JSON.parse(geolocationDenied) : null;
        const oneDay = 86400000, now = Date.now();

        if (cachedCoords && geolocationAllowed === 'true') {
          setGeolocation(JSON.parse(cachedCoords));
          setGeolocationLoading(false);
          console.log('[setInitialGeolocation] Using cached coordinates:', cachedCoords);
          console.timeEnd('setInitialGeolocation');
          return;
        }
        if (geolocationDenied && deniedData && (now - deniedData.timestamp < oneDay)) {
          setGeolocation(null);
          setGeolocationLoading(false);
          console.log('[setInitialGeolocation] Geolocation denied in cache');
          console.timeEnd('setInitialGeolocation');
          return;
        }
      }

      if (navigator.geolocation) {
        const timeout = 10000;
        const geoPromise = new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout });
        });
        try {
          const pos = await Promise.race([geoPromise, new Promise((_, rj) => setTimeout(() => rj(new Error('Geolocation timeout')), timeout))]);
          const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          setGeolocation(coords);
          if (isLocalStorageAvailable) {
            localStorage.setItem('geolocationCoords', JSON.stringify(coords));
            localStorage.setItem('geolocationAllowed', 'true');
            localStorage.removeItem('geolocationDenied');
          }
          console.log('[setInitialGeolocation] Geolocation retrieved:', coords);
        } catch (err) {
          console.error('[setInitialGeolocation] Error:', {
            name: err.name,
            code: err.code,
            message: err.message,
          });

          if (isLocalStorageAvailable && err && err.code === 1) {
            // code === 1 — пользователь явно запретил геолокацию
            localStorage.setItem('geolocationDenied', JSON.stringify({ timestamp: Date.now() }));
            localStorage.removeItem('geolocationAllowed');
          }
          // для таймаутов и временных ошибок кэш deny НЕ ставим
          setGeolocation(null);
        }

      } else {
        console.log('[setInitialGeolocation] Geolocation API not available');
        setGeolocation(null);
      }
      setGeolocationLoading(false);
      console.timeEnd('setInitialGeolocation');
    };

    const checkGeolocationPermission = async () => {
      console.time('checkGeolocationPermission');
      if (!navigator.permissions || !navigator.permissions.query) {
        console.log('[checkGeolocationPermission] Permissions API not available');
        await setInitialGeolocation();
        console.timeEnd('checkGeolocationPermission');
        return;
      }
      try {
        const permissionStatus = await navigator.permissions.query({ name: 'geolocation' });
        if (permissionStatus.state === 'granted' && isLocalStorageAvailable) {
          const cachedCoords = localStorage.getItem('geolocationCoords');
          if (cachedCoords) {
            setGeolocation(JSON.parse(cachedCoords));
            setGeolocationLoading(false);
            console.log('[checkGeolocationPermission] Using cached coords for granted permission');
            console.timeEnd('checkGeolocationPermission');
            return;
          }
        }
        await setInitialGeolocation();
        permissionStatus.onchange = () => {
          if (permissionStatus.state === 'denied' && isLocalStorageAvailable) {
            localStorage.setItem('geolocationDenied', JSON.stringify({ timestamp: Date.now() }));
            localStorage.removeItem('geolocationAllowed');
            setGeolocation(null);
            setGeolocationLoading(false);
            console.log('[checkGeolocationPermission] Permission denied, updating state');
          } else if (permissionStatus.state === 'granted') {
            console.log('[checkGeolocationPermission] Permission granted, rechecking');
            setInitialGeolocation();
          }
        };
      } catch (err) {
        console.error('[checkGeolocationPermission] Error:', err.message);
        await setInitialGeolocation();
      }
      console.timeEnd('checkGeolocationPermission');
    };

    checkGeolocationPermission();
  }, [user, isLocalStorageAvailable, router.pathname]);

  /* --- realtime + начальные непрочитанные --- */
  useEffect(() => {
    if (!user) return;
    const init = async () => {
      console.time('fetchInitialUnread');
      await fetchInitialUnread(user); // SPEED: внутри теперь 1 запрос вместо N
      console.timeEnd('fetchInitialUnread');
      console.log('[realtime] Initializing realtime for user:', user.id);
      initializeRealtime(user.id, (newMessage) => handleNewMessage(newMessage, user));
    };
    init();
  }, [user]);

// ✅ sync unread across devices: когда Я прочитал на другом устройстве — обновить бейджи тут
useEffect(() => {
  if (!user?.id) return;

  const timers = new Map(); // chatId -> timeout
  const debounceMs = 250;

  const scheduleRecalc = (chatId) => {
    if (!chatId) return;

    const prev = timers.get(chatId);
    if (prev) clearTimeout(prev);

    const t = setTimeout(async () => {
      timers.delete(chatId);

      try {
        const { data: rows, error } = await supabase.rpc("get_unread_counts_for_chats", {
          p_chat_ids: [chatId],
          p_user_id: user.id,
        });
        if (error) return;

        const n = Number(rows?.[0]?.unread_count || 0);
        notifications.setUnreadCount(chatId, n);
      } catch {}
    }, debounceMs);

    timers.set(chatId, t);
  };

  const channel = supabase
    .channel(`unread_sync_reads_${user.id}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "chat_message_reads",
        filter: `user_id=eq.${user.id}`, // ✅ только мои прочтения (в т.ч. с другого девайса)
      },
      (payload) => {
        const row = payload?.new;
        const chatId = row?.chat_id; // ✅ у тебя уже добавлен chat_id в SQL + триггер
        if (!chatId) return;

        scheduleRecalc(chatId);
      }
    )
    .subscribe();

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    try { supabase.removeChannel(channel); } catch {}
  };
}, [user?.id]);


  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('cmf_global')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_message_files' },
        (payload) => {
          try {
            window.dispatchEvent(
              new CustomEvent('chat-file-insert', { detail: payload.new })
            );
          } catch {}
        }
      )
      .subscribe();

    return () => {
      try { supabase.removeChannel(channel); } catch {}
    };
  }, [user?.id]);

  /* --- Аудио: инициализация/разблокировка/устойчивость --- */
  useEffect(() => {
    const initAudio = async () => {
      console.time('initAudio');
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      try {
        const response = await fetch('/sounds/notification.mp3');
        const arrayBuffer = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(arrayBuffer);
        setAudioContext(ctx);
        setSoundBuffer(buffer);
        try { if (ctx.state === 'suspended') await ctx.resume(); } catch {}
        console.log('[initAudio] Audio initialized successfully');
      } catch (err) {
        console.error('[initAudio] Failed to initialize audio:', err.message);
      }
      console.timeEnd('initAudio');
    };

    const enableAudio = async () => {
      if (!audioContext) await initAudio();
      else try { if (audioContext.state === 'suspended') await audioContext.resume(); } catch {}
    };

    const activators = ['click', 'pointerdown', 'touchstart', 'keydown'];
    activators.forEach((ev) => window.addEventListener(ev, enableAudio, { once: false }));

    const onVisibility = async () => {
      if (document.visibilityState === 'visible' && audioContext?.state === 'suspended') {
        try { await audioContext.resume(); } catch {}
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      activators.forEach((ev) => window.removeEventListener(ev, enableAudio));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [audioContext]);

  useEffect(() => {
    if (audioContext && soundBuffer && pendingSounds.length > 0) {
      pendingSounds.forEach((msgId) => {
        if (!playedMessages.has(msgId)) {
          playSound(audioContext, soundBuffer, msgId);
          playedMessages.add(msgId);
        }
      });
      setPendingSounds([]);
    }
  }, [audioContext, soundBuffer, pendingSounds]);

  // SPEED: один запрос для всех чатов
  const fetchInitialUnread = async (u) => {
    try {
      const { data: chats } = await supabase
        .from('chats')
        .select('id, chat_participants!inner(user_id)')
        .eq('chat_participants.user_id', u.id);

      const chatIds = (chats || []).map((c) => c.id);
      myChatMembership.clear();
      chatIds.forEach((id) => myChatMembership.add(id));

      if (chatIds.length === 0) {
        notifications.unreadCounts = {};
        notifications.notifyListeners();
        return;
      }

      // один запрос по всем chat_id
// вместо чтения chat_messages.read=false используем chat_message_reads
const { data: rows, error } = await supabase.rpc('get_unread_counts_for_chats', {
  p_chat_ids: chatIds,
  p_user_id: u.id,
});

if (error) throw error;

// rows: [{ chat_id, unread_count }]
const counts = {};
chatIds.forEach((id) => { counts[id] = 0; });
(rows || []).forEach((r) => { counts[r.chat_id] = r.unread_count || 0; });

notifications.unreadCounts = { ...counts };
notifications.notifyListeners();

    } catch (e) {
      console.error('[fetchInitialUnread] Failed to fetch initial unread:', e.message);
    }
  };

  const handleNewMessage = async (newMessage, currentUser) => {
    if (!currentUser) return;
    if (newMessage.user_id === currentUser.id) return;

    let isUserInChat = myChatMembership.has(newMessage.chat_id);
    if (!isUserInChat) {
      try {
        const { data: parts } = await supabase
          .from('chat_participants')
          .select('user_id')
          .eq('chat_id', newMessage.chat_id);
        if (parts?.some((p) => p.user_id === currentUser.id)) {
          isUserInChat = true;
          myChatMembership.add(newMessage.chat_id);
        }
      } catch {}
    }
    if (!isUserInChat) return;

    // 1) глобальный счётчик непрочитанных
   const activeChatId =
  typeof window !== "undefined" ? window.__onlocActiveChatId : null;

// ✅ если мы уже внутри этого чата — НЕ накидываем unread (убираем мерцание)
if (!activeChatId || activeChatId !== newMessage.chat_id) {
  notifications.incrementUnreadCount(newMessage.chat_id);
}

    // 2) мост в страницу сообщений: пробрасываем событие в window
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('chat-message-insert', {
            detail: { message: newMessage },
          })
        );
      }
    } catch (e) {
      console.warn(
        '[handleNewMessage] failed to dispatch chat-message-insert',
        e
      );
    }

    // 3) звук
    try {
      if (audioContext && audioContext.state === 'suspended') {
        await audioContext.resume();
      }
    } catch {}

    if (isLeaderTab && audioContext && soundBuffer && !playedMessages.has(newMessage.id)) {
      playSound(audioContext, soundBuffer, newMessage.id);
      try {
        broadcastChannel?.postMessage({
          type: 'PLAY_SOUND',
          messageId: newMessage.id,
          tabId: Math.random().toString(36).slice(2),
        });
      } catch {}
      playedMessages.add(newMessage.id);
    } else if (!audioContext || !soundBuffer) {
      setPendingSounds((prev) => [...prev, newMessage.id]);
    }
  };


  const playSound = (context, buffer, messageId) => {
    const now = Date.now();
    if (now - lastSoundTime < soundCooldown) {
      setPendingSounds((prev) => [...prev, messageId]);
      return;
    }
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
      lastSoundTime = now;
    } catch (err) {
      console.error('[playSound] Error playing sound:', err.message);
      setPendingSounds((prev) => [...prev, messageId]);
    }
  };

  /* -------- ПРОФИЛЬ: STRICT cache-positive-first + DB -------- */
  const checkUserProfile = async (u) => {
    console.time('checkUserProfile');
    if (!u) { 
      setProfileChecked(true); 
      setHasProfile(null); 
      console.log('[checkUserProfile] No user, skipping');
      console.timeEnd('checkUserProfile');
      return; 
    }

    let cachedLS = null;
    if (isLocalStorageAvailable) {
      try { cachedLS = localStorage.getItem('hasProfile'); } catch {}
    }
    const cachedCookie = getCookieHasProfile();
    const cachedPositive = (cachedLS === 'true') || cachedCookie;

    if (cachedPositive) {
      setHasProfile(true);
      setProfileChecked(true);
      console.log('[checkUserProfile] Positive cache found, profile exists');
    }

    try {
      let data, error;
      let query = supabase.from('profiles').select('user_id').eq('user_id', u.id);
      if (typeof query.maybeSingle === 'function') {
        ({ data, error } = await query.maybeSingle());
      } else {
        ({ data, error } = await query.single());
      }

      if (!error) {
        const exists = !!data;
        setHasProfile(exists);
        if (isLocalStorageAvailable) localStorage.setItem('hasProfile', exists.toString());
        setCookieHasProfile(exists);
        setProfileChecked(true);
        console.log('[checkUserProfile] DB check complete, profile exists:', exists);
      } else {
        console.error('[checkUserProfile] DB error:', error.message);
        if (!cachedPositive) {
          setHasProfile(null);
          // SPEED: не блокируем UI ожиданием профиля
          setProfileChecked(true);
        }
      }
    } catch (err) {
      console.error('[checkUserProfile] Exception:', err.message);
      if (!cachedPositive) {
        setHasProfile(null);
        setProfileChecked(true);
      }
    }
    console.timeEnd('checkUserProfile');
  };

  const updateProfileStatus = (status) => {
    setHasProfile(status);
    setProfileChecked(true);
    if (isLocalStorageAvailable) localStorage.setItem('hasProfile', status.toString());
    setCookieHasProfile(status);
  };

  // проверка профиля
  useEffect(() => {
    if (!user) { setProfileChecked(true); setHasProfile(null); return; }
    checkUserProfile(user);
  }, [router.pathname, user]);

  // быстрый редирект с /profile/setup по ПОЛОЖИТЕЛЬНОМУ кэшу (fallback)
  useEffect(() => {
    if (!user) return;
    if (router.pathname === '/profile/setup') {
      const cachedHas = getCookieHasProfile() || (() => { try { return localStorage.getItem('hasProfile') === 'true'; } catch { return false; } })();
      if (cachedHas) router.replace('/trips');
    }
  }, [user, router.pathname]);

  /* ---------------- контекст ---------------- */
  const authValue = {
    user,
    session,
    supabase,
    loading,
    geolocation,
    geolocationLoading,
    isMobile: typeof window !== 'undefined' && window.innerWidth <= 768,
    updateProfileStatus,
    isProcessing,
    setProcessing,
  };

  /* ---------------- рендер/роутинг ---------------- */
  if (isInitialLoading) return <LoadingOverlay text="Загрузка приложения..." />;

  if (blockSetupRender) return <LoadingOverlay text="Перенаправляем..." />;

  // SPEED: больше не блокируем UI из-за геолокации/проверки профиля
  if (loading && !user) {
    return <LoadingOverlay text="Загрузка данных..." />;
  }

  const isTripsPage = router.pathname === '/trips' || router.pathname.startsWith('/trips/');
  const isTripDetailsPage = router.pathname.startsWith('/trip/');
  const authRoutes = ['/auth', '/auth/register', '/auth/recover', '/auth/update-password'];

  // Неавторизованных ведём только на /auth (публичные оставляем).
  if (!user) {
    if (isTripsPage || isTripDetailsPage || authRoutes.includes(router.pathname)) {
      return (
        <AuthContext.Provider value={authValue}>
          <Component {...pageProps} />
        </AuthContext.Provider>
      );
    }
    if (!isRedirecting) {
      setIsRedirecting(true);
      router.push('/auth');
    }
    return null;
  }

  // Строгая логика допуска — редиректим когда профиль известен
  if (profileChecked) {
    if (authRoutes.includes(router.pathname)) {
      return (
        <AuthContext.Provider value={authValue}>
          <Component {...pageProps} />
        </AuthContext.Provider>
      );
    }
    if (hasProfile === false && router.pathname !== '/profile/setup' && !isRedirecting) {
      setIsRedirecting(true);
      router.push('/profile/setup');
      return null;
    }
    if (hasProfile === true && router.pathname === '/profile/setup' && !isRedirecting) {
      setIsRedirecting(true);
      router.push('/trips');
      return null;
    }
  }

return (
  <AuthContext.Provider value={authValue}>
    <Component {...pageProps} />
    {showProcessingOverlay && <LoadingOverlay text="Загрузка..." />}
  </AuthContext.Provider>
);
}

export const LoadingOverlay = ({ text }) => (
  <div className="loading-overlay">
    <div className="spinner"></div>
    {text && <p className="loading-text">{text}</p>}
  </div>
);

export default MyApp;
