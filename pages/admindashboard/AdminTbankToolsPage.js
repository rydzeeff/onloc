import { useState } from 'react';
import TbankGetStatePage from '../tbank-get-state';
import TbankCheckOrderPage from '../tbank-check-order';
import styles from '../../styles/admin-panel.module.css';

const TOOLS = [
  { id: 'getstate_payment', label: 'GetState (оплатный)' },
  { id: 'getstate_payout', label: 'GetState (выплатный E2C)' },
  { id: 'checkorder_payment', label: 'CheckOrder (оплатный)' },
];

export default function AdminTbankToolsPage() {
  const [activeTool, setActiveTool] = useState('getstate_payment');

  return (
    <div>
      <div className={styles.tabs} style={{ marginBottom: 16 }}>
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            className={`${styles.tabBtn} ${activeTool === tool.id ? styles.active : ''}`}
            onClick={() => setActiveTool(tool.id)}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {activeTool === 'getstate_payment' && <TbankGetStatePage embedded mode="payment" />}
      {activeTool === 'getstate_payout' && <TbankGetStatePage embedded mode="payout" />}
      {activeTool === 'checkorder_payment' && <TbankCheckOrderPage embedded />}
    </div>
  );
}
