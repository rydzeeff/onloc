// pages/api/tbank/remove-customer.js
import crypto from "crypto";
import { getTbankConfig } from "./_config";

/**
 * ENV, которые используются:
 * - TBANK_TERMINAL_KEY  — базовый TerminalKey (без/с E2C, не важно: мы приведем к нужному виду)
 * - TBANK_SECRET        — пароль терминала (используется для Token)
 * - TBANK_BASE          — (опц.) базовый URL API; по умолчанию тестовый https://rest-api-test.tinkoff.ru
 *
 * Протоколы:
 * - protocol: "eacq" -> /v2/RemoveCustomer (Интернет-эквайринг, оплатный терминал), TerminalKey БЕЗ суффикса E2C
 * - protocol: "a2c"  -> /e2c/v2/RemoveCustomer (Выплаты, выплатный терминал), TerminalKey С суффиксом E2C
 */

const tbankConfig = getTbankConfig();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  const { protocol, customerKey } = req.body || {};
  if (!protocol || !["eacq", "a2c"].includes(protocol)) {
    return res.status(400).json({ error: "protocol must be 'eacq' or 'a2c'" });
  }
  if (!customerKey || typeof customerKey !== "string") {
    return res.status(400).json({ error: "customerKey is required" });
  }

  const TBANK_BASE = tbankConfig.restBase;
  const BASE_TK = tbankConfig.terminalKeyBase || "";
  const SECRET = tbankConfig.terminalSecret || "";

  if (!BASE_TK) {
    return res.status(500).json({ error: "TBANK_TERMINAL_KEY is not set" });
  }
  if (!SECRET) {
    return res.status(500).json({ error: "TBANK_SECRET is not set" });
  }

  // Нормализуем ключи под нужный протокол
  const stripE2C = (tk) => tk.replace(/E2C$/i, "");
  const ensureE2C = (tk) => (tk.endsWith("E2C") ? tk : tk + "E2C");

  const isEacq = protocol === "eacq";
  const TerminalKey = isEacq ? stripE2C(BASE_TK) : ensureE2C(stripE2C(BASE_TK));
  const url = isEacq ? `${TBANK_BASE}/v2/RemoveCustomer` : `${TBANK_BASE}/e2c/v2/RemoveCustomer`;

  try {
    // Формирование Token по правилам Т-Банка:
    // берём параметры (без Token), добавляем Password=TBANK_SECRET,
    // сортируем ключи по алфавиту и конкатенируем значения, sha256 -> hex
    const params = { CustomerKey: customerKey, TerminalKey };
    const withPwd = { ...params, Password: SECRET };
    const orderedKeys = Object.keys(withPwd).filter((k) => k !== "Token").sort();
    const concatenated = orderedKeys.map((k) => String(withPwd[k])).join("");
    const Token = crypto.createHash("sha256").update(concatenated).digest("hex");

    const body = { TerminalKey, CustomerKey: customerKey, Token };

    console.log(`[TBANK][remove-customer] ${protocol} POST ${url}`, {
      TerminalKey,
      CustomerKeyPreview: mask(customerKey),
      tokenPreview: Token.slice(0, 8) + "..." + Token.slice(-8),
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });

    const ct = resp.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await resp.json() : await resp.text();

    if (!resp.ok) {
      return res.status(resp.status).json(
        typeof data === "object"
          ? data
          : { Success: false, ErrorCode: String(resp.status), Message: "HTTP error", Details: data }
      );
    }

    // Банк вернул JSON с Success/ErrorCode
    return res.status(data?.Success ? 200 : 400).json(data);
  } catch (err) {
    console.error("[TBANK][remove-customer] error:", err);
    return res
      .status(500)
      .json({ Success: false, ErrorCode: "500", Message: "Internal error", Details: String(err?.message || err) });
  }
}

function mask(v) {
  if (!v) return v;
  if (v.length <= 6) return "***";
  return v.slice(0, 3) + "..." + v.slice(-3);
}
