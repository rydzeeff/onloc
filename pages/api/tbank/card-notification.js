// pages/api/tbank/card-notification.js
import { createClient } from "@supabase/supabase-js";
import crypto, { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const DEBUG_VERBOSE = process.env.TBANK_DEBUG_VERBOSE === "1";

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

const logI = (cid, msg, extra = {}) => console.log(`[TBANK][card-notification][${cid}] ${msg}`, sanitize(extra));
const logE = (cid, msg, extra = {}) => console.error(`[TBANK][card-notification][${cid}] ${msg}`, sanitize(extra));

// Token по мануалу: SHA256 от конкатенации значений (ключи отсортированы) + Password
const generateToken = (params) => {
  const withPwd = { ...params, Password: process.env.TBANK_SECRET ?? "" };

  const orderedKeys = Object.keys(withPwd)
    .filter((k) => !["Token", "DigestValue", "SignatureValue", "X509SerialNumber"].includes(k))
    .sort();

  const concatenated = orderedKeys.map((k) => String(withPwd[k])).join("");
  return crypto.createHash("sha256").update(concatenated).digest("hex");
};

export default async function handler(req, res) {
  const cid = randomUUID();

  // Банк шлёт POST
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = req.body || {};
    logI(cid, "incoming", { body });

    const receivedToken = body.Token;
    if (!receivedToken) {
      logE(cid, "missing Token");
      return res.status(400).send("ERROR");
    }

    // проверка подписи
    const params = { ...body };
    delete params.Token;

    const expectedToken = generateToken(params);
    if (String(receivedToken) !== String(expectedToken)) {
      logE(cid, "invalid Token", {
        receivedToken: DEBUG_VERBOSE ? receivedToken : maskMid(String(receivedToken), 8, 8),
        expectedToken: DEBUG_VERBOSE ? expectedToken : maskMid(String(expectedToken), 8, 8),
      });
      return res.status(401).send("ERROR");
    }

    const {
      CustomerKey,
      Success,
      Status,
      CardId,
      Pan,
      ExpDate,
      RebillId,
      ErrorCode,
      Message,
      NotificationType,
    } = body;

    // сохраняем только успешную привязку
    if (Success === true && Status === "COMPLETED") {
      if (!CustomerKey || !CardId) {
        logE(cid, "missing CustomerKey/CardId in success notification", { CustomerKey, CardId });
        return res.status(400).send("ERROR");
      }

      // last 4 digits из маскированного Pan (например 532130******1359)
      const last4 = typeof Pan === "string" ? Pan.slice(-4) : null;

      // is_primary: если ещё нет primary для payout — сделаем эту primary
      let makePrimary = false;
      try {
        const { data: prim } = await supabase
          .from("user_cards")
          .select("id")
          .eq("user_id", CustomerKey)
          .eq("card_scope", "payout")
          .eq("is_primary", true)
          .limit(1);
        makePrimary = !(prim && prim.length > 0);
      } catch {
        makePrimary = false;
      }

      const payload = {
        user_id: CustomerKey,
        card_id: String(CardId),
        last_four_digits: last4,
        expiry_date: ExpDate || null,
        rebill_id: RebillId ? String(RebillId) : null,
        card_scope: "payout",
        is_primary: makePrimary,
      };

      const { error } = await supabase.from("user_cards").upsert(payload, {
        onConflict: "user_id,card_id,card_scope",
      });

      if (error) {
        logE(cid, "db upsert failed", { error: error.message, payload });
        return res.status(500).send("ERROR");
      }

      logI(cid, "saved payout card", { payload });
    } else {
      logI(cid, "non-success notification", { Success, Status, ErrorCode, Message, NotificationType });
    }

    // ВАЖНО: банку нужен именно "OK"
    return res.status(200).send("OK");
  } catch (e) {
    logE(cid, "unhandled error", { error: String(e) });
    return res.status(500).send("ERROR");
  }
}
