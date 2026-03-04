import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../_app';
import styles from '../../styles/admin-users.module.css';

const PAGE_SIZE_OPTIONS = [20, 50, 100];
const BAN_REASONS = [
  { value: 'abusive_language', label: 'Сквернословие и оскорбления' },
  { value: 'adult_content', label: 'Размещение контента 18+' },
  { value: 'illegal_trips', label: 'Создание поездок, нарушающих закон' },
  { value: 'fraud', label: 'Мошенничество / обман пользователей' },
  { value: 'spam', label: 'Спам и массовые рассылки' },
  { value: 'harassment', label: 'Домогательства / буллинг' },
  { value: 'fake_profile', label: 'Фейковый профиль / ложные данные' },
  { value: 'drugs', label: 'Пропаганда / продажа наркотиков' },
  { value: 'violence', label: 'Угрозы и призывы к насилию' },
  { value: 'unsafe_behavior', label: 'Опасное поведение для других пользователей' },
  { value: 'other', label: 'Другое (ввести вручную)' },
];

function calcAge(birthDate) {
  if (!birthDate) return '—';
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 ? age : '—';
}

export default function AdminUsersPage({ permissions = { is_admin: false, can_tab: false } }) {
  const { user } = useAuth();
  const canModerate = !!(permissions.is_admin || permissions.can_tab);

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [creatingChatFor, setCreatingChatFor] = useState('');
  const [chatMetaByUser, setChatMetaByUser] = useState({});

  const [banModalUser, setBanModalUser] = useState(null);
  const [selectedReason, setSelectedReason] = useState(BAN_REASONS[0].value);
  const [customReason, setCustomReason] = useState('');

  const pages = Math.max(1, Math.ceil(total / pageSize));

  const fetchUsers = useCallback(async () => {
    if (!user || !canModerate) return;
    setLoading(true);
    setError('');

    try {
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      let q = supabase
        .from('profiles')
        .select('user_id, first_name, last_name, avatar_url, location, birth_date, about, gender, is_banned, ban_reason', { count: 'exact' });

      if (query.trim()) {
        const term = query.trim();
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (uuidRe.test(term)) {
          q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,user_id.eq.${term}`);
        } else {
          q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
        }
      }

      const { data, error: dbError, count } = await q
        .order('created_at', { ascending: false, nullsFirst: false })
        .range(from, to);

      if (dbError) throw dbError;
      setRows(data || []);
      setTotal(count || 0);
    } catch (e) {
      setError(e?.message || 'Ошибка загрузки пользователей');
    } finally {
      setLoading(false);
    }
  }, [canModerate, page, pageSize, query, user]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchChatMeta = useCallback(async (usersRows = rows) => {
    if (!canModerate || !user || !usersRows.length) {
      setChatMetaByUser({});
      return;
    }

    try {
      const userIds = usersRows.map((r) => r.user_id).filter(Boolean);
      if (!userIds.length) {
        setChatMetaByUser({});
        return;
      }

      const { data: adminRows } = await supabase
        .from('user_admin_access')
        .select('user_id, is_admin, chats, users');
      const adminSet = new Set(
        (adminRows || [])
          .filter((r) => r.is_admin || r.chats || r.users)
          .map((r) => r.user_id)
      );

      const { data: participants, error: partsErr } = await supabase
        .from('chat_participants')
        .select('chat_id, user_id')
        .in('user_id', userIds);
      if (partsErr) throw partsErr;

      const chatIds = Array.from(new Set((participants || []).map((p) => p.chat_id).filter(Boolean)));
      if (!chatIds.length) {
        setChatMetaByUser({});
        return;
      }

      const { data: supportChats, error: chatsErr } = await supabase
        .from('chats')
        .select('id, moderator_id, created_at, chat_type, support_close_confirmed')
        .in('id', chatIds)
        .eq('chat_type', 'support')
        .or('support_close_confirmed.is.null,support_close_confirmed.eq.false');
      if (chatsErr) throw chatsErr;

      const supportById = (supportChats || []).reduce((acc, c) => {
        acc[c.id] = c;
        return acc;
      }, {});

      const selectedByUser = {};
      (participants || []).forEach((p) => {
        const chat = supportById[p.chat_id];
        if (!chat) return;
        const prev = selectedByUser[p.user_id];
        const prevTime = prev?.created_at ? new Date(prev.created_at).getTime() : 0;
        const nextTime = chat.created_at ? new Date(chat.created_at).getTime() : 0;
        if (!prev || nextTime > prevTime) {
          selectedByUser[p.user_id] = chat;
        }
      });

      const selectedChatIds = Array.from(new Set(Object.values(selectedByUser).map((c) => c.id)));
      let unreadByChat = {};
      if (selectedChatIds.length) {
        const { data: unreadRows, error: unreadErr } = await supabase
          .from('chat_messages')
          .select('chat_id, user_id, read')
          .in('chat_id', selectedChatIds)
          .or('read.is.null,read.eq.false');
        if (unreadErr) throw unreadErr;

        unreadByChat = (unreadRows || []).reduce((acc, m) => {
          if (adminSet.has(m.user_id)) return acc;
          acc[m.chat_id] = (acc[m.chat_id] || 0) + 1;
          return acc;
        }, {});
      }

      const nextMeta = {};
      Object.entries(selectedByUser).forEach(([uid, chat]) => {
        nextMeta[uid] = {
          chatId: chat.id,
          moderatorId: chat.moderator_id,
          isMine: chat.moderator_id === user.id,
          unreadCount: unreadByChat[chat.id] || 0,
        };
      });
      setChatMetaByUser(nextMeta);
    } catch (e) {
      console.error('AdminUsers chat meta load failed:', e);
    }
  }, [canModerate, rows, user]);

  useEffect(() => {
    fetchChatMeta(rows);
  }, [fetchChatMeta, rows]);

  useEffect(() => {
    if (!canModerate || !user) return undefined;

    const channel = supabase
      .channel(`admin_users_support_rt_${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, () => {
        fetchChatMeta();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_participants' }, () => {
        fetchChatMeta();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chats' }, () => {
        fetchChatMeta();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [canModerate, fetchChatMeta, user]);

  const pageNumbers = useMemo(() => {
    const out = [];
    const start = Math.max(1, page - 2);
    const end = Math.min(pages, page + 2);
    for (let i = start; i <= end; i += 1) out.push(i);
    return out;
  }, [page, pages]);

  const applySearch = () => {
    setPage(1);
    setQuery(search);
  };

  const openBanModal = (row) => {
    setBanModalUser(row);
    setSelectedReason(BAN_REASONS[0].value);
    setCustomReason('');
  };

  const getFinalReason = () => {
    if (selectedReason === 'other') return customReason.trim();
    return BAN_REASONS.find((r) => r.value === selectedReason)?.label || '';
  };

  const updateBan = async (targetUserId, isBanned, reason = '') => {
    setSubmitting(true);
    setError('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('Нет активной сессии');

      const resp = await fetch('/api/admin/users-ban', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetUserId, isBanned, reason }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);

      setRows((prev) => prev.map((r) => (
        r.user_id === targetUserId
          ? { ...r, is_banned: isBanned, ban_reason: reason || null }
          : r
      )));
      setToast(isBanned ? 'Пользователь заблокирован' : 'Пользователь разблокирован');
    } catch (e) {
      setError(e?.message || 'Не удалось обновить статус блокировки');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBanConfirm = async () => {
    if (!banModalUser) return;
    const reason = getFinalReason();
    if (!reason) {
      setError('Укажите причину блокировки');
      return;
    }
    await updateBan(banModalUser.user_id, true, reason);
    setBanModalUser(null);
  };

  const handleToggleBan = async (row, checked) => {
    if (checked) {
      openBanModal(row);
      return;
    }

    const ok = window.confirm('Снять блокировку с пользователя?');
    if (!ok) return;
    await updateBan(row.user_id, false, '');
  };

  const handleCreateSupportChat = async (targetUserId) => {
    if (!targetUserId || !user) return;
    setCreatingChatFor(targetUserId);
    setError('');

    try {
      const { data: inserted, error: insErr } = await supabase
        .from('chats')
        .insert([{ chat_type: 'support', is_group: false, title: null, moderator_id: user.id }])
        .select('id, created_at')
        .single();
      if (insErr || !inserted?.id) throw insErr || new Error('Не удалось создать чат');

      const { error: partsErr } = await supabase
        .from('chat_participants')
        .insert([{ chat_id: inserted.id, user_id: targetUserId }]);
      if (partsErr) throw partsErr;

      const { error: msgErr } = await supabase
        .from('chat_messages')
        .insert({
          chat_id: inserted.id,
          user_id: user.id,
          content: 'Здравствуйте! Открыл чат поддержки для решения вашего вопроса.',
          created_at: inserted.created_at,
          read: false,
        });
      if (msgErr) throw msgErr;

      setToast('Чат с пользователем создан и назначен на вас');
      fetchChatMeta();
    } catch (e) {
      setError(e?.message || 'Не удалось создать чат поддержки');
    } finally {
      setCreatingChatFor('');
    }
  };

  if (!canModerate) return <div className={styles.empty}>Нет доступа к вкладке пользователей.</div>;

  return (
    <div>
      <div className={styles.controls}>
        <input
          className={styles.input}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
          placeholder="Поиск: имя, фамилия или user id"
        />
        <button className={styles.btn} onClick={applySearch}>Найти</button>
        <button className={styles.btn} onClick={() => { setSearch(''); setQuery(''); setPage(1); }}>Сброс</button>
      </div>

      {loading ? <div className={styles.empty}>Загрузка...</div> : null}
      {!loading && !rows.length ? <div className={styles.empty}>Пользователи не найдены.</div> : null}

      {!!rows.length && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Аватар</th>
                <th>Имя</th>
                <th>Фамилия</th>
                <th>Локация</th>
                <th>Возраст</th>
                <th>Описание</th>
                <th>Гендер</th>
                <th>Чат</th>
                <th>Забанить</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                (() => {
                  const chatMeta = chatMetaByUser[r.user_id];
                  const hasActiveSupport = !!chatMeta?.chatId;
                  const isMine = !!chatMeta?.isMine;
                  const unreadCount = chatMeta?.unreadCount || 0;
                  return (
                <tr key={r.user_id}>
                  <td className={styles.idCell}>{r.user_id}</td>
                  <td>
                    {r.avatar_url
                      ? <img src={r.avatar_url} alt="avatar" className={styles.avatar} />
                      : <span>—</span>}
                  </td>
                  <td>{r.first_name || '—'}</td>
                  <td>{r.last_name || '—'}</td>
                  <td>{r.location || '—'}</td>
                  <td>{calcAge(r.birth_date)}</td>
                  <td className={styles.aboutCell}>{r.about || '—'}</td>
                  <td>{r.gender || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className={`${styles.chatBtn} ${hasActiveSupport ? styles.chatBtnActive : ''}`}
                      onClick={() => handleCreateSupportChat(r.user_id)}
                      disabled={creatingChatFor === r.user_id || r.user_id === user?.id}
                      title={hasActiveSupport
                        ? `Есть активный чат ${isMine ? '(назначен на вас)' : '(назначен на другого админа)'}`
                        : 'Создать чат поддержки'}
                    >
                      <span className={styles.chatIcon} aria-hidden>💬</span>
                      <span>{creatingChatFor === r.user_id ? 'Создаём...' : 'Чат'}</span>
                      {unreadCount > 0 ? <span className={styles.unreadBadge}>{unreadCount}</span> : null}
                    </button>
                    {hasActiveSupport ? (
                      <div className={`${styles.chatStatus} ${isMine ? styles.chatMine : styles.chatForeign}`}>
                        {isMine ? 'В работе у вас' : 'В работе у другого админа'}
                      </div>
                    ) : (
                      <div className={styles.chatStatus}>Нет активного чата</div>
                    )}
                  </td>
                  <td>
                    <label className={styles.banToggle}>
                      <input
                        type="checkbox"
                        checked={!!r.is_banned}
                        disabled={submitting || r.user_id === user?.id}
                        onChange={(e) => handleToggleBan(r, e.target.checked)}
                      />
                      <span>{r.is_banned ? 'Да' : 'Нет'}</span>
                    </label>
                    {r.ban_reason ? <div className={styles.reason}>{r.ban_reason}</div> : null}
                  </td>
                </tr>
                  );
                })()
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pagination}>
        <div className={styles.pageSize}>
          <span>На странице:</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        </div>

        <div className={styles.pageButtons}>
          <button className={styles.btn} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Назад</button>
          {pageNumbers.map((n) => (
            <button
              key={n}
              className={`${styles.btn} ${n === page ? styles.active : ''}`}
              onClick={() => setPage(n)}
            >
              {n}
            </button>
          ))}
          <button className={styles.btn} disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>Вперёд</button>
        </div>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
      {toast ? <div className={styles.toast}>{toast}</div> : null}

      {banModalUser && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h3>Блокировка пользователя</h3>
            <p><b>{banModalUser.first_name || ''} {banModalUser.last_name || ''}</b> ({banModalUser.user_id})</p>
            <select value={selectedReason} onChange={(e) => setSelectedReason(e.target.value)} className={styles.input}>
              {BAN_REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            {selectedReason === 'other' && (
              <textarea
                className={styles.input}
                rows={4}
                placeholder="Введите описание причины блокировки"
                value={customReason}
                onChange={(e) => setCustomReason(e.target.value)}
              />
            )}
            <div className={styles.modalActions}>
              <button className={styles.btn} onClick={() => setBanModalUser(null)} disabled={submitting}>Отмена</button>
              <button className={styles.btn} onClick={handleBanConfirm} disabled={submitting}>
                {submitting ? 'Блокируем...' : 'Подтвердить блокировку'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
