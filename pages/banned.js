import { useAuth } from './_app';

export default function BannedPage() {
  const { banInfo } = useAuth();

  return (
    <div style={{ minHeight: '70vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div style={{ maxWidth: 680, width: '100%', background: '#fff', border: '1px solid #fecaca', borderRadius: 12, padding: 20 }}>
        <h1 style={{ marginTop: 0, color: '#b91c1c' }}>Вы были заблокированы</h1>
        <p>Ваш аккаунт временно ограничен и не может использовать разделы сайта.</p>
        <p><b>Причина:</b> {banInfo?.reason || 'Нарушение правил платформы'}</p>
        <p>Если вы считаете блокировку ошибочной, напишите на <a href="mailto:ban@onloc.ru">ban@onloc.ru</a>.</p>
      </div>
    </div>
  );
}
