import { useState } from "react";

export default function TbankRemoveCustomer() {
  const [useEacq, setUseEacq] = useState(false);
  const [useA2c, setUseA2c] = useState(false);
  const [eacqKey, setEacqKey] = useState("");
  const [a2cKey, setA2cKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);

  const addLog = (line) =>
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setLogs([]);
    if (!useEacq && !useA2c) {
      addLog("Ничего не отмечено — удалять нечего.");
      return;
    }
    if (useEacq && !eacqKey.trim()) {
      addLog("Для EACQ включена галка, но CustomerKey пуст.");
      return;
    }
    if (useA2c && !a2cKey.trim()) {
      addLog("Для A2C включена галка, но CustomerKey пуст.");
      return;
    }

    setLoading(true);
    try {
      const tasks = [];
      if (useEacq) {
        tasks.push(
          fetch("/api/tbank/remove-customer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ protocol: "eacq", customerKey: eacqKey.trim() }),
          }).then(async (r) => ({ tag: "EACQ", resp: await r.json(), ok: r.ok }))
        );
      }
      if (useA2c) {
        tasks.push(
          fetch("/api/tbank/remove-customer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ protocol: "a2c", customerKey: a2cKey.trim() }),
          }).then(async (r) => ({ tag: "A2C", resp: await r.json(), ok: r.ok }))
        );
      }

      const results = await Promise.all(tasks);
      results.forEach(({ tag, resp, ok }) => {
        if (ok && resp?.Success) {
          addLog(`${tag}: удалено успешно (CustomerKey=${resp.CustomerKey || "—"})`);
        } else {
          addLog(
            `${tag}: ошибка удаления` +
              (resp?.ErrorCode ? ` (ErrorCode=${resp.ErrorCode})` : "") +
              (resp?.Message ? ` — ${resp.Message}` : "") +
              (resp?.Details ? ` [${resp.Details}]` : "")
          );
        }
      });
    } catch (err) {
      addLog(`Сбой выполнения: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Удаление CustomerKey (EACQ & A2C)</h1>
      <form onSubmit={onSubmit} className="space-y-6">
        {/* Оплатный терминал (EACQ) */}
        <div className="border rounded-lg p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={useEacq}
              onChange={(e) => setUseEacq(e.target.checked)}
            />
            <div className="flex-1">
              <div className="font-medium">
                Оплатный терминал (EACQ) — RemoveCustomer
              </div>
              <div className="text-sm text-gray-500 mb-2">
                Удалит покупателя (CustomerKey) из интернет-эквайринга.
              </div>
              <input
                type="text"
                placeholder="CustomerKey для EACQ"
                value={eacqKey}
                disabled={!useEacq || loading}
                onChange={(e) => setEacqKey(e.target.value)}
                className="w-full border rounded px-3 py-2 disabled:bg-gray-100"
              />
            </div>
          </label>
        </div>

        {/* Выплатный терминал (A2C) */}
        <div className="border rounded-lg p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={useA2c}
              onChange={(e) => setUseA2c(e.target.checked)}
            />
            <div className="flex-1">
              <div className="font-medium">
                Выплатный терминал (A2C) — RemoveCustomer
              </div>
              <div className="text-sm text-gray-500 mb-2">
                Удалит покупателя (CustomerKey) из выплатного терминала.
              </div>
              <input
                type="text"
                placeholder="CustomerKey для A2C"
                value={a2cKey}
                disabled={!useA2c || loading}
                onChange={(e) => setA2cKey(e.target.value)}
                className="w-full border rounded px-3 py-2 disabled:bg-gray-100"
              />
            </div>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || (!useEacq && !useA2c)}
            className="px-4 py-2 rounded bg-black text-white disabled:opacity-50"
          >
            {loading ? "Удаляю..." : "Удалить выбранные"}
          </button>
        </div>
      </form>

      <div className="mt-6">
        <div className="text-sm font-medium mb-1">Логи</div>
        <pre className="text-sm bg-gray-50 border rounded p-3 whitespace-pre-wrap min-h-[120px]">
          {logs.join("\n")}
        </pre>
      </div>
    </div>
  );
}
