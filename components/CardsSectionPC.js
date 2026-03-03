import { useState, useEffect } from 'react';
import pcStyles from '../styles/cards.pc.module.css';  // Новый CSS для карт

const CardsSectionPC = ({ user, supabase }) => {
  const [cards, setCards] = useState([]);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchCards = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/tbank/sync-cards', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json();
      if (data.success) {
        setCards(data.cards.map(card => ({
          ...card,
          isExpired: new Date(`20${card.expiry_date.split('/')[1]}`, card.expiry_date.split('/')[0] - 1) < new Date(),
        })));
      } else {
        setMessage(data.error || 'Ошибка загрузки карт');
      }
    } catch (error) {
      setMessage('Ошибка загрузки карт');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCards();
  }, []);

  const handleAddCard = async () => {
    try {
      const response = await fetch('/api/tbank/add-customer', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json();
      if (data.success) {
        window.location.href = data.paymentUrl;
      } else {
        setMessage(data.error);
      }
    } catch (error) {
      setMessage('Ошибка привязки карты');
    }
  };

  const handleRemoveCard = async (cardId) => {
    try {
      const confirmed = window.confirm('Удалить эту карту? Это действие нельзя отменить.');
      if (!confirmed) return;

      const response = await fetch('/api/tbank/remove-card', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cardId }),
      });
      const data = await response.json();
      if (data.success) {
        fetchCards(); // Обновить список
        setMessage('Карта удалена');
      } else {
        setMessage(data.error);
      }
    } catch (error) {
      setMessage('Ошибка удаления карты');
    }
  };

  const handleSetPrimary = async (cardId) => {
    try {
      // Сбросить is_primary для всех карт пользователя
      await supabase
        .from('bank_cards')
        .update({ is_primary: false })
        .eq('user_id', user.id);

      // Установить для выбранной
      const { error } = await supabase
        .from('bank_cards')
        .update({ is_primary: true })
        .eq('card_id', cardId)
        .eq('user_id', user.id);
      if (error) throw error;

      fetchCards(); // Обновить список
      setMessage('Основная карта обновлена');
    } catch (error) {
      setMessage('Ошибка установки основной карты');
    }
  };

  if (loading) return <div>Загрузка карт...</div>;

  return (
    <div className={pcStyles.cardsContainer}>
      <h2>Мои карты</h2>
      <button onClick={handleAddCard} className={pcStyles.addButton}>Привязать новую карту</button>
      <div className={pcStyles.cardsGrid}>
        {cards.length > 0 ? cards.map(card => (
          <div key={card.card_id} className={pcStyles.card}>
            <div className={pcStyles.cardHeader}>
              <div className={pcStyles.cardNumber}>**** **** **** {card.last_four_digits}</div>
              <div className={pcStyles.cardExpiry}>Истекает: {card.expiry_date}</div>
            </div>
            <div className={pcStyles.cardFooter}>
              <label className={pcStyles.primaryToggle}>
                Основная
                <input
                  type="checkbox"
                  checked={card.is_primary}
                  onChange={() => handleSetPrimary(card.card_id)}
                  disabled={card.isExpired}
                />
              </label>
              <button onClick={() => handleRemoveCard(card.card_id)} disabled={card.isExpired} className={pcStyles.removeButton}>Удалить</button>
            </div>
            {card.isExpired && <div className={pcStyles.expiredBadge}>Истекла</div>}
          </div>
        )) : <p>Нет привязанных карт</p>}
      </div>
      {message && <div className={pcStyles.toast}>{message}</div>}
    </div>
  );
};

export default CardsSectionPC;