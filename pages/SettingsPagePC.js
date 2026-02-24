// pages/SettingsPagePC.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../pages/_app';
import pcStyles from '../styles/settings.pc.module.css';
import AvatarEditor from '../components/AvatarEditor';
import CompanySettings from '../components/CompanySettings';

const SettingsPagePC = ({ avatarUrl, setAvatarUrl }) => {
  const { user, session, supabase } = useAuth();

const [activeTab, setActiveTab] = useState(() => {
if (typeof window === 'undefined') return 'individual';
const v = sessionStorage.getItem('settings_activeTab');
return (v === 'individual' || v === 'cards' || v === 'company') ? v : 'individual';
});
const [cardsTab, setCardsTab] = useState(() => {
if (typeof window === 'undefined') return 'payment';
const v = sessionStorage.getItem('settings_cardsTab');
return (v === 'payment' || v === 'payout') ? v : 'payment';
});
  const [message, setMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // профиль
  const [profileData, setProfileData] = useState({
    firstName: '', lastName: '', patronymic: '', birthDate: '',
    location: '', geoLat: '', geoLon: '', about: '', phone: '+7',
  });
  const [isSaving, setIsSaving] = useState(false);

  // карты — разделены по скоупам
  const [cardsPayment, setCardsPayment] = useState([]); // user_cards where card_scope='payment'
  const [cardsPayout, setCardsPayout] = useState([]);   // user_cards where card_scope='payout'
  const [isSyncingCards, setIsSyncingCards] = useState(false);
  const [isBinding, setIsBinding] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [settingPrimaryId, setSettingPrimaryId] = useState(null);
  const syncOnceRef = useRef(false);

  // сохраняем вкладки при перезагрузках/сворачивании
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { sessionStorage.setItem('settings_activeTab', activeTab); } catch {}
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { sessionStorage.setItem('settings_cardsTab', cardsTab); } catch {}
  }, [cardsTab]);

  // ===== профиль
  const fetchProfile = useCallback(async () => {
    setIsLoading(true);
    try {
      if (!supabase) throw new Error('no supabase');
      if (!session || !user) throw new Error('no session');
      const { data, error } = await supabase
        .from('profiles')
        .select('first_name, last_name, patronymic, birth_date, location, geo_lat, geo_lon, about, phone')
        .eq('user_id', user.id)
        .single();
      if (error) throw error;
      if (data) {
        setProfileData({
          firstName: data.first_name || '',
          lastName: data.last_name || '',
          patronymic: data.patronymic || '',
          birthDate: data.birth_date || '',
          location: data.location || '',
          geoLat: data.geo_lat || '',
          geoLon: data.geo_lon || '',
          about: data.about || '',
          phone: data.phone || '+7',
        });
      }
    } catch (err) {
      console.error('Ошибка загрузки профиля:', err);
      setMessage('Не удалось загрузить профиль');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsLoading(false);
    }
  }, [user?.id, session, supabase]);

  const handleSaveIndividual = useCallback(async () => {
    try {
      if (!supabase || !session || !user) throw new Error('no session');
      setIsSaving(true);
      const updates = {
        first_name: profileData.firstName || null,
        last_name: profileData.lastName || null,
        patronymic: profileData.patronymic || null,
        birth_date: profileData.birthDate || null,
        location: profileData.location || null,
        geo_lat: profileData.geoLat || null,
        geo_lon: profileData.geoLon || null,
        about: profileData.about || null,
      };
      const { error } = await supabase.from('profiles').update(updates).eq('user_id', user.id);
      if (error) throw error;
      setMessage('Настройки сохранены!');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      console.error('save profile error:', err);
      setMessage('Не удалось сохранить настройки');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsSaving(false);
    }
  }, [profileData, supabase, user?.id, session]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  // ===== карты
  const normalizeLocalCard = (c) => {
    let isExpired = false;
    if (c?.expiry_date) {
      let mm = null, yy = null;
      if (/^\d{4}$/.test(c.expiry_date)) { mm = c.expiry_date.slice(0,2); yy = c.expiry_date.slice(2,4); }
      else if (/^\d{2}\/\d{2}$/.test(c.expiry_date)) { [mm, yy] = c.expiry_date.split('/'); }
      if (mm && yy) {
        const lastDay = new Date(Number('20' + yy), Number(mm), 0);
        const now = new Date();
        isExpired = lastDay < new Date(now.getFullYear(), now.getMonth(), 1);
      }
    }
    return { ...c, isExpired };
  };

  const loadCardsByScope = useCallback(async (scope) => {
    if (!supabase || !user) return [];
    const { data, error } = await supabase
      .from('user_cards')
      .select('id, card_id, last_four_digits, expiry_date, is_primary, created_at, card_scope')
      .eq('user_id', user.id)
      .eq('card_scope', scope)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) {
      console.error('Ошибка чтения user_cards:', error);
      return [];
    }
    return (data || []).map(normalizeLocalCard);
  }, [supabase, user?.id]);

  const refreshBothScopes = useCallback(async () => {
    const [pay, out] = await Promise.all([
      loadCardsByScope('payment'),
      loadCardsByScope('payout'),
    ]);
    setCardsPayment(pay);
    setCardsPayout(out);
  }, [loadCardsByScope]);

  const syncBothAndLoad = useCallback(async () => {
    if (!session?.access_token) return;
    setIsSyncingCards(true);
    try {
      // Синхроним ОДНОВРЕМЕННО: оплатные + выплатные
      await Promise.allSettled([
        fetch('/api/tbank/sync-cards-payment', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json'
          },
        }),
        fetch('/api/tbank/sync-cards', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json'
          },
        }),
      ]);
      // Всегда загружаем локальное состояние после синка
      await refreshBothScopes();
    } catch (e) {
      console.error('Синхронизация карт упала:', e);
      await refreshBothScopes(); // хотя бы локальные, чтобы UI не пустел
      setMessage('Не удалось синхронизировать карты');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsSyncingCards(false);
    }
  }, [session?.access_token, refreshBothScopes]);

  useEffect(() => {
    // Автосинхронизация при заходе в «Настройки» — ОДИН раз
    if (user && !syncOnceRef.current) {
      syncOnceRef.current = true;
      syncBothAndLoad();
    }
  }, [user?.id, syncBothAndLoad]);

  // Регистрация customer (для выплат)
  const registerCustomer = async () => {
    if (!session?.access_token) {
      setMessage('Неавторизованный доступ');
      setTimeout(() => setMessage(null), 3000);
      return false;
    }
    try {
      const r = await fetch('/api/tbank/add-customer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${r.status}`);
      }
      return true;
    } catch (err) {
      console.error('registerCustomer error:', err);
      setMessage('Не удалось зарегистрировать пользователя в Т-банк');
      setTimeout(() => setMessage(null), 3000);
      return false;
    }
  };

  // Привязка карты (выплаты)
  const handleAddCard = async () => {
    try {
      if (isSyncingCards || isBinding) return;
      setIsBinding(true);

      if (!supabase || !session || !user) throw new Error('Нет активной сессии');

      const ok = await registerCustomer();
      if (!ok) throw new Error('Регистрация не выполнена');

      const r = await fetch('/api/tbank/add-card', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) {
        setMessage(data?.error || `Ошибка привязки: HTTP ${r.status}`);
        setTimeout(() => setMessage(null), 3500);
        return;
      }

      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      } else {
        setMessage('Не получен URL привязки');
        setTimeout(() => setMessage(null), 3000);
      }
    } catch (err) {
      console.error('add card error:', err);
      setMessage(err.message || 'Ошибка при инициации привязки карты');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setIsBinding(false);
    }
  };

  // Удаление карты (выплаты/оплаты — разные эндпоинты)
  const handleRemoveCard = async (scope, cardId) => {
    try {
      if (isSyncingCards || removingId) return;
      setRemovingId(cardId);
      if (!supabase || !session || !user) throw new Error('Нет активной сессии');

      const endpoint = scope === 'payment' ? '/api/tbank/remove-card-payment' : '/api/tbank/remove-card';
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ cardId }),
      });
      const data = await r.json().catch(() => ({}));

      if (!r.ok || data?.error) {
        console.warn('remove-card non-ok:', data);
        setMessage(data?.error || `Не удалось удалить карту (HTTP ${r.status})`);
        setTimeout(() => setMessage(null), 3500);
        await syncBothAndLoad(); // чтобы показать актуальное состояние
        return;
      }

      await syncBothAndLoad();
      setMessage('Карта удалена');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      console.error('remove card error:', err);
      setMessage(err.message || 'Ошибка удаления карты');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setRemovingId(null);
    }
  };

  // Назначение «основной» в рамках конкретного скоупа
  const handleSetPrimary = async (scope, cardId) => {
    try {
      if (isSyncingCards || settingPrimaryId || removingId) return;
      setSettingPrimaryId(cardId);
      if (!supabase || !session || !user) throw new Error('Нет активной сессии');

      // Снять флаг со всех карт этого скоупа
      const { error: clearErr } = await supabase
        .from('user_cards')
        .update({ is_primary: false })
        .eq('user_id', user.id)
        .eq('card_scope', scope);
      if (clearErr) throw clearErr;

      // Поставить флаг выбранной
      const { error: setErr } = await supabase
        .from('user_cards')
        .update({ is_primary: true })
        .eq('user_id', user.id)
        .eq('card_scope', scope)
        .eq('card_id', cardId);
      if (setErr) throw setErr;

      // Обновить локальный стейт без лишних запросов
      if (scope === 'payment') {
        setCardsPayment(prev => prev.map(c => ({ ...c, is_primary: c.card_id === cardId })));
      } else {
        setCardsPayout(prev => prev.map(c => ({ ...c, is_primary: c.card_id === cardId })));
      }
      setMessage('Основная карта обновлена');
      setTimeout(() => setMessage(null), 1500);
    } catch (err) {
      console.error('set primary error:', err);
      setMessage(err.message || 'Не удалось выбрать основную карту');
      setTimeout(() => setMessage(null), 3000);
    } finally {
      setSettingPrimaryId(null);
    }
  };

  if (isLoading) return <div className={pcStyles.loadingSpinner}>Загрузка…</div>;

  // Рендер одной панели со списком карт по скоупу
  const CardsScopePanel = ({ scope }) => {
    const isPayment = scope === 'payment';
    const items = isPayment ? cardsPayment : cardsPayout;
    const disabled = isSyncingCards || !!settingPrimaryId || !!removingId;

    const emptyTitle = isPayment ? 'Нет карт для оплат' : 'Нет карт для выплат';
    const emptySub = isPayment
      ? 'Сохраните карту при оплате — включите галочку «Сохранить карту» на форме банка.'
      : 'Добавьте карту, чтобы получать выплаты на этот счёт.';

    return (
      <>
        <div className={pcStyles.cardsPanel}>
          <div className={pcStyles.cardsToolbar}>
            {!isPayment && (
              <button
                className={pcStyles.actionButton}
                onClick={handleAddCard}
                disabled={isSyncingCards || isBinding}
              >
                {isBinding ? 'Открываем форму…' : 'Привязать новую карту'}
              </button>
            )}
          </div>

          {isSyncingCards ? (
            <div className={pcStyles.cardGrid}>
              {[1,2,3].map(i=>(
                <div key={i} className={`${pcStyles.cardTile} ${pcStyles.skeleton}`}>
                  <div className={pcStyles.skeletonLine} />
                  <div className={pcStyles.skeletonLineShort} />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className={pcStyles.emptyBlock}>
              <div className={pcStyles.emptyTitle}>{emptyTitle}</div>
              <div className={pcStyles.emptySub}>{emptySub}</div>
            </div>
          ) : (
            <div className={pcStyles.cardGrid}>
              {items.map((card) => {
                const isPrimary = !!card.is_primary || (items.length === 1);
                const badgeOk = !card.isExpired;
                return (
                  <div key={`${scope}-${card.id || card.card_id}`} className={pcStyles.cardTile}>
                    <div className={pcStyles.cardBrand}>
                      <span className={pcStyles.cardBrandDot} />
                      <span className={pcStyles.cardBrandText}>Карта</span>
                    </div>

                    <div className={pcStyles.cardPan}>**** **** **** {card.last_four_digits || '••••'}</div>

                    <div className={pcStyles.cardMeta}>
                      <span className={pcStyles.cardMetaItem}>Срок: {card.expiry_date || '—'}</span>
                      <span className={`${pcStyles.cardStatus} ${badgeOk ? pcStyles.ok : pcStyles.bad}`}>
                        {badgeOk ? 'Активна' : 'Истекла'}
                      </span>
                    </div>

                    <div
                      className={pcStyles.primaryRow}
                      title={isPayment
                        ? 'Эта карта будет использоваться по умолчанию для оплат'
                        : 'Эта карта будет использоваться по умолчанию для выплат'}
                    >
                      <label className={pcStyles.primaryLabel}>
                        <input
                          type="radio"
                          name={`primaryCard-${scope}`}
                          className={pcStyles.primaryRadio}
                          checked={isPrimary}
                          disabled={disabled || items.length === 1}
                          onChange={() => !isPrimary && handleSetPrimary(scope, card.card_id)}
                        />
                        <span>Основная</span>
                      </label>
                      {isPayment && (
                        <span className={pcStyles.helpIcon} title="Чтобы добавить платёжную карту — сохраните её при оплате">i</span>
                      )}
                    </div>

                    <div className={pcStyles.cardActions}>
                      <button
                        className={pcStyles.removeButton}
                        onClick={() => handleRemoveCard(scope, card.card_id)}
                        disabled={!!removingId || isSyncingCards}
                        title="Удалить карту"
                      >
                        {removingId === card.card_id ? 'Удаляем…' : 'Удалить'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <div className={pcStyles.sectionContent}>
      <div className={pcStyles.tabs}>
        <button className={activeTab === 'individual' ? pcStyles.activeTab : pcStyles.tab} onClick={() => setActiveTab('individual')}>Личные данные</button>
        <button className={activeTab === 'cards' ? pcStyles.activeTab : pcStyles.tab} onClick={() => setActiveTab('cards')}>Мои карты</button>
        <button className={activeTab === 'company' ? pcStyles.activeTab : pcStyles.tab} onClick={() => setActiveTab('company')}>Компании</button>
      </div>

      <div className={pcStyles.tabContent}>
        {activeTab === 'individual' && (
          <div className={pcStyles.settingsForm}>
            <AvatarEditor user={user} avatarUrl={avatarUrl} updateAvatarUrl={setAvatarUrl} supabase={supabase} type="individual" />
            <div className={pcStyles.inputGroup}><label>Имя</label><input value={profileData.firstName} onChange={(e)=>setProfileData(p=>({...p,firstName:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>Фамилия</label><input value={profileData.lastName} onChange={(e)=>setProfileData(p=>({...p,lastName:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>Отчество</label><input value={profileData.patronymic} onChange={(e)=>setProfileData(p=>({...p,patronymic:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>Дата рождения</label><input type="date" value={profileData.birthDate} onChange={(e)=>setProfileData(p=>({...p,birthDate:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>Локация</label><input value={profileData.location} onChange={(e)=>setProfileData(p=>({...p,location:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>О себе</label><textarea value={profileData.about} onChange={(e)=>setProfileData(p=>({...p,about:e.target.value}))} /></div>
            <div className={pcStyles.inputGroup}><label>Телефон</label><span>{profileData.phone}</span></div>
            <button className={pcStyles.actionButton} onClick={handleSaveIndividual} disabled={isSaving}>{isSaving ? 'Сохраняем…' : 'Сохранить'}</button>
          </div>
        )}

        {activeTab === 'cards' && (
          <>
            {/* Подтабы: Оплаты / Выплаты */}
            <div className={pcStyles.tabs} style={{ marginTop: 8 }}>
              <button
                className={cardsTab === 'payment' ? pcStyles.activeTab : pcStyles.tab}
                onClick={() => setCardsTab('payment')}
              >
                Карты для оплат
              </button>
              <button
                className={cardsTab === 'payout' ? pcStyles.activeTab : pcStyles.tab}
                onClick={() => setCardsTab('payout')}
              >
                Карты для выплат
              </button>
            </div>

            {cardsTab === 'payment'
              ? <CardsScopePanel scope="payment" />
              : <CardsScopePanel scope="payout" />
            }
          </>
        )}

        {activeTab === 'company' && (
          <CompanySettings user={user} supabase={supabase} profilePhone={profileData.phone} />
        )}
      </div>

      {message && <div className={pcStyles.toast}>{message}</div>}
    </div>
  );
};

export default SettingsPagePC;
