import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../_app';
import pcStyles from '../../styles/profileSetup.pc.module.css';

export default function ProfileSetupPC({ user, router }) {
  const { updateProfileStatus } = useAuth(); // Получаем функцию из контекста
  const [firstName, setFirstName] = useState('');
  const [location, setLocation] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [geoLat, setGeoLat] = useState('');
  const [geoLon, setGeoLon] = useState('');
  const [birthDate, setBirthDate] = useState('');
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
    <div className={pcStyles.container}>
      <h1 className={pcStyles.header}>Настройка профиля</h1>
      <div className={pcStyles.form}>
        <div className={pcStyles.inputGroup}>
          <label className={pcStyles.label}>Имя</label>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="Введите ваше имя"
            className={pcStyles.input}
            disabled={loading}
          />
        </div>
        <div className={pcStyles.inputGroup}>
          <label className={pcStyles.label}>Локация</label>
          <input
            type="text"
            value={location}
            onChange={handleLocationChange}
            placeholder="Введите город"
            className={pcStyles.input}
            disabled={loading}
          />
          {suggestions.length > 0 && (
            <ul className={pcStyles.suggestions}>
              {suggestions.map((suggestion, index) => (
                <li
                  key={index}
                  className={pcStyles.suggestionItem}
                  onClick={() => handleSuggestionClick(suggestion)}
                >
                  {suggestion.value}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={pcStyles.inputGroup}>
          <label className={pcStyles.label}>Дата рождения</label>
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            className={pcStyles.input}
            disabled={loading}
          />
        </div>
        <div className={pcStyles.inputGroup}>
          <label className={pcStyles.label}>Пол</label>
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value)}
            className={pcStyles.select}
            disabled={loading}
          >
            <option value="">Выберите пол</option>
            <option value="male">Мужской</option>
            <option value="female">Женский</option>
          </select>
        </div>
        {errorMessage && <div className={pcStyles.error}>{errorMessage}</div>}
        <button
          onClick={saveProfile}
          disabled={loading || !firstName || !location || !birthDate || !gender}
          className={pcStyles.actionButton}
        >
          {loading ? 'Сохранение...' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}