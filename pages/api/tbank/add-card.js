// pages/api/tbank/add-card.js
import { createClient } from "@supabase/supabase-js";
import crypto, { randomUUID } from "crypto";
import { getTbankConfig } from "./_config";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const tbankConfig = getTbankConfig();
const TBANK_BASE = tbankConfig.restBase;
const DEBUG_VERBOSE = process.env.TBANK_DEBUG_VERBOSE === "1";

// [E2C] аккуратный хелпер: добавляем E2C один раз
const ensureE2C = (tk) => (!tk ? tk : tk.endsWith("E2C") ? tk : `${tk}E2C`);

// База хоста формы (fallback, если банк вернул GUID вместо полного URL)
const FORM_BASE = tbankConfig.formBase;

const HIDDEN = "[hidden]";
const maskMid = (s, L = 10, R = 10) =>
  typeof s === "string" && s.length > L + R ? `${s.slice(0, L)}...${s.slice(-R)}` : s || "";

const maybeHide = (k, v) => {
  const low = (k || "").toLowerCase();
  if (!DEBUG_VERBOSE && (low.includes("token") || low.includes("secret") || low.includes("password"))) return HIDDEN;
  return v;
};

const sanitize = (obj) => {
  try {
    const c = JSON.parse(JSON.stringify(obj ?? {}));
    const w = (o) => {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if (["Authorization", "Password", "Token", "TBANK_SECRET", "SUPABASE_JWT_SECRET"].includes(k)) {
          o[k] = maybeHide(k, o[k]);
        } else if (typeof o[k] === "string" && o[k].length > 140) {
          o[k] = DEBUG_VERBOSE ? o[k] : maskMid(o[k], 16, 16);
        } else if (typeof o[k] === "object") {
          w(o[k]);
        }
      }
    };
    w(c);
    return c;
  } catch {
    return {};
  }
};

const logI = (cid, msg, extra = {}) => console.log(`[TBANK][add-card][${cid}] ${msg}`, sanitize(extra));
const logE = (cid, msg, extra = {}) => console.error(`[TBANK][add-card][${cid}] ${msg}`, sanitize(extra));

// Token по мануалу: SHA256 от конкатенации значений (ключи отсортированы) + Password
const tokenMaterials = (params) => {
  const withPwd = { ...params, Password: tbankConfig.terminalSecret ?? "" };
  const orderedKeys = Object.keys(withPwd)
    .filter((k) => !["Token", "DigestValue", "SignatureValue", "X509SerialNumber"].includes(k))
    .sort();

  const parts = orderedKeys.map((k) => ({
    key: k,
    value: String(withPwd[k]),
    len: String(withPwd[k]).length,
  }));

  const concatenated = parts.map((p) => p.value).join("");
  const token = crypto.createHash("sha256").update(concatenated).digest("hex");
  return { token, orderedKeys, parts, concatenated };
};

const withToken = (label, cid, params) => {
  const m = tokenMaterials(params);
  logI(cid, `${label}: token computed`, {
    orderedKeys: m.orderedKeys,
    partsSummary: m.parts.map((p) => ({
      key: p.key,
      len: p.len,
      preview: DEBUG_VERBOSE ? p.value : maskMid(p.value, 8, 8),
    })),
    concatenatedLen: m.concatenated.length,
    concatenatedPreview: DEBUG_VERBOSE ? m.concatenated : maskMid(m.concatenated, 16, 16),
    tokenPreview: DEBUG_VERBOSE ? m.token : maskMid(m.token, 8, 8),
  });
  return { ...params, Token: m.token };
};

const postJson = async (cid, path, body, label) => {
  const url = `${TBANK_BASE}${path}`;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  logI(cid, `${label}: POST`, { url, headers, body });

  const t0 = Date.now();
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }).catch((e) => {
    logE(cid, `${label}: fetch error`, { error: String(e) });
    throw e;
  });
  const ms = Date.now() - t0;

  const respHeaders = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  const contentType = resp.headers.get("content-type") || "";
  let json = null;
  try {
    if (contentType.includes("application/json")) json = await resp.json();
  } catch {}

  logI(cid, `${label}: response`, {
    httpStatus: resp.status,
    statusText: resp.statusText,
    ms,
    headers: respHeaders,
    jsonSummary: json
      ? { Success: json.Success, ErrorCode: json.ErrorCode, Message: json.Message, Details: json.Details }
      : undefined,
  });

  return { resp, json, ms };
};

export default async function handler(req, res) {
  const cid = randomUUID();
  logI(cid, "request start", { method: req.method, TBANK_BASE, FORM_BASE });

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!tbankConfig.terminalKeyBase) return res.status(500).json({ error: "Server misconfigured (TBANK_TERMINAL_KEY)" });
    if (!tbankConfig.terminalSecret) return res.status(500).json({ error: "Server misconfigured (TBANK_SECRET)" });

    const auth = req.headers.authorization?.split(" ")[1];
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(auth);
    if (userErr || !userRes?.user?.id) {
      logE(cid, "supabase auth failed", { error: userErr?.message });
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = userRes.user.id;

    // [E2C] используем выплатный терминал
    const TerminalKey = tbankConfig.terminalKeyA2c || ensureE2C(tbankConfig.terminalKeyBase);
    if (!TerminalKey) return res.status(500).json({ error: "Server misconfigured (TerminalKey)" });

    // 1) проверяем/создаём покупателя (idempotent)
    {
      const gCustomerBody = withToken("GetCustomer", cid, { TerminalKey, CustomerKey: userId });
      const gc = await postJson(cid, "/e2c/v2/GetCustomer", gCustomerBody, "GetCustomer");

      // ВАЖНО: проверяем не только resp.ok, но и json.Success
      const gcOk = gc?.resp?.ok && gc?.json?.Success === true;

      if (!gcOk) {
        const addCustomerBody = withToken("AddCustomer", cid, { TerminalKey, CustomerKey: userId });
        const ac = await postJson(cid, "/e2c/v2/AddCustomer", addCustomerBody, "AddCustomer(fallback)");

        if (!ac?.resp?.ok || ac?.json?.Success !== true) {
          return res.status(400).json({
            error: ac?.json?.Message || "AddCustomer failed",
            errorCode: ac?.json?.ErrorCode,
            details: ac?.json?.Details,
            raw: ac?.json,
          });
        }
      }
    }

    // 2) инициализируем привязку карты
    // ВАЖНО: CheckType должен быть НЕ пустой и НЕ пробелы
    const CheckType = (process.env.TBANK_ADD_CARD_CHECK_TYPE ?? "").trim() || "3DSHOLD"; // NO/HOLD/3DS/3DSHOLD
    const PayForm = (process.env.TBANK_ADD_CARD_PAYFORM ?? "").trim() || undefined;

    // ВАЖНО: кладём CheckType ВСЕГДА, чтобы он 100% попал в payload и Token
    const addParams = {
      TerminalKey,
      CustomerKey: userId,
      CheckType,
      ...(PayForm ? { PayForm } : {}),
    };

    // Диагностический лог: чтобы вы прямо видели в проде, что уходит
    logI(cid, "AddCard: addParams check", { addParams });

    const addBody = withToken("AddCard", cid, addParams);

    const { resp, json } = await postJson(cid, "/e2c/v2/AddCard", addBody, "AddCard");

    if (!resp.ok || json?.Success !== true) {
      return res.status(400).json({
        error: json?.Message || "AddCard failed",
        errorCode: json?.ErrorCode,
        details: json?.Details,
        raw: json,
      });
    }

    // 3) собираем корректный URL формы
    const paymentUrl = (() => {
      const p = json?.PaymentURL || json?.PaymentUrl;
      if (p) {
        if (typeof p === "string" && /^https?:\/\//i.test(p)) return p;
        return `${FORM_BASE}/addcard/${p}`;
      }

      // некоторые ответы возвращают RequestKey отдельно
      const id = json?.RequestKey || json?.PaymentId;
      return id ? `${FORM_BASE}/addcard/${id}` : null;
    })();

    if (!paymentUrl) {
      logE(cid, "AddCard: missing PaymentURL/PaymentId/RequestKey in response", { json });
      return res.status(400).json({ error: "AddCard succeeded but no URL to redirect", raw: json });
    }

    return res.status(200).json({
      success: true,
      paymentUrl,
      checkType: CheckType,
      payForm: PayForm || null,
      raw: json,
    });
  } catch (e) {
    logE(cid, "unhandled error", { error: String(e) });
    return res.status(500).json({ error: "Internal error" });
  }
}
