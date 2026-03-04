import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../pages/_app';
import { useRouter } from 'next/router';
import mobileStyles from '../styles/settings.mobile.module.css';
import AvatarEditorMobile from '../components/AvatarEditorMobile';
import CompanySettingsMobile from '../components/CompanySettingsMobile';
import { getCurrentPositionWithPermission, registerPushAndSyncToken, isNativePlatform } from '../lib/mobile/capacitor';
import { NativeSettingsMenuRows, PermissionsView, NotificationsView } from '../components/mobile/NativeSettingsPanels';

const SettingsPageMobile = ({ avatarUrl, setAvatarUrl }) => {
  const { user, session, supabase } = useAuth();
  const router = useRouter();

  // Текущее представление настроек: меню -> экран
  const [view, setView] = useState('menu'); // 'menu' | 'individual' | 'cards' | 'company' | 'permissions' | 'notifications'
  const [cardsTab, setCardsTab] = useState('payment'); // 'payment' | 'payout'

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const [message, setMessage] = useState(null);

  const [nativeInfo, setNativeInfo] = useState({
    isNative: false,
    geolocationStatus: 'Не запрошено',
    pushStatus: 'Не подключено',
  });

  useEffect(() => {
    isNativePlatform().then((isNative) => {
      setNativeInfo((prev) => ({ ...prev, isNative }));
    });
  }, []);

  useEffect(() => {
    if (!nativeInfo.isNative && (view === 'permissions' || view === 'notifications')) {
      setView('menu');
    }
  }, [nativeInfo.isNative, view]);

  // ===== профиль =====
  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    patronymic: '',
    birthDate: '',
    location: '',
    geoLat: '',
    geoLon: '',
    about: '',
    phone: '+7',
  });

  // DaData (подсказки адреса)
  const [suggestions, setSuggestions] = useState([]);

  // ===== карты =====
  const [cardsPayment, setCardsPayment] = useState([]); // user_cards where card_scope='payment'
  const [cardsPayout, setCardsPayout] = useState([]); // user_cards where card_scope='payout'
  const [isSyncingCards, setIsSyncingCards] = useState(false);
  const [isBinding, setIsBinding] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [settingPrimaryId, setSettingPrimaryId] = useState(null);
  const syncOnceRef = useRef(false);
  const profileLoadedRef = useRef(false);

  const toast = useCallback((text, ms = 2500) => {
    setMessage(text);
    if (text) setTimeout(() => setMessage(null), ms);
  }, []);

  const handleRequestGeolocation = useCallback(async () => {
    try {
      const position = await getCurrentPositionWithPermission();
      const lat = Number(position?.coords?.latitude || 0).toFixed(6);
      const lon = Number(position?.coords?.longitude || 0).toFixed(6);
      setProfileData((prev) => ({ ...prev, geoLat: lat, geoLon: lon }));
      setNativeInfo((prev) => ({ ...prev, geolocationStatus: `Разрешено (${lat}, ${lon})` }));
      toast('Геопозиция обновлена');
    } catch (error) {
      setNativeInfo((prev) => ({ ...prev, geolocationStatus: `Ошибка: ${error.message}` }));
      toast('Не удалось получить геопозицию');
    }
  }, [toast]);

  const handleEnablePush = useCallback(async () => {
    try {
      const token = await registerPushAndSyncToken(user?.id);
      setNativeInfo((prev) => ({ ...prev, pushStatus: token ? `Токен получен (${token.slice(0, 12)}...)` : 'Недоступно на web' }));
      toast('Push-токен сохранён');
    } catch (error) {
      setNativeInfo((prev) => ({ ...prev, pushStatus: `Ошибка: ${error.message}` }));
      toast('Не удалось подключить push');
    }
  }, [toast, user?.id]);

  // Выход из аккаунта (перенесён в меню настроек)
  const handleLogout = useCallback(async () => {
    if (isLoggingOut) return;

    const msg =
      'Вы действительно хотите выйти из личного кабинета Onloc?\n' +
      'Вы сможете войти снова в любой момент.';
    const ok = typeof window !== 'undefined' ? window.confirm(msg) : true;
    if (!ok) return;

    try {
      setIsLoggingOut(true);
      if (!supabase) throw new Error('no supabase');
      await supabase.auth.signOut();

      // На всякий: уводим на авторизацию
      try {
        await router.push('/auth');
      } catch {
        window.location.href = '/auth';
      }
    } catch (e) {
      console.error('[SettingsMobile][logout] error:', e);
      toast('Не удалось выйти. Попробуйте ещё раз.');
    } finally {
      setIsLoggingOut(false);
    }
  }, [isLoggingOut, supabase, router, toast]);


  const normalizeLocalCard = (c) => {
    let isExpired = false;
    if (c?.expiry_date) {
      let mm = null;
      let yy = null;
      if (/^\d{4}$/.test(c.expiry_date)) {
        mm = c.expiry_date.slice(0, 2);
        yy = c.expiry_date.slice(2, 4);
      } else if (/^\d{2}\/\d{2}$/.test(c.expiry_date)) {
        [mm, yy] = c.expiry_date.split('/');
      }
      if (mm && yy) {
        const lastDay = new Date(Number('20' + yy), Number(mm), 0);
        const now = new Date();
        isExpired = lastDay < new Date(now.getFullYear(), now.getMonth(), 1);
      }
    }
    return { ...c, isExpired };
  };

  // ===== загрузка профиля =====
  const fetchProfile = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setIsLoading(true);
    try {
      if (!supabase) throw new Error('no supabase');
      if (!session || !user) throw new Error('no session');

      const { data, error } = await supabase
        .from('profiles')
        .select('first_name, last_name, patronymic, birth_date, location, geo_lat, geo_lon, about, phone')
        .eq('user_id', user.id)
        .single();

      if (error) throw error;

      setProfileData({
        firstName: data?.first_name || '',
        lastName: data?.last_name || '',
        patronymic: data?.patronymic || '',
        birthDate: data?.birth_date || '',
        location: data?.location || '',
        geoLat: data?.geo_lat || '',
        geoLon: data?.geo_lon || '',
        about: data?.about || '',
        phone: data?.phone || '+7',
      });
      profileLoadedRef.current = true;
    } catch (error) {
      console.error('Ошибка загрузки профиля:', { message: error?.message, stack: error?.stack });
      toast('Не удалось загрузить профиль', 3000);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [supabase, session, user?.id, toast]);

  // ===== DaData =====
  const fetchDaDataSuggestions = useCallback(async (query) => {
    if (query.length < 3) {
      setSuggestions([]);
      return;
    }
    try {
      const response = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Token ${process.env.NEXT_PUBLIC_DADATA_TOKEN}`,
        },
        body: JSON.stringify({ query, count: 5 }),
      });
      const data = await response.json();
      setSuggestions(data.suggestions || []);
    } catch (error) {
      console.error('Ошибка загрузки подсказок DaData:', { message: error?.message, stack: error?.stack });
    }
  }, []);

  const handleLocationChange = useCallback(
    (e) => {
      const value = e.target.value;
      setProfileData((prev) => ({ ...prev, location: value }));
      fetchDaDataSuggestions(value);
    },
    [fetchDaDataSuggestions]
  );

  const handleSuggestionSelect = useCallback((s) => {
    const value = s?.value || '';
    const geoLat = s?.data?.geo_lat || '';
    const geoLon = s?.data?.geo_lon || '';
    setProfileData((prev) => ({ ...prev, location: value, geoLat, geoLon }));
    setSuggestions([]);
  }, []);

  const handleSaveProfile = useCallback(
    async (e) => {
      e.preventDefault();
      if (isSaving) return;

      try {
        setIsSaving(true);
        if (!supabase || !session || !user) throw new Error('Нет активной сессии');

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

        toast('Профиль сохранён!', 2000);
      } catch (error) {
        console.error('Ошибка сохранения профиля:', { message: error?.message, stack: error?.stack });
        toast('Не удалось сохранить профиль', 3000);
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, profileData, supabase, session, user?.id, toast]
  );

  // ===== карты: загрузка из user_cards =====
  const loadCardsByScope = useCallback(
    async (scope) => {
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
    },
    [supabase, user?.id]
  );

  const refreshBothScopes = useCallback(async () => {
    const [pay, out] = await Promise.all([loadCardsByScope('payment'), loadCardsByScope('payout')]);
    setCardsPayment(pay);
    setCardsPayout(out);
  }, [loadCardsByScope]);

  const syncBothAndLoad = useCallback(async () => {
    if (!session?.access_token) return;
    setIsSyncingCards(true);
    try {
      await Promise.all([
        fetch('/api/tbank/sync-cards-payment', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }),
        fetch('/api/tbank/sync-cards', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }),
      ]);
      await refreshBothScopes();
      toast('Карты обновлены', 1500);
    } catch (e) {
      console.error('Синхронизация карт упала:', e);
      await refreshBothScopes();
      toast('Не удалось синхронизировать карты', 3000);
    } finally {
      setIsSyncingCards(false);
    }
  }, [session?.access_token, refreshBothScopes, toast]);

  // Регистрация customer (для выплат)
  const registerCustomer = async () => {
    if (!session?.access_token) {
      toast('Неавторизованный доступ', 3000);
      return false;
    }
    try {
      const r = await fetch('/api/tbank/add-customer', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) {
        toast(data?.error || `Ошибка регистрации: HTTP ${r.status}`, 3500);
        return false;
      }
      return true;
    } catch (e) {
      console.error('register customer error:', e);
      toast('Не удалось зарегистрировать клиента', 3000);
      return false;
    }
  };

  const handleAddPayoutCard = async () => {
    if (isBinding || isSyncingCards) return;
    setIsBinding(true);
    try {
      if (!session?.access_token) throw new Error('Неавторизованный доступ');

      const ok = await registerCustomer();
      if (!ok) return;

      const r = await fetch('/api/tbank/add-card', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) {
        toast(data?.error || `Ошибка привязки: HTTP ${r.status}`, 3500);
        return;
      }

      if (data?.paymentUrl) {
        window.location.href = data.paymentUrl;
        return;
      }

      toast('Откройте форму привязки карты', 2500);
    } catch (err) {
      console.error('add card error:', err);
      toast(err?.message || 'Ошибка при инициации привязки карты', 3000);
    } finally {
      setIsBinding(false);
    }
  };

  // Удаление карты (выплаты/оплаты — разные эндпоинты)
  const handleRemoveCard = async (scope, cardId) => {
    try {
      if (isSyncingCards || removingId) return;
      const confirmed = window.confirm('Удалить эту карту? Это действие нельзя отменить.');
      if (!confirmed) return;
      setRemovingId(cardId);
      if (!supabase || !session || !user) throw new Error('Нет активной сессии');

      const endpoint = scope === 'payment' ? '/api/tbank/remove-card-payment' : '/api/tbank/remove-card';
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${r.status}`);
      }

      if (scope === 'payment') setCardsPayment((prev) => prev.filter((c) => c.card_id !== cardId));
      else setCardsPayout((prev) => prev.filter((c) => c.card_id !== cardId));

      toast('Карта удалена', 1800);
    } catch (err) {
      console.error('remove card error:', err);
      toast(err?.message || 'Ошибка удаления карты', 3000);
    } finally {
      setRemovingId(null);
    }
  };

  const handleSetPrimary = async (scope, cardId) => {
    try {
      if (isSyncingCards || settingPrimaryId || removingId) return;
      setSettingPrimaryId(cardId);
      if (!supabase || !session || !user) throw new Error('Нет активной сессии');

      const { error: clearErr } = await supabase
        .from('user_cards')
        .update({ is_primary: false })
        .eq('user_id', user.id)
        .eq('card_scope', scope);
      if (clearErr) throw clearErr;

      const { error: setErr } = await supabase
        .from('user_cards')
        .update({ is_primary: true })
        .eq('user_id', user.id)
        .eq('card_scope', scope)
        .eq('card_id', cardId);
      if (setErr) throw setErr;

      if (scope === 'payment') {
        setCardsPayment((prev) => prev.map((c) => ({ ...c, is_primary: c.card_id === cardId })));
      } else {
        setCardsPayout((prev) => prev.map((c) => ({ ...c, is_primary: c.card_id === cardId })));
      }

      toast('Основная карта обновлена', 1500);
    } catch (err) {
      console.error('set primary error:', err);
      toast(err?.message || 'Не удалось выбрать основную карту', 3000);
    } finally {
      setSettingPrimaryId(null);
    }
  };

  // ===== init =====
  useEffect(() => {
    if (user && session) {
      fetchProfile({ silent: profileLoadedRef.current });

      refreshBothScopes();

      if (!syncOnceRef.current) {
        syncOnceRef.current = true;
        syncBothAndLoad();
      }
    }
  }, [user?.id, Boolean(session), fetchProfile, refreshBothScopes, syncBothAndLoad]);

  if (isLoading) {
    return (
      <div className={mobileStyles.loadingContainer}>
        <div className={mobileStyles.spinner}></div>
      </div>
    );
  }

  const CardsScopePanel = ({ scope }) => {
    const isPayment = scope === 'payment';
    const items = isPayment ? cardsPayment : cardsPayout;

    const disabled = isSyncingCards || !!settingPrimaryId || !!removingId;
    const emptyTitle = isPayment ? 'Нет карт для оплат' : 'Нет карт для выплат';
    const emptySub = isPayment
      ? 'Платёжные карты появляются здесь после оплаты (нужно включить «Сохранить карту» на форме банка).'
      : 'Добавьте карту, чтобы получать выплаты.';

    return (
      <div className={mobileStyles.cardsPanel}>
        <div className={mobileStyles.cardsToolbar}>
          <button
            className={mobileStyles.smallButton}
            onClick={syncBothAndLoad}
            disabled={isSyncingCards}
            title="Синхронизировать карты"
            type="button"
          >
            {isSyncingCards ? 'Обновляем…' : 'Обновить'}
          </button>

          {!isPayment && (
            <button
              className={mobileStyles.actionButton}
              onClick={handleAddPayoutCard}
              disabled={disabled || isBinding}
              title="Привязать карту для выплат"
              type="button"
            >
              {isBinding ? 'Открываем…' : 'Привязать карту'}
            </button>
          )}
        </div>

        {items.length === 0 && !isSyncingCards ? (
          <div className={mobileStyles.emptyBlock}>
            <div className={mobileStyles.emptyTitle}>{emptyTitle}</div>
            <div className={mobileStyles.emptySub}>{emptySub}</div>
          </div>
        ) : (
          <div className={mobileStyles.cardGrid}>
            {(items.length === 0 && isSyncingCards ? [1, 2] : items).map((card, idx) => {
              const key = card?.card_id || `s-${idx}`;
              const isSkeleton = !card?.card_id;
              const isPrimary = !!card?.is_primary;

              return (
                <div key={key} className={`${mobileStyles.cardTile} ${isSkeleton ? mobileStyles.skeleton : ''}`}>
                  <div className={mobileStyles.cardBrand}>
                    <span className={mobileStyles.cardBrandDot} />
                    <span className={mobileStyles.cardBrandText}>
                      {isSkeleton ? ' ' : isPayment ? 'Карта для оплат' : 'Карта для выплат'}
                    </span>
                  </div>

                  <div className={mobileStyles.cardPan}>{isSkeleton ? ' ' : `•••• ${card.last_four_digits || '----'}`}</div>

                  <div className={mobileStyles.cardMeta}>
                    <span className={mobileStyles.cardMetaItem}>
                      {isSkeleton ? ' ' : card.expiry_date ? `до ${card.expiry_date}` : 'срок не указан'}
                      {!isSkeleton && card.isExpired ? ' • истекла' : ''}
                    </span>
                  </div>

                  <div className={mobileStyles.primaryRow}>
                    <label
                      className={mobileStyles.primaryLabel}
                      title={
                        isPayment
                          ? 'Эта карта будет использоваться по умолчанию для оплат'
                          : 'Эта карта будет использоваться по умолчанию для выплат'
                      }
                    >
                      <input
                        type="radio"
                        name={`primaryCard-${scope}`}
                        className={mobileStyles.primaryRadio}
                        checked={isPrimary}
                        disabled={disabled || items.length <= 1 || isSkeleton}
                        onChange={() => !isPrimary && handleSetPrimary(scope, card.card_id)}
                      />
                      <span>Основная</span>
                    </label>
                    {isPayment && (
                      <span
                        className={mobileStyles.helpIcon}
                        title="Чтобы добавить платёжную карту — сохраните её при оплате (галочка «Сохранить карту» на форме банка)."
                      >
                        i
                      </span>
                    )}
                  </div>

                  {!isSkeleton && (
                    <div className={mobileStyles.cardActions}>
                      <button
                        className={mobileStyles.removeButton}
                        onClick={() => handleRemoveCard(scope, card.card_id)}
                        disabled={!!removingId || isSyncingCards}
                        title="Удалить карту"
                        type="button"
                      >
                        {removingId === card.card_id ? 'Удаляем…' : 'Удалить'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={mobileStyles.pageWrapper}>
      <div className={mobileStyles.page}>
        {/* ===== Меню настроек ===== */}
        {view === 'menu' && (
          <div className={mobileStyles.settingsMenu}>
            <h2 className={mobileStyles.menuTitle}>Настройки</h2>

            <button
              type="button"
              className={mobileStyles.menuRow}
              onClick={() => setView('individual')}
            >
              <div className={mobileStyles.menuRowLeft}>
                <div className={mobileStyles.menuRowTitle}>Личные данные</div>
                <div className={mobileStyles.menuRowHint}>Профиль, аватар, контакты</div>
              </div>
              <div className={mobileStyles.menuChevron} aria-hidden="true">›</div>
            </button>

            <button
              type="button"
              className={mobileStyles.menuRow}
              onClick={() => setView('cards')}
            >
              <div className={mobileStyles.menuRowLeft}>
                <div className={mobileStyles.menuRowTitle}>Мои карты</div>
                <div className={mobileStyles.menuRowHint}>Оплаты и выплаты</div>
              </div>
              <div className={mobileStyles.menuChevron} aria-hidden="true">›</div>
            </button>

            <button
              type="button"
              className={mobileStyles.menuRow}
              onClick={() => setView('company')}
            >
              <div className={mobileStyles.menuRowLeft}>
                <div className={mobileStyles.menuRowTitle}>Компании</div>
                <div className={mobileStyles.menuRowHint}>Реквизиты, верификация</div>
              </div>
              <div className={mobileStyles.menuChevron} aria-hidden="true">›</div>
            </button>

            {nativeInfo.isNative && (
              <NativeSettingsMenuRows nativeInfo={nativeInfo} setView={setView} />
            )}

            <button
              type="button"
              className={`${mobileStyles.menuRow} ${mobileStyles.menuRowDanger}`}
              onClick={handleLogout}
              disabled={isLoggingOut}
              title="Выйти из аккаунта"
            >
              <div className={mobileStyles.menuRowLeft}>
                <div className={mobileStyles.menuRowTitle}>
                  {isLoggingOut ? 'Выходим…' : 'Выйти'}
                </div>
                <div className={mobileStyles.menuRowHint}>Завершить сеанс</div>
              </div>
            </button>
          </div>
        )}

        {/* ===== Экран: Личные данные ===== */}
        {view === 'individual' && (
          <div
            className={mobileStyles.subPage}
            onTouchStart={(e) => {
              const x = e.touches?.[0]?.clientX ?? 0;
              const y = e.touches?.[0]?.clientY ?? 0;
              // сохраняем на element dataset (просто и без лишних refs)
              e.currentTarget.dataset.sx = String(x);
              e.currentTarget.dataset.sy = String(y);
            }}
            onTouchEnd={(e) => {
              const sx = Number(e.currentTarget.dataset.sx || 0);
              const sy = Number(e.currentTarget.dataset.sy || 0);
              const ex = e.changedTouches?.[0]?.clientX ?? 0;
              const ey = e.changedTouches?.[0]?.clientY ?? 0;

              const dx = ex - sx;
              const dy = Math.abs(ey - sy);

              // свайп вправо (лучше начинать у левого края), без сильного вертикального движения
              if (sx <= 40 && dx >= 90 && dy <= 60) setView('menu');
            }}
          >
            <div className={mobileStyles.subHeader}>
              <button type="button" className={mobileStyles.backButton} onClick={() => setView('menu')}>
                Назад
              </button>
              <div className={mobileStyles.subTitle}>Личные данные</div>
              <div className={mobileStyles.subHeaderSpacer} />
            </div>

            <form onSubmit={handleSaveProfile} className={mobileStyles.form}>
              <div className={mobileStyles.section}>
                <AvatarEditorMobile
  user={user}
  avatarUrl={avatarUrl}
  updateAvatarUrl={setAvatarUrl}
  supabase={supabase}
  type="individual"
/>


                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="firstName">Имя</label>
                  <input
                    id="firstName"
                    value={profileData.firstName}
                    onChange={(e) =>
                      setProfileData((prev) => ({ ...prev, firstName: e.target.value }))
                    }
                  />
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="lastName">Фамилия</label>
                  <input
                    id="lastName"
                    value={profileData.lastName}
                    onChange={(e) =>
                      setProfileData((prev) => ({ ...prev, lastName: e.target.value }))
                    }
                  />
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="patronymic">Отчество</label>
                  <input
                    id="patronymic"
                    value={profileData.patronymic}
                    onChange={(e) =>
                      setProfileData((prev) => ({ ...prev, patronymic: e.target.value }))
                    }
                  />
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="birthDate">Дата рождения</label>
                  <input
                    id="birthDate"
                    type="date"
                    value={profileData.birthDate}
                    onChange={(e) =>
                      setProfileData((prev) => ({ ...prev, birthDate: e.target.value }))
                    }
                  />
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="location">Местоположение</label>
                  <input
                    id="location"
                    value={profileData.location}
                    onChange={handleLocationChange}
                    placeholder="Введите местоположение"
                  />
                  {suggestions.length > 0 && (
                    <ul className={mobileStyles.suggestions}>
                      {suggestions.map((s, idx) => (
                        <li
                          key={`${s?.value || idx}`}
                          onClick={() => handleSuggestionSelect(s)}
                        >
                          {s.value}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="about">О себе</label>
                  <textarea
                    id="about"
                    value={profileData.about}
                    onChange={(e) =>
                      setProfileData((prev) => ({ ...prev, about: e.target.value }))
                    }
                    placeholder="Расскажите о себе"
                  />
                </div>

                <div className={mobileStyles.inputGroup}>
                  <label htmlFor="phone">Телефон</label>
                  <input
                    id="phone"
                    value={profileData.phone}
                    disabled
                    className={mobileStyles.disabledInput}
                  />
                </div>
              </div>

              <button
                type="submit"
                className={mobileStyles.saveButton}
                disabled={isSaving}
                title="Сохранить изменения"
              >
                {isSaving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </form>
          </div>
        )}

        {/* ===== Экран: Карты ===== */}
        {view === 'cards' && (
          <div
            className={mobileStyles.subPage}
            onTouchStart={(e) => {
              const x = e.touches?.[0]?.clientX ?? 0;
              const y = e.touches?.[0]?.clientY ?? 0;
              e.currentTarget.dataset.sx = String(x);
              e.currentTarget.dataset.sy = String(y);
            }}
            onTouchEnd={(e) => {
              const sx = Number(e.currentTarget.dataset.sx || 0);
              const sy = Number(e.currentTarget.dataset.sy || 0);
              const ex = e.changedTouches?.[0]?.clientX ?? 0;
              const ey = e.changedTouches?.[0]?.clientY ?? 0;
              const dx = ex - sx;
              const dy = Math.abs(ey - sy);
              if (sx <= 40 && dx >= 90 && dy <= 60) setView('menu');
            }}
          >
            <div className={mobileStyles.subHeader}>
              <button type="button" className={mobileStyles.backButton} onClick={() => setView('menu')}>
                Назад
              </button>
              <div className={mobileStyles.subTitle}>Мои карты</div>
              <div className={mobileStyles.subHeaderSpacer} />
            </div>

            <div className={mobileStyles.form}>
              <div className={mobileStyles.section}>
                <div className={mobileStyles.segmented}>
                  <button
                    className={cardsTab === 'payment' ? mobileStyles.segActive : mobileStyles.segBtn}
                    onClick={() => setCardsTab('payment')}
                    type="button"
                  >
                    Оплаты
                  </button>
                  <button
                    className={cardsTab === 'payout' ? mobileStyles.segActive : mobileStyles.segBtn}
                    onClick={() => setCardsTab('payout')}
                    type="button"
                  >
                    Выплаты
                  </button>
                </div>

                {cardsTab === 'payment' ? <CardsScopePanel scope="payment" /> : <CardsScopePanel scope="payout" />}
              </div>
            </div>
          </div>
        )}

        {/* ===== Экран: Компания ===== */}
        {view === 'company' && (
          <div
            className={mobileStyles.subPage}
            onTouchStart={(e) => {
              const x = e.touches?.[0]?.clientX ?? 0;
              const y = e.touches?.[0]?.clientY ?? 0;
              e.currentTarget.dataset.sx = String(x);
              e.currentTarget.dataset.sy = String(y);
            }}
            onTouchEnd={(e) => {
              const sx = Number(e.currentTarget.dataset.sx || 0);
              const sy = Number(e.currentTarget.dataset.sy || 0);
              const ex = e.changedTouches?.[0]?.clientX ?? 0;
              const ey = e.changedTouches?.[0]?.clientY ?? 0;
              const dx = ex - sx;
              const dy = Math.abs(ey - sy);
              if (sx <= 40 && dx >= 90 && dy <= 60) setView('menu');
            }}
          >
            <div className={mobileStyles.subHeader}>
              <button type="button" className={mobileStyles.backButton} onClick={() => setView('menu')}>
                Назад
              </button>
              <div className={mobileStyles.subTitle}>Компании</div>
              <div className={mobileStyles.subHeaderSpacer} />
            </div>

            <div className={mobileStyles.form}>
              <CompanySettingsMobile user={user} supabase={supabase} profilePhone={profileData.phone} />
            </div>
          </div>
        )}

        {nativeInfo.isNative && view === 'permissions' && (
          <PermissionsView
            nativeInfo={nativeInfo}
            setView={setView}
            onRequestGeolocation={handleRequestGeolocation}
          />
        )}

        {nativeInfo.isNative && view === 'notifications' && (
          <NotificationsView
            nativeInfo={nativeInfo}
            setView={setView}
            onEnablePush={handleEnablePush}
          />
        )}

        {message && <div className={mobileStyles.snackbar}>{message}</div>}
      </div>
    </div>
  );
};

export default SettingsPageMobile;
