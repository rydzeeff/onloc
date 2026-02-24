// pages/api/tbank/get-state.js
import crypto from "crypto";

const genReqId = () =>
  `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

const mask = (s, keepStart = 4, keepEnd = 4) => {
  if (!s && s !== 0) return s;
  const str = String(s);
  if (str.length <= keepStart + keepEnd)
    return "*".repeat(Math.max(1, str.length - 1));
  return `${str.slice(0, keepStart)}…${str.slice(-keepEnd)}`;
};
const maskKey = (k) => (k ? mask(k, 4, 4) : k);

const log = (id, ...a) => console.log(`[tbank-getstate][${id}]`, ...a);
const logErr = (id, ...a) => console.error(`[tbank-getstate][${id}]`, ...a);

// === Token (SHA-256 hex по отсортированным значениям) ===
const generateToken = (params, reqId) => {
  const pwd = process.env.TBANK_SECRET || "";
  const base = { ...params, Password: pwd };

  const excluded = ["Token", "DigestValue", "SignatureValue", "X509SerialNumber"];

  const pairs = Object.keys(base)
    .filter((k) => !excluded.includes(k))
    .sort()
    .map((k) => [k, base[k]]);

  const concat = pairs.map(([, v]) => String(v)).join("");
  const token = crypto.createHash("sha256").update(concat).digest("hex");

  const alphabeticalKeys = pairs.map(([k]) => k);
  const valuesForPrint = pairs.map(([k, v]) =>
    k === "Password" ? "***PWD***" : String(v)
  );

  log(reqId, "=== TOKEN DEBUG ===");
  log(reqId, "ALPHABETICAL_KEYS:", alphabeticalKeys);
  log(reqId, "VALUES_BY_KEY (Password masked):", valuesForPrint);
  log(reqId, "CONCAT_STRING (values joined):", concat.replace(pwd, "***PWD***"));
  log(reqId, `SHA256_HEX (length=${token.length}):`, token);

  return {
    token,
    debug: {
      alphabeticalKeys,
      valuesPreview: valuesForPrint,
      concatPreview: concat.replace(pwd, "***PWD***"),
      algo: "sha256(hex)",
    },
  };
};

const headersToObject = (headers) => {
  const out = {};
  if (!headers) return out;
  try {
    headers.forEach((v, k) => {
      out[k] = v;
    });
  } catch {
    for (const [k, v] of Object.entries(headers || {})) out[k] = v;
  }
  return out;
};

const ensureE2CTerminal = (key) => {
  const base = String(key || "");
  return base.endsWith("E2C") ? base : `${base}E2C`;
};

export default async function handler(req, res) {
  const reqId = genReqId();

  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ error: "Метод не разрешён. Используйте POST." });
  }

  try {
    const { paymentId, ip } = req.body || {};
    log(reqId, "Incoming body:", { paymentId, ip });

    if (!paymentId) {
      return res.status(400).json({ error: "Не указан PaymentId" });
    }

    // ⚠️ Выплатный терминал: тот же ключ + суффикс E2C
    const terminalKeyRaw = process.env.TBANK_TERMINAL_KEY || "";
    const terminalKey = ensureE2CTerminal(terminalKeyRaw);
    if (!terminalKeyRaw) {
      return res.status(500).json({
        error: "Отсутствует TBANK_TERMINAL_KEY в переменных окружения",
      });
    }

    // Параметры запроса
    const baseParams = {
      TerminalKey: terminalKey,
      PaymentId: String(paymentId),
      ...(ip ? { IP: String(ip) } : {}),
    };

    // Token
    const { token, debug } = generateToken(baseParams, reqId);
    const params = { ...baseParams, Token: token };

    const payloadMaskedButFullToken = {
      ...params,
      TerminalKey: maskKey(params.TerminalKey),
      Token: params.Token, // намеренно без маски, как и раньше, для отладки
    };

    // ✅ URL выплат (E2C v2): тест/боевой по мануалу
    // Тест:  https://rest-api-test.tinkoff.ru/e2c/v2/GetState
    // Боевой: https://securepay.tinkoff.ru/e2c/v2/GetState
    const url = "https://rest-api-test.tinkoff.ru/e2c/v2/GetState";

    // === ЛОГИ ЗАПРОСА ===
    log(reqId, "=== OUTGOING REQUEST ===");
    log(reqId, "URL (final):", url);
    log(reqId, "Headers:", {
      "Content-Type": "application/json",
      "X-Request-Id": reqId,
    });
    log(
      reqId,
      "Payload (TerminalKey masked, Token FULL):",
      payloadMaskedButFullToken
    );

    // Отправка
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": reqId,
      },
      body: JSON.stringify(params),
    });

    const responseHeaders = headersToObject(resp.headers);
    const rawText = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { raw: rawText };
    }

    // === ЛОГИ ОТВЕТА ===
    log(reqId, "=== INCOMING RESPONSE ===");
    log(reqId, "Status:", resp.status);
    log(reqId, "Headers:", responseHeaders);
    log(reqId, "Body (raw):", rawText);
    log(reqId, "Body (parsed):", parsed);
    log(reqId, "TBank E2C v2 GETSTATE response:", {
      status: resp.status,
      body: parsed,
    });

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: parsed?.Message || parsed?.Details || "Ошибка GetState",
        response: parsed,
        request: { url, payload: payloadMaskedButFullToken },
        debug,
        reqId,
      });
    }

    return res.status(200).json({
      success: true,
      request: {
        url,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": reqId,
        },
        payload: payloadMaskedButFullToken,
      },
      response: parsed,
      debug,
      reqId,
    });
  } catch (e) {
    logErr(reqId, "Critical GetState error:", e);
    return res.status(500).json({ error: e?.message || "Internal error", reqId });
  }
}
