import { useState } from 'react';
import styles from '../../styles/admin-panel.module.css';

export default function AdminNewsPage() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState('');

  const sendBroadcast = async () => {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) {
      setResult('Заполните заголовок и текст рассылки.');
      return;
    }

    setSubmitting(true);
    setResult('');
    try {
      const { data: sessionData } = await (await import('../../lib/supabaseClient')).supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error('Нет активной сессии');

      const resp = await fetch('/api/admin/broadcast-alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: t, body: b }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);

      setResult(`Рассылка отправлена. Получателей: ${json?.inserted || 0}`);
      setTitle('');
      setBody('');
    } catch (e) {
      setResult(`Ошибка рассылки: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.placeholder} style={{ textAlign: 'left' }}>
      <h3>Новости / обновления системы</h3>
      <p>Отправка оповещения всем пользователям. Сообщение появится в разделе «Оповещения».</p>

      <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Заголовок"
          className={styles.searchInput}
          maxLength={140}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Текст новости / изменений"
          rows={6}
          className={styles.searchInput}
          style={{ resize: 'vertical' }}
          maxLength={2000}
        />
        <button className={styles.tabBtn} onClick={sendBroadcast} disabled={submitting}>
          {submitting ? 'Отправка…' : 'Отправить рассылку'}
        </button>
      </div>

      {result ? <p style={{ marginTop: 12 }}>{result}</p> : null}
    </div>
  );
}
