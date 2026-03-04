import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../_app';
import AdminDisputesPage from './AdminDisputesPage';
import AdminChatsPage from './AdminChatsPage';
import AdminCompaniesPage from './AdminCompaniesPage';
import AdminTbankToolsPage from './AdminTbankToolsPage';
import AdminNewsPage from './AdminNewsPage';
import AdminUsersPage from './AdminUsersPage';
import styles from '../../styles/admin-panel.module.css';

/**
 * user_admin_access:
 *  - user_id
 *  - is_admin
 *  - disputes, chats, trips, profiles, reviews, companies, tbank_tools, news, users
 */
const ALL_TABS = [
  { id: 'disputes',  label: 'Диспуты'  },
  { id: 'chats',     label: 'Чаты'     },
  { id: 'trips',     label: 'Поездки'  },
  { id: 'profiles',  label: 'Профили'  },
  { id: 'reviews',   label: 'Отзывы'   },
  { id: 'companies', label: 'Компании' },
  { id: 'tbank_tools', label: 'Т-Банк' },
  { id: 'news', label: 'Новости' },
  { id: 'users', label: 'Пользователи' },
];

export default function AdminPanel() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);

  const [perms, setPerms] = useState(null);
  const isGlobalAdmin = !!perms?.is_admin;

  const [activeTab, setActiveTab] = useState('chats');

  const [unreadChatsCount, setUnreadChatsCount] = useState(0);
  const [unreadDisputesCount, setUnreadDisputesCount] = useState(0);
  const [requestedSupportChatId, setRequestedSupportChatId] = useState(null);

  const audioRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    async function loadPerms() {
      if (!user) return;
      setLoading(true);

      const { data } = await supabase
        .from('user_admin_access')
        .select('user_id, is_admin, disputes, chats, trips, profiles, reviews, companies, tbank_tools, news, users')
        .eq('user_id', user.id)
        .maybeSingle();

      if (mounted) {
        setPerms(data || { is_admin: false });
        setLoading(false);
      }
    }
    loadPerms();
    return () => { mounted = false; };
  }, [user?.id]);

  const allowedTabs = useMemo(() => {
    if (!perms) return [];
    return ALL_TABS.filter(t => isGlobalAdmin || perms[t.id]);
  }, [perms, isGlobalAdmin]);

  useEffect(() => {
    if (!loading && allowedTabs.length > 0) {
      const stillAllowed = allowedTabs.some(t => t.id === activeTab);
      if (!stillAllowed) setActiveTab(allowedTabs[0].id);
    }
  }, [loading, allowedTabs, activeTab]);

  const getAdminIds = async () => {
    const { data: adminsRows } = await supabase
      .from('user_admin_access')
      .select('user_id, is_admin, chats, disputes');
    return (adminsRows || [])
      .filter(r => r.is_admin || r.chats || r.disputes)
      .map(r => r.user_id);
  };

  const playDing = () => {
    try {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(() => {});
      }
      if (navigator?.vibrate) navigator.vibrate(80);
    } catch {}
  };

  async function refreshUnreadSupport() {
    const adminIds = await getAdminIds();

    const { data: chats } = await supabase
      .from('chats')
      .select('id')
      .eq('chat_type', 'support');

    const chatIds = (chats || []).map(c => c.id);
    if (!chatIds.length) {
      setUnreadChatsCount(0);
      return;
    }

    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('chat_id, user_id, read')
      .in('chat_id', chatIds)
      .or('read.is.null,read.eq.false');

    const adminSet = new Set(adminIds);
    const setOfChats = new Set(
      (msgs || [])
        .filter(m => !adminSet.has(m.user_id))
        .map(m => m.chat_id)
    );

    setUnreadChatsCount(setOfChats.size);
  }

  async function refreshUnreadDisputes() {
    const adminIds = await getAdminIds();

    const { data: chats } = await supabase
      .from('chats')
      .select('id')
      .eq('chat_type', 'dispute');

    const chatIds = (chats || []).map(c => c.id);
    if (!chatIds.length) {
      setUnreadDisputesCount(0);
      return;
    }

    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('chat_id, user_id, read')
      .in('chat_id', chatIds)
      .or('read.is.null,read.eq.false');

    const adminSet = new Set(adminIds);
    const setOfChats = new Set(
      (msgs || [])
        .filter(m => !adminSet.has(m.user_id))
        .map(m => m.chat_id)
    );

    setUnreadDisputesCount(setOfChats.size);
  }

  useEffect(() => {
    if (!user) return;
    Promise.all([refreshUnreadSupport(), refreshUnreadDisputes()]).catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('admin_panel_unread_all')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        async (payload) => {
          const { chat_id, user_id } = payload.new || {};
          if (!chat_id) return;

          const { data: chat } = await supabase
            .from('chats')
            .select('chat_type')
            .eq('id', chat_id)
            .maybeSingle();
          if (!chat) return;

          const { data: r } = await supabase
            .from('user_admin_access')
            .select('user_id, is_admin, chats, disputes')
            .eq('user_id', user_id)
            .maybeSingle();
          const isFromAdmin = !!(r && (r.is_admin || r.chats || r.disputes));

          if (!isFromAdmin) {
            if (chat.chat_type === 'support') {
              if (activeTab !== 'chats') playDing();
            } else if (chat.chat_type === 'dispute') {
              if (activeTab !== 'disputes') playDing();
            }
          }

          if (chat.chat_type === 'support') {
            refreshUnreadSupport();
          } else if (chat.chat_type === 'dispute') {
            refreshUnreadDisputes();
          }
        }
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
        async (payload) => {
          const chatId = payload.new?.chat_id || payload.old?.chat_id;
          if (!chatId) return;
          const { data: chat } = await supabase
            .from('chats')
            .select('chat_type')
            .eq('id', chatId)
            .maybeSingle();
          if (!chat) return;

          if (chat.chat_type === 'support') {
            refreshUnreadSupport();
          } else if (chat.chat_type === 'dispute') {
            refreshUnreadDisputes();
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id, activeTab]);

  const openSupportChatFromUsers = useCallback((chatId) => {
    if (!chatId) return;
    setRequestedSupportChatId(chatId);
    setActiveTab('chats');
  }, []);

  const childPermissions = useMemo(() => {
    return {
      is_admin: !!perms?.is_admin,
      can_tab: true,
    };
  }, [perms]);

  if (!user) return <div className={styles.container}>Требуется авторизация</div>;
  if (loading) return <div className={styles.container}>Загрузка…</div>;
  if (!allowedTabs.length) return <div className={styles.container}>Нет доступа</div>;

  function renderTabButton(tab) {
    const isActive = tab.id === activeTab;

    let badgeCount = 0;
    if (tab.id === 'chats') badgeCount = unreadChatsCount;
    if (tab.id === 'disputes') badgeCount = unreadDisputesCount;

    return (
      <button
        key={tab.id}
        className={`${styles.tabBtn} ${isActive ? styles.active : ''}`}
        onClick={() => setActiveTab(tab.id)}
      >
        <span>{tab.label}</span>
        {badgeCount > 0 && <span className={styles.badge}>{badgeCount}</span>}
      </button>
    );
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Админ-панель</h2>

      <div className={styles.tabs}>
        {allowedTabs.map(renderTabButton)}
      </div>

      <div className={styles.tabBody}>
        {activeTab === 'disputes' && <AdminDisputesPage permissions={childPermissions} />}
        {activeTab === 'chats' && (
          <AdminChatsPage
            permissions={childPermissions}
            openChatId={requestedSupportChatId}
            onOpenChatHandled={() => setRequestedSupportChatId(null)}
          />
        )}
        {activeTab === 'trips' && (
          <div className={styles.placeholder}>
            <h3>Поездки</h3>
            <p>Функционал поездок в разработке.</p>
          </div>
        )}
        {activeTab === 'profiles' && (
          <div className={styles.placeholder}>
            <h3>Профили</h3>
            <p>Функционал профилей в разработке.</p>
          </div>
        )}
        {activeTab === 'reviews' && (
          <div className={styles.placeholder}>
            <h3>Отзывы</h3>
            <p>Функционал отзывов в разработке.</p>
          </div>
        )}
        {activeTab === 'companies' && <AdminCompaniesPage permissions={childPermissions} />}
        {activeTab === 'tbank_tools' && <AdminTbankToolsPage />}
        {activeTab === 'news' && <AdminNewsPage />}
        {activeTab === 'users' && (
          <AdminUsersPage
            permissions={childPermissions}
            onOpenSupportChat={openSupportChatFromUsers}
          />
        )}
      </div>

      <audio ref={audioRef} src="/sounds/notification.mp3" preload="auto" style={{ display: 'none' }} />
    </div>
  );
}
