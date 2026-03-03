// pages/tbank-get-state.jsx
import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function TbankGetStatePage({ embedded = false }) {
  const [paymentId, setPaymentId] = useState('');
  const [clientIp, setClientIp] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [resp, setResp] = useState(null);
  const [error, setError] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState('');
  const [isE2C, setIsE2C] = useState(false);

  if (!embedded) {
    return (
      <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
        <h1 style={{ marginBottom: 8 }}>Нет прямого доступа</h1>
        <p style={{ color: '#374151' }}>Эта страница доступна только внутри админки в разделе «Т-Банк».</p>
      </div>
    );
  }

  const loadTransactions = async () => {
    setLoadingTransactions(true);
    setError('');
    try {
      const { data, error: dbError } = await supabase
        .from('payments')
        .select('id, payment_id, order_id, amount, status, payment_type, created_at')
        .not('payment_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100);

      if (dbError) throw dbError;
      setTransactions(data || []);
    } catch (e) {
      setError(`Не удалось загрузить транзакции: ${e?.message || 'unknown error'}`);
    } finally {
      setLoadingTransactions(false);
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResp(null);
    setError('');

    try {
      const r = await fetch(isE2C ? '/api/tbank/get-statev' : '/api/tbank/get-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId: paymentId.trim(),
          ip: clientIp.trim() || undefined,
        }),
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

  return (
    <div style={{ maxWidth: 920, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>T-Банк: GetState (v2)</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Диагностическая страница для запроса статуса операции по <code>PaymentId</code> (EACQ <b>v2</b>, без E2C).
      </p>

      <form onSubmit={onSubmit} style={{
        marginTop: 20,
        padding: 16,
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        background: '#fff'
      }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>PaymentId <span style={{ color: 'crimson' }}>*</span></span>
            <input
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
              placeholder="Например: 700000085101"
              required
              style={{
                padding: '10px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 10,
                fontSize: 14
              }}
            />
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={isE2C}
              onChange={(e) => setIsE2C(e.target.checked)}
            />
            <span>Выплатный терминал E2C (A2C)</span>
          </label>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={loadTransactions}
                disabled={loadingTransactions}
                style={{
                  padding: '8px 12px',
                  background: '#111827',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  cursor: loadingTransactions ? 'not-allowed' : 'pointer'
                }}
              >
                {loadingTransactions ? 'Загрузка...' : 'Подгрузить транзакции из Supabase'}
              </button>
              <span style={{ color: '#6b7280', fontSize: 13 }}>Или введите PaymentId вручную</span>
            </div>

            <select
              value={selectedPaymentId}
              onChange={(e) => {
                const nextId = e.target.value;
                setSelectedPaymentId(nextId);
                setPaymentId(nextId);
              }}
              style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10, fontSize: 14 }}
            >
              <option value="">Выберите транзакцию</option>
              {transactions.map((tx) => (
                <option key={tx.id} value={tx.payment_id}>
                  {tx.payment_id} · order:{tx.order_id} · {tx.status} · {tx.amount} · {new Date(tx.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </div>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>IP (необязательно)</span>
            <input
              value={clientIp}
              onChange={(e) => setClientIp(e.target.value)}
              placeholder="Например: 1.2.3.4"
              style={{
                padding: '10px 12px',
                border: '1px solid #d1d5db',
                borderRadius: 10,
                fontSize: 14
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button
              type="submit"
              disabled={loading || !paymentId.trim()}
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
              {loading ? 'Запрос...' : 'Запросить'}
            </button>
            <button
              type="button"
              onClick={() => { setResp(null); setError(''); setPaymentId(''); setClientIp(''); }}
              style={{
                padding: '10px 14px',
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              Сбросить
            </button>
          </div>
        </div>
      </form>

      {error && (
        <div style={{
          marginTop: 16,
          padding: 12,
          border: '1px solid #fecaca',
          background: '#fee2e2',
          color: '#991b1b',
          borderRadius: 10
        }}>
          <b>Ошибка:</b> {String(error)}
        </div>
      )}

      {resp && (
        <div style={{
          marginTop: 16,
          padding: 16,
          border: '1px solid #e5e7eb',
          background: '#fafafa',
          borderRadius: 12
        }}>
          <h3 style={{ marginTop: 0 }}>Ответ</h3>

          <section style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0' }}>Запрос (маскировано):</h4>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
{JSON.stringify(resp.request, null, 2)}
            </pre>
          </section>

          <section style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '8px 0' }}>Ответ банка:</h4>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}>
{JSON.stringify(resp.response, null, 2)}
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
