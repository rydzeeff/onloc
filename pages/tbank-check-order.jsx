// pages/tbank-check-order.jsx
import { useState } from 'react';

export default function TbankCheckOrderPage() {
  const [orderId, setOrderId] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState(null);
  const [error, setError] = useState('');

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResp(null);
    setError('');

    try {
      const r = await fetch('/api/tbank/check-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderId.trim() }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error || 'Ошибка запроса');
      } else {
        setResp(data);
      }
    } catch (e) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const BankStatusBadge = ({ status }) => {
    if (!status) return null;
    const good = status === 'AUTHORIZED' || status === 'CONFIRMED';
    const neg = ['REJECTED', 'CANCELED', 'DEADLINE_EXPIRED', 'REVERSED', 'REFUNDED', 'PARTIAL_REFUNDED'].includes(status);
    const bg = good ? '#dcfce7' : neg ? '#fee2e2' : '#e5e7eb';
    const color = good ? '#166534' : neg ? '#991b1b' : '#374151';
    return (
      <span style={{ padding: '2px 8px', borderRadius: 999, background: bg, color, fontWeight: 600 }}>
        {status}
      </span>
    );
  };

  return (
    <div style={{ maxWidth: 920, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>T-Банк: CheckOrder (v2)</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Диагностическая страница статуса заказа по <code>OrderId</code> (EACQ <b>v2</b>, без E2C). Ответы адаптированы под новый API.
      </p>

      <form onSubmit={onSubmit} style={{ marginTop: 20, padding: 16, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>OrderId <span style={{ color: 'crimson' }}>*</span></span>
            <input
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="Например: 21057"
              required
              style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10, fontSize: 14 }}
            />
          </label>

          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button
              type="submit"
              disabled={loading || !orderId.trim()}
              style={{
                padding: '10px 14px',
                background: loading ? '#6b7280' : '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontWeight: 600
              }}
            >
              {loading ? 'Запрос...' : 'Проверить статус'}
            </button>
            <button
              type="button"
              onClick={() => { setResp(null); setError(''); setOrderId(''); }}
              style={{ padding: '10px 14px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}
            >
              Сбросить
            </button>
          </div>
        </div>
      </form>

      {error && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #fecaca', background: '#fee2e2', color: '#991b1b', borderRadius: 10 }}>
          <b>Ошибка:</b> {String(error)}
        </div>
      )}

      {resp && (
        <div style={{ marginTop: 16, padding: 16, border: '1px solid #e5e7eb', background: '#fafafa', borderRadius: 12 }}>
          <h3 style={{ marginTop: 0 }}>Ответ</h3>

          {/* Короткий итог сверху */}
          <div style={{ display: 'grid', gap: 8, marginBottom: 12, background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Статус банка</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <BankStatusBadge status={resp?.bank?.status || resp?.response?.Status} />
                {resp?.ui?.reason && <span style={{ fontSize: 12, color: '#6b7280' }}>reason: {resp.ui.reason}</span>}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Подсказка UI</div>
              <div style={{ fontSize: 14 }}>
                {resp?.ui?.tooltip || '—'}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                block: <b>{String(!!resp?.ui?.block)}</b> · allowRetry: <b>{String(!!resp?.ui?.allowRetry)}</b>
                {resp?.ui?.lockedUntil ? <> · lockedUntil: <code>{resp.ui.lockedUntil}</code></> : null}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Локальная запись в БД (payments)</div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f9fafb', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb', margin: 0 }}>
{JSON.stringify(resp?.local ?? null, null, 2)}
              </pre>
            </div>
          </div>

          <section style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0' }}>Запрос (маскировано):</h4>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
{JSON.stringify(resp.request, null, 2)}
            </pre>
          </section>

          <section style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0' }}>Ответ банка:</h4>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
{JSON.stringify(resp.bank?.raw ?? resp.response ?? null, null, 2)}
            </pre>
          </section>

          <section>
            <h4 style={{ margin: '8px 0' }}>Отладка подписи (Password включён):</h4>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
{JSON.stringify(resp.debug, null, 2)}
            </pre>
          </section>
        </div>
      )}

      <footer style={{ marginTop: 28, fontSize: 12, color: '#6b7280' }}>
        Терминал и пароль берутся из переменных окружения: <code>TBANK_TERMINAL_KEY</code> и <code>TBANK_SECRET</code>. Для тестовой среды используйте WL у банка.
      </footer>
    </div>
  );
}
