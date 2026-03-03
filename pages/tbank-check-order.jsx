// pages/tbank-check-order.jsx
import { useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function TbankCheckOrderPage({ embedded = false }) {
  const [orderId, setOrderId] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [resp, setResp] = useState(null);
  const [error, setError] = useState('');
  const [orders, setOrders] = useState([]);

  const [tripId, setTripId] = useState('');
  const [userId, setUserId] = useState('');
  const [date, setDate] = useState('');

  if (!embedded) {
    return (
      <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
        <h1 style={{ marginBottom: 8 }}>Нет прямого доступа</h1>
        <p style={{ color: '#374151' }}>Эта страница доступна только внутри админки в разделе «Т-Банк».</p>
      </div>
    );
  }

  const groupedRows = useMemo(() => {
    const groups = new Map();

    for (const tx of orders) {
      const key = `${tx.participant_id || 'unknown'}__${tx.trip_id || 'unknown'}`;
      if (!groups.has(key)) {
        groups.set(key, {
          participant_id: tx.participant_id || '—',
          trip_id: tx.trip_id || '—',
          items: [],
        });
      }
      groups.get(key).items.push(tx);
    }

    return Array.from(groups.values());
  }, [orders]);

  const loadOrders = async () => {
    if (!tripId.trim()) {
      setError('Поездка (Trip ID) обязательна для поиска');
      return;
    }

    setLoadingOrders(true);
    setError('');
    setResp(null);

    try {
      let query = supabase
        .from('payments')
        .select('id, order_id, payment_id, status, amount, payment_type, created_at, participant_id, trip_id')
        .eq('trip_id', tripId.trim())
        .not('order_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200);

      if (userId.trim()) {
        query = query.eq('participant_id', userId.trim());
      }

      if (date) {
        const fromIso = new Date(`${date}T00:00:00.000Z`).toISOString();
        const toIso = new Date(`${date}T23:59:59.999Z`).toISOString();
        query = query.gte('created_at', fromIso).lte('created_at', toIso);
      }

      const { data, error: dbError } = await query;
      if (dbError) throw dbError;

      const unique = new Map();
      (data || []).forEach((row) => {
        if (!unique.has(row.order_id)) unique.set(row.order_id, row);
      });

      setOrders(Array.from(unique.values()));
    } catch (e) {
      setError(`Не удалось загрузить заказы: ${e?.message || 'unknown error'}`);
    } finally {
      setLoadingOrders(false);
    }
  };

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
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 16px', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1 style={{ marginBottom: 8 }}>T-Банк: CheckOrder (оплатный)</h1>

      <div style={{ marginTop: 12, padding: 16, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Фильтры поиска в Supabase</h3>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr 1fr auto' }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Trip ID <span style={{ color: 'crimson' }}>*</span></span>
            <input value={tripId} onChange={(e) => setTripId(e.target.value)} placeholder="UUID поездки" style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10 }} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>User ID (необязательно)</span>
            <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="UUID пользователя" style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10 }} />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Дата (необязательно)</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10 }} />
          </label>
          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button type="button" onClick={loadOrders} disabled={loadingOrders} style={{ padding: '10px 14px', background: '#111827', color: '#fff', border: 'none', borderRadius: 10, cursor: loadingOrders ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              {loadingOrders ? 'Загрузка...' : 'Найти'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #e5e7eb' }}>User ID</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #e5e7eb' }}>Trip ID</th>
              <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #e5e7eb' }}>Заказы</th>
            </tr>
          </thead>
          <tbody>
            {!groupedRows.length && (
              <tr>
                <td colSpan={3} style={{ padding: 12, color: '#6b7280' }}>Нажмите «Найти», чтобы загрузить данные.</td>
              </tr>
            )}
            {groupedRows.map((group) => (
              <tr key={`${group.participant_id}-${group.trip_id}`}>
                <td style={{ verticalAlign: 'top', padding: 10, borderBottom: '1px solid #f3f4f6' }}>{group.participant_id}</td>
                <td style={{ verticalAlign: 'top', padding: 10, borderBottom: '1px solid #f3f4f6' }}>{group.trip_id}</td>
                <td style={{ padding: 10, borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {group.items.map((tx) => (
                      <div key={tx.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 13 }}>
                          <b>OrderId:</b> {tx.order_id} · <b>PaymentId:</b> {tx.payment_id} · <b>Status:</b> {tx.status} · <b>Amount:</b> {tx.amount} · <b>Date:</b> {new Date(tx.created_at).toLocaleString()}
                        </div>
                        <button type="button" onClick={() => setOrderId(tx.order_id || '')} style={{ padding: '7px 10px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
                          Выбрать
                        </button>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={onSubmit} style={{ marginTop: 16, padding: 16, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '2fr auto auto' }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>OrderId <span style={{ color: 'crimson' }}>*</span></span>
            <input value={orderId} onChange={(e) => setOrderId(e.target.value)} placeholder="Например: 21057" required style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 10, fontSize: 14 }} />
          </label>

          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button type="submit" disabled={loading || !orderId.trim()} style={{ padding: '10px 14px', background: loading ? '#6b7280' : '#2563eb', color: '#fff', border: 'none', borderRadius: 10, cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
              {loading ? 'Запрос...' : 'Запросить'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'end' }}>
            <button type="button" onClick={() => { setResp(null); setError(''); setOrderId(''); }} style={{ padding: '10px 14px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontWeight: 600 }}>
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
    </div>
  );
}
