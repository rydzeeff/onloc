import { useState } from 'react';
import TbankGetStatePage from '../tbank-get-state';
import TbankCheckOrderPage from '../tbank-check-order';
import styles from '../../styles/admin-panel.module.css';

const TOOLS = [
  { id: 'getstate', label: 'GetState' },
  { id: 'checkorder', label: 'CheckOrder' },
];

export default function AdminTbankToolsPage() {
  const [activeTool, setActiveTool] = useState('getstate');

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

      {activeTool === 'getstate' && <TbankGetStatePage />}
      {activeTool === 'checkorder' && <TbankCheckOrderPage />}
    </div>
  );
}
