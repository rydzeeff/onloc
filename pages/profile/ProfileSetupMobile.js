import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../_app';
import mobileStyles from '../../styles/profileSetup.mobile.module.css';

export default function ProfileSetupMobile({ user, router }) {
  const { updateProfileStatus } = useAuth(); // Получаем функцию из контекста
  const [step, setStep] = useState(1);
  const [firstName, setFirstName] = useState('');
  const [location, setLocation] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [geoLat, setGeoLat] = useState('');
  const [geoLon, setGeoLon] = useState('');
  const [birthDate, setBirthDate] = useState('');
const [birthDateText, setBirthDateText] = useState(''); // ДД.ММ.ГГГГ (то, что видит пользователь)
const datePickerRef = useRef(null);
  const [gender, setGender] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const DADATA_TOKEN = process.env.NEXT_PUBLIC_DADATA_TOKEN;

  const fetchLocationSuggestions = async (query) => {
    try {
      const response = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${DADATA_TOKEN}`,
        },
        body: JSON.stringify({ query, count: 5 }),
      });
      const data = await response.json();
      console.log('Suggestions from DaData:', data.suggestions);
      setSuggestions(data.suggestions || []);
    } catch (error) {
      console.error('Error fetching DaData suggestions:', error);
      setErrorMessage('Ошибка при получении подсказок адреса');
    }
  };

  const handleLocationChange = (e) => {
    const value = e.target.value;
    setLocation(value);
    if (value.length > 2) {
      fetchLocationSuggestions(value);
    } else {
      setSuggestions([]);
    }
  };

  const handleSuggestionClick = (suggestion) => {
    setLocation(suggestion.value);
    setGeoLat(suggestion.data.geo_lat || '');
    setGeoLon(suggestion.data.geo_lon || '');
    setSuggestions([]);
    nextStep();
  };

  const nextStep = () => {
    setStep((prev) => prev + 1);
  };

const isoToRu = (iso) => {
  // iso: YYYY-MM-DD
  if (!iso || typeof iso !== 'string' || iso.length < 10) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${y}`;
};

const ruToIso = (ru) => {
  // ru: DD.MM.YYYY
  if (!ru) return '';
  const s = ru.trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return '';
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (yyyy < 1900 || yyyy > new Date().getFullYear()) return '';
  if (mm < 1 || mm > 12) return '';

  const daysInMonth = new Date(yyyy, mm, 0).getDate();
  if (dd < 1 || dd > daysInMonth) return '';

  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

const openNativeDatePicker = () => {
  if (!datePickerRef.current) return;

  // showPicker есть не везде, поэтому fallback на click()
  if (typeof datePickerRef.current.showPicker === 'function') {
    datePickerRef.current.showPicker();
  } else {
    datePickerRef.current.click();
  }
};

const handleBirthDateTextChange = (e) => {
  const value = e.target.value;
  setBirthDateText(value);

  const iso = ruToIso(value);
  setBirthDate(iso); // важно: birthDate остаётся ISO для сохранения в БД
};

const handleBirthDateCalendarChange = (e) => {
  const iso = e.target.value;
  setBirthDate(iso);
  setBirthDateText(isoToRu(iso));
};


  const saveProfile = async () => {
    if (!firstName || !location || !birthDate || !gender) {
      setErrorMessage('Пожалуйста, заполните все поля');
      return;
    }

    setLoading(true);
    setErrorMessage('');

    try {
      const { data, error } = await supabase
        .from('profiles')
        .upsert({
          user_id: user.id,
          first_name: firstName,
          location,
          geo_lat: geoLat,
          geo_lon: geoLon,
          birth_date: birthDate,
          gender,
          phone: user.phone,
          phone_verified: true,
        }, { onConflict: 'user_id' })
        .select();

      if (error) throw error;

      // Обновляем состояние профиля в контексте немедленно
      updateProfileStatus(true);
      router.push('/trips');
    } catch (error) {
      console.error('Error saving profile:', error.message);
      setErrorMessage('Ошибка при сохранении профиля');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={mobileStyles.container}>
      <header className={mobileStyles.header}>
        <h1 className={mobileStyles.headerText}>Настройка профиля</h1>
      </header>
      <div className={mobileStyles.content}>
        {errorMessage && <div className={mobileStyles.error}>{errorMessage}</div>}
        {step === 1 && (
          <div className={mobileStyles.inputGroup}>
            <label className={mobileStyles.label}>Имя</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Введите имя"
              className={mobileStyles.input}
              disabled={loading}
              onKeyPress={(e) => e.key === 'Enter' && firstName && nextStep()}
            />
            <button
              onClick={nextStep}
              disabled={!firstName || loading}
              className={mobileStyles.actionButton}
            >
              {loading ? 'Подождите...' : 'Далее'}
            </button>
          </div>
        )}
        {step === 2 && (
          <div className={mobileStyles.inputGroup}>
            <label className={mobileStyles.label}>Локация</label>
            <input
              type="text"
              value={location}
              onChange={handleLocationChange}
              placeholder="Введите город"
              className={mobileStyles.input}
              disabled={loading}
            />
            {suggestions.length > 0 && (
              <ul className={mobileStyles.suggestions}>
                {suggestions.map((suggestion, index) => (
                  <li
                    key={index}
                    className={mobileStyles.suggestionItem}
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion.value}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={nextStep}
              disabled={!location || loading}
              className={mobileStyles.actionButton}
            >
              {loading ? 'Подождите...' : 'Далее'}
            </button>
          </div>
        )}
{step === 3 && (
  <div className={mobileStyles.inputGroup}>
    <label className={mobileStyles.label}>Дата рождения</label>

    <div className={mobileStyles.dateRow}>
      {/* Ручной ввод */}
      <input
        type="text"
        inputMode="numeric"
        placeholder="ДД.ММ.ГГГГ"
        value={birthDateText}
        onChange={handleBirthDateTextChange}
        className={mobileStyles.input}
        disabled={loading}
        onKeyPress={(e) => e.key === 'Enter' && birthDate && nextStep()}
      />

      {/* Кнопка открытия календаря */}
      <button
        type="button"
        onClick={openNativeDatePicker}
        className={mobileStyles.dateButton}
        disabled={loading}
        aria-label="Открыть календарь"
      >
        📅
      </button>

      {/* Скрытый нативный date input (нужен только чтобы открыть календарь) */}
      <input
        ref={datePickerRef}
        type="date"
        value={birthDate}
        onChange={handleBirthDateCalendarChange}
        className={mobileStyles.hiddenDateInput}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>

    <button
      onClick={nextStep}
      disabled={!birthDate || loading}
      className={mobileStyles.actionButton}
    >
      {loading ? 'Подождите...' : 'Далее'}
    </button>
  </div>
)}

        {step === 4 && (
          <div className={mobileStyles.inputGroup}>
            <label className={mobileStyles.label}>Пол</label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value)}
              className={mobileStyles.select}
              disabled={loading}
            >
              <option value="">Выберите пол</option>
              <option value="male">Мужской</option>
              <option value="female">Женский</option>
            </select>
            <button
              onClick={saveProfile}
              disabled={!gender || loading}
              className={mobileStyles.actionButton}
            >
              {loading ? 'Сохранение...' : 'Завершить'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}