import React, { useMemo, useEffect, useRef, useState, useCallback } from "react";
import styles from "../styles/company-settings.module.css";
import AvatarEditor from "./AvatarEditor";

/**
 * Лёгкое автодополнение адреса через DaData.
 * - Если нет NEXT_PUBLIC_DADATA_TOKEN — отдаём обычный <input>.
 * - Иначе: debounce 250мс, навигация ↑/↓/Enter, выбор кликом, закрытие по blur/ESC.
 */
function AddressSuggestInput({ value, onChange, placeholder = "Начните вводить адрес", disabled = false, hasError = false }) {
  const token = process.env.NEXT_PUBLIC_DADATA_TOKEN;
  const [query, setQuery] = useState(value || "");
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef(null);
  const timerRef = useRef(null);

  // синхронно подтягиваем внешнее value (когда его меняют извне)
  useEffect(() => { setQuery(value || ""); }, [value]);

  // клик вне — закрытие
  useEffect(() => {
    const onDocClick = (e) => {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const runSearch = useCallback(async (term) => {
    if (!token) return; // без токена не ищем
    if (!term || term.trim().length < 3) { setItems([]); return; }

    try {
      const r = await fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Token ${token}`,
        },
        body: JSON.stringify({ query: term, count: 7 }),
      });
      const data = await r.json().catch(() => ({}));
      const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setItems(suggestions.map(s => ({
        // используем полный адрес для максимально точного парсинга на бэке
        label: s.value || s.unrestricted_value || "",
        full: s.unrestricted_value || s.value || "",
      })));
      setOpen(true);
      setHighlight(-1);
    } catch {
      setItems([]);
      setOpen(false);
    }
  }, [token]);

  const onInputChange = (e) => {
    const v = e.target.value;
    setQuery(v);
    if (!token) {
      // как обычный input
      onChange?.(v);
      return;
    }
    // debounce
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(v), 250);
  };

  const applyItem = (it) => {
    onChange?.(it.full || it.label || "");
    setQuery(it.full || it.label || "");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = highlight >= 0 ? highlight : 0;
      if (items[idx]) applyItem(items[idx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Без токена — обычное поле ввода
  if (!token) {
    return (
      <input
        value={value || ""}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`${styles.input} ${hasError ? styles.errorInput : ""}`}
      />
    );
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        value={query}
        onChange={onInputChange}
        onFocus={() => { if (items.length > 0) setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={`${styles.input} ${hasError ? styles.errorInput : ""}`}
        autoComplete="off"
      />
      {open && items.length > 0 && (
        <div
          style={{
            position: "absolute",
            zIndex: 50,
            top: "100%",
            left: 0,
            right: 0,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderTop: "none",
            maxHeight: 260,
            overflowY: "auto",
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
          }}
        >
          {items.map((it, idx) => (
            <div
              key={`${it.full}-${idx}`}
              onMouseDown={(e) => { e.preventDefault(); }} // чтобы не терять фокус до click
              onClick={() => applyItem(it)}
              onMouseEnter={() => setHighlight(idx)}
              style={{
                padding: "10px 12px",
                cursor: "pointer",
                background: idx === highlight ? "#f3f4f6" : "#fff",
                borderTop: "1px solid #f3f4f6",
                fontSize: 14,
                lineHeight: "18px",
              }}
              title={it.full}
            >
              {it.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CompanySettings = ({ user, supabase, profilePhone }) => {
  const [companyData, setCompanyData] = useState(null);
  const [inn, setInn] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const messageTimerRef = useRef(null);
  const [submitError, setSubmitError] = useState("");
  const [companyAvatarUrl, setCompanyAvatarUrl] = useState("/avatar-default.svg");
  const [isSaved, setIsSaved] = useState(false);
  const [showInnInput, setShowInnInput] = useState(true);
  const [lookupFailCount, setLookupFailCount] = useState(0);
  const [manualMode, setManualMode] = useState(false);

  // для первичного заполнения (до первой регистрации)
  const [paymentData, setPaymentData] = useState({
    account: "",
    bik: "",
    corrAccount: "",
    bankName: "",
    payment_details: "",
  });

// ошибки по полям (покажем под инпутом)
const [fieldErrors, setFieldErrors] = useState({});
const [requiredFieldErrors, setRequiredFieldErrors] = useState({});
const clearRequiredFieldError = (key) => {
  setRequiredFieldErrors((prev) => ({ ...prev, [key]: undefined }));
};

const closeMessage = useCallback(() => {
  if (messageTimerRef.current) {
    clearTimeout(messageTimerRef.current);
    messageTimerRef.current = null;
  }
  setMessage(null);
}, []);

const showToast = useCallback((text, ms = 10000) => {
  if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
  setMessage(text);
  if (!text) return;
  messageTimerRef.current = setTimeout(() => {
    setMessage(null);
    messageTimerRef.current = null;
  }, Math.max(ms, 10000));
}, []);

useEffect(() => {
  if (!message) return;
  const onMouseDown = () => closeMessage();
  document.addEventListener("mousedown", onMouseDown, true);
  return () => document.removeEventListener("mousedown", onMouseDown, true);
}, [message, closeMessage]);

// только цифры
const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

// сеттер для платежных полей с фильтрацией
const setPaymentField = (key, raw) => {
  let v = raw;

  if (key === "bik") v = onlyDigits(raw).slice(0, 9);          // БИК = 9 цифр
  if (key === "account") v = onlyDigits(raw).slice(0, 20);     // р/с = 20 цифр
  if (key === "corrAccount") v = onlyDigits(raw).slice(0, 20); // кор/с = 20 цифр

  setPaymentData((prev) => ({ ...prev, [key]: v }));
  // как только пользователь правит поле — убираем ошибку этого поля
  setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  clearRequiredFieldError(key);
};

// валидация реквизитов перед submit
const validatePayment = (p) => {
  const errs = {};

  // В Т-банк эти поля обязательны: account, bankName, bik, details. :contentReference[oaicite:0]{index=0}
  if (!/^\d{20}$/.test(p.account || "")) errs.account = "Р/с должен состоять из 20 цифр";
  if (!/^\d{9}$/.test(p.bik || "")) errs.bik = "БИК должен состоять из 9 цифр";
  if ((p.corrAccount || "") && !/^\d{20}$/.test(p.corrAccount)) errs.corrAccount = "Кор. счёт должен состоять из 20 цифр";
  if (!(p.bankName || "").trim()) errs.bankName = "Укажите название банка";
  if (!(p.payment_details || "").trim()) errs.payment_details = "Укажите назначение платежа";

  return errs;
};

  // модалка «смены реквизитов»
  const [askChangeOpen, setAskChangeOpen] = useState(false);

  const originalCompanyRef = useRef(null);
  const originalPaymentRef = useRef(null);

const draftKey = useMemo(() => (user?.id ? `company_settings_draft:${user.id}` : null), [user?.id]);
const restoredDraftRef = useRef(false);

// восстановление черновика при монтировании
useEffect(() => {
  if (!draftKey) return;
  if (typeof window === 'undefined') return;

  try {
    const raw = sessionStorage.getItem(draftKey);
    if (!raw) return;

    const d = JSON.parse(raw);
    if (d?.inn != null) setInn(d.inn);
    if (d?.companyData != null) setCompanyData(d.companyData);
    if (d?.paymentData != null) setPaymentData(d.paymentData);
    if (typeof d?.showInnInput === 'boolean') setShowInnInput(d.showInnInput);
    if (typeof d?.isSaved === 'boolean') setIsSaved(d.isSaved);
    if (d?.companyAvatarUrl) setCompanyAvatarUrl(d.companyAvatarUrl);

    restoredDraftRef.current = true;
  } catch (e) {
    console.warn('draft restore failed', e);
  }
}, [draftKey]);

useEffect(() => {
  if (!draftKey) return;
  if (typeof window === 'undefined') return;

  const payload = {
    inn,
    companyData,
    paymentData,
    showInnInput,
    isSaved,
    companyAvatarUrl,
    ts: Date.now(),
  };

  // лёгкий debounce, чтобы не писать на каждый символ
  const t = setTimeout(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(payload));
    } catch {}
  }, 200);

  return () => clearTimeout(t);
}, [draftKey, inn, companyData, paymentData, showInnInput, isSaved, companyAvatarUrl]);

  const tourismOkveds = ["55.10", "55.20", "79.11", "79.12", "79.90", "93.19", "49.39"];

  const safeParseArray = (val) => {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") {
      try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : []; } catch { return []; }
    }
    return [];
  };

  const normalizeDBCompany = (row) => {
    const okveds = safeParseArray(row.okveds).map((o) => ({
      code: o.code || "",
      name: o.name || "",
      isMain: !!o.isMain,
    }));
    return {
      company_id: row.company_id,
      name: row.name || "",
      inn: row.inn || "",
      kpp: row.kpp || "",
      ceo_first_name: row.ceo_first_name || "",
      ceo_last_name: row.ceo_last_name || "",
      ceo_middle_name: row.ceo_middle_name || "",
      legalAddress: row.legal_address || row.legalAddress || "",
      phone: row.phone || "",
      ogrn: row.ogrn || "",
      okveds,
      status: row.status || "",
      tbank_registered: !!row.tbank_registered,
      tbank_shop_code: row.tbank_shop_code || "", // numeric
      tbank_code: row.tbank_code || "",           // article
      site_url: row.site_url || process.env.NEXT_PUBLIC_BASE_URL,
    };
  };

  // ===== загрузка и синхронизация ТОЛЬКО по shopCode =====
  useEffect(() => {
    const fetchData = async () => {

// ✅ если есть черновик с НЕсохранённой формой — не затираем её данными из БД
if (typeof window !== "undefined" && draftKey) {
try {
const raw = sessionStorage.getItem(draftKey);
if (raw) {
const d = JSON.parse(raw);
const hasUnsavedDraft = !!d?.companyData && d?.isSaved === false;
if (hasUnsavedDraft) return;
}
} catch {}
}

      const { data, error } = await supabase
        .from("mycompany")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        const normalized = normalizeDBCompany(data);
        setCompanyData(normalized);
        setPaymentData({
          account: data.payment_account || "",
          bik: data.payment_bik || "",
          corrAccount: data.payment_corr_account || "",
          bankName: data.bank_name || "",
          payment_details: data.payment_details || "",
        });
        setCompanyAvatarUrl(data.avatar_url || "/avatar-default.svg");
        setIsSaved(true);
        setShowInnInput(false);

        originalCompanyRef.current = normalized;
        originalPaymentRef.current = {
          account: data.payment_account || "",
          bik: data.payment_bik || "",
          corrAccount: data.payment_corr_account || "",
          bankName: data.bank_name || "",
          payment_details: data.payment_details || "",
        };

        // Проверяем shop только через sm-register/register/shop/{shopCode}
        if (normalized?.tbank_shop_code) {
          try {
            const r = await fetch(
              `/api/tbank/shop?shopCode=${encodeURIComponent(normalized.tbank_shop_code)}`,
              { method: "GET", headers: { Accept: "application/json" } }
            );
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              console.warn("[sync shop][fail]", r.status, err);
            }
          } catch (e) {
            console.warn("[sync shop][exception]", e);
          }
        }
} else {
// Если мы уже восстановили черновик (например, нашли по ИНН, но еще не сохранили в БД),
// то НЕ перетираем состояние и НЕ возвращаемся на ввод ИНН.
if (restoredDraftRef.current) return;


setShowInnInput(true);
setIsSaved(false);
}
    };
    if (user) fetchData();
}, [user, supabase, draftKey]);

  const validateInn = (val) =>
    /^\d{10}$/.test(String(val || "").trim()) || /^\d{12}$/.test(String(val || "").trim());

  const checkInnExists = async (innVal) => {
    const { data, error } = await supabase
      .from("mycompany")
      .select("inn, user_id")
      .eq("inn", innVal)
      .maybeSingle();
    return { exists: !!data, data, error };
  };

  const getInnExistsMessage = () =>
    'Организация с таким ИНН уже зарегистрирована на площадке «Онлок». Если это ваша компания, напишите в поддержку: Сообщения → Поддержка → Создать чат с поддержкой.';

  // ===== fallback DataNewton mapper
  const mapDataNewtonToCompanyData = async (dnJson) => {
    const root = dnJson?.payload || dnJson || {};
    const comp = root.company || {};
    const ip = root.individual || {};

    const name =
      comp.company_names?.full_name ||
      comp.company_names?.short_name ||
      comp.company_names?.reversed_short_name ||
      ip.fio ||
      "";

    let legalAddress = comp.address?.line_address || "";
    if (!legalAddress && ip?.contacts?.addresses?.length) {
      const addrObj = (ip.contacts.addresses || []).find(
        (c) => c?.clean_contact_type === "address" && c?.value
      );
      legalAddress = addrObj?.value || "";
    }
    if (!legalAddress && comp?.contacts?.addresses?.length) {
      const addrObj = (comp.contacts.addresses || []).find(
        (c) => c?.clean_contact_type === "address" && c?.value
      );
      legalAddress = addrObj?.value || "";
    }

    const st = comp.status || ip.status || {};
    const activeFlag = typeof st.active_status === "boolean" ? st.active_status : undefined;
    const codeEgr = (st.code_egr || "").toString().trim();
    const rus = (st.status_rus_short || "").toLowerCase();
    const eng = (st.status_eng_short || "").toLowerCase();
    const isActing =
      activeFlag === true || codeEgr === "001" || rus.includes("действует") || eng === "active";

    const managerFio =
      (Array.isArray(comp.managers) && comp.managers[0]?.fio) || ip.fio || "";
    const [ceo_last_name = "", ceo_first_name = "", ceo_middle_name = ""] =
      managerFio.trim().split(/\s+/);

    const innVal = root.inn || comp.inn || ip.inn || "";
    const kpp = comp.kpp || "";
    const ogrn = root.ogrn || comp.ogrn || ip.ogrn || "";

    const okvedList = Array.isArray(comp.okveds)
      ? comp.okveds
      : Array.isArray(ip.okveds)
      ? ip.okveds
      : [];
    const okvedsNormalized = okvedList.map((o) => ({
      code: o?.code || "",
      name: o?.value || "",
      isMain: !!o?.main,
    }));
    const filteredOkveds = okvedsNormalized.filter((o) => tourismOkveds.includes(o.code));

    let phone = profilePhone;
    if (!phone) {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("phone")
        .eq("user_id", user.id)
        .single();
      phone = profileError ? "" : profileData?.phone || "";
    }

    const isCompanyByInn = /^\d{10}$/.test(String(innVal || "").trim());

    return {
      name,
      inn: innVal,
      kpp: isCompanyByInn ? kpp : "",
      ceo_first_name,
      ceo_last_name,
      ceo_middle_name,
      legalAddress,
      phone,
      ogrn: ogrn || "",
      okveds: filteredOkveds,
      status: "acting",
      tbank_registered: false,
      site_url: process.env.NEXT_PUBLIC_BASE_URL,
    };
  };

  // ===== префилл: T-банк → DataNewton
  const fetchCompanyDataFromTBank = async () => {
    if (!validateInn(inn)) {
      showToast("ИНН некорректен (10 цифр для ООО, 12 для ИП)");
      return;
    }

    const { exists, error } = await checkInnExists(inn);
    if (error) {
      showToast("Ошибка проверки ИНН");
      return;
    }
    if (exists) {
      showToast(getInnExistsMessage());
      return;
    }

    try {
      const response = await fetch(`/api/tbank/company?inn=${inn}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`TBank ${response.status}`);
      if (payload?.ok === false) throw new Error(payload?.error || `TBank ${payload?.status || "lookup failed"}`);
      const data = payload?.data || payload;

      let phone = profilePhone;
      if (!phone) {
        const { data: profileData, error: profileError } = await supabase
          .from("profiles")
          .select("phone")
          .eq("user_id", user.id)
          .single();
        phone = profileError ? "" : profileData?.phone || "";
      }

      const filled = {
        name: data.fullName || data.name || "",
        inn: data.inn,
        kpp: data.companyType === "company" ? data.kpp || "" : "",
        ceo_first_name: data.ceo?.firstName || "",
        ceo_last_name: data.ceo?.lastName || "",
        ceo_middle_name: data.ceo?.middleName || "",
        legalAddress: data.legalAddress || "",
        phone,
        ogrn: data.ogrn || "",
        okveds: [],
        status: "acting",
        tbank_registered: false,
        site_url: process.env.NEXT_PUBLIC_BASE_URL,
      };
      setCompanyData(filled);
      setShowInnInput(false);
      setManualMode(false);
      setLookupFailCount(0);

// ✅ мгновенно сохраняем черновик (без ожидания debounce)
if (typeof window !== "undefined" && draftKey) {
try {
sessionStorage.setItem(draftKey, JSON.stringify({
inn,
companyData: filled,
paymentData,
showInnInput: false,
isSaved: false,
companyAvatarUrl,
ts: Date.now(),
}));
} catch {}
}
restoredDraftRef.current = true;

      originalCompanyRef.current = filled;
      originalPaymentRef.current = {
        account: "",
        bik: "",
        corrAccount: "",
        bankName: "",
        payment_details: "",
      };
      return;
    } catch {
      try {
        const dnRes = await fetch(`/api/datanewton/counterparty?inn=${inn}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const dnPayload = await dnRes.json().catch(() => ({}));
        if (!dnRes.ok) throw new Error(dnPayload?.error || `DataNewton ${dnRes.status}`);
        if (dnPayload?.ok === false) throw new Error(dnPayload?.error || `DataNewton ${dnPayload?.status || "lookup failed"}`);
        const dnJson = dnPayload?.payload ? dnPayload : dnPayload?.data || dnPayload;
        const mapped = await mapDataNewtonToCompanyData(dnJson);

        setCompanyData(mapped);
        setShowInnInput(false);
        setManualMode(false);
        setLookupFailCount(0);

// ✅ мгновенно сохраняем черновик (fallback)
if (typeof window !== "undefined" && draftKey) {
  try {
    sessionStorage.setItem(draftKey, JSON.stringify({
      inn,
      companyData: mapped,
      paymentData,
      showInnInput: false,
      isSaved: false,
      companyAvatarUrl,
      ts: Date.now(),
    }));
  } catch {}
}
restoredDraftRef.current = true;

        showToast("Данные получены через резервный источник (DataNewton)");

        originalCompanyRef.current = mapped;
        originalPaymentRef.current = {
          account: "",
          bik: "",
          corrAccount: "",
          bankName: "",
          payment_details: "",
        };
      } catch (fallbackErr) {
        const nextFailCount = lookupFailCount + 1;
        setLookupFailCount(nextFailCount);
        if (nextFailCount === 1) {
          showToast("Не удалось получить данные. Проверьте, правильно ли введён ИНН, и попробуйте ещё раз.");
        } else {
          showToast("Компания не найдена в базе. Вы можете ввести данные вручную.");
          setManualMode(true);
        }
        
      }
    }
  };



const prettifyTbankError = (rawMsg, companyName) => {
  if (!rawMsg) return "";

  let msg = String(rawMsg);

  // 1) Убираем переносы/многократные пробелы (в логе у тебя их очень много)
  msg = msg.replace(/\s+/g, " ").trim();

  // 2) Заменяем "onloc_8901026633[...]" на человекопонятное название
  //    ловим onloc_<цифры>[что угодно до закрывающей скобки]
  const safeName = (companyName || "").trim();
  if (safeName) {
    msg = msg.replace(/onloc_\d+\[[^\]]*]/g, safeName);
  }

  return msg;
};


const handleResetInn = () => {
  // очистить всё, что относится к текущей компании
  setInn("");
  setCompanyData(null);
  setIsSaved(false);
  setShowInnInput(true);
  setLookupFailCount(0);
  setManualMode(false);

  // очистить ошибки/сообщения
  setSubmitError("");

setCompanyAvatarUrl("/avatar-default.svg");

  setFieldErrors({});
  // toast успеха можно убрать
  closeMessage();

  // сбросить платежные (чтобы не тащить реквизиты от другой компании)
  setPaymentData({
    account: "",
    bik: "",
    corrAccount: "",
    bankName: "",
    payment_details: "",
  });

  // убрать “оригиналы”, чтобы логика сравнения не мешала
  originalCompanyRef.current = null;
  originalPaymentRef.current = null;

  // очистить черновик
  if (typeof window !== "undefined" && draftKey) {
    try { sessionStorage.removeItem(draftKey); } catch {}
  }
  restoredDraftRef.current = false;
};

  // ===== первичное сохранение (регистрация в Т-банк + upsert в БД)
const handleSaveCompany = async () => {
  const c = companyData || {};
  const p = paymentData || {};

  // ✅ (3.1) СРАЗУ чистим старую ошибку у кнопки
  setSubmitError("");
  setRequiredFieldErrors({});

  const isCompany = /^\d{10}$/.test((c.inn || "").trim());

  const innCheck = await checkInnExists((c.inn || "").trim());
  if (innCheck?.error) {
    setSubmitError("Не удалось проверить ИНН в базе. Попробуйте позже.");
    return;
  }
  if (innCheck?.exists && innCheck?.data?.user_id !== user.id) {
    setSubmitError(getInnExistsMessage());
    return;
  }

  // ✅ (3.2) если не заполнены обязательные поля — показываем ошибку у кнопки (не toast)
  const hasValue = (v) => String(v ?? "").trim().length > 0;
  const requiredErrors = {
    ...(hasValue(c.name) ? {} : { name: "Заполните данные анкеты" }),
    ...(hasValue(c.inn) ? {} : { inn: "Заполните данные анкеты" }),
    ...(hasValue(c.ogrn) ? {} : { ogrn: "Заполните данные анкеты" }),
    ...(hasValue(c.legalAddress) ? {} : { legalAddress: "Заполните данные анкеты" }),
    ...(hasValue(c.phone) ? {} : { phone: "Заполните данные анкеты" }),
    ...(hasValue(c.ceo_first_name) ? {} : { ceo_first_name: "Заполните данные анкеты" }),
    ...(hasValue(c.ceo_last_name) ? {} : { ceo_last_name: "Заполните данные анкеты" }),
    ...(hasValue(c.ceo_middle_name) ? {} : { ceo_middle_name: "Заполните данные анкеты" }),
    ...(!isCompany || hasValue(c.kpp) ? {} : { kpp: "Заполните данные анкеты" }),
    ...(hasValue(p.account) ? {} : { account: "Заполните данные анкеты" }),
    ...(hasValue(p.bik) ? {} : { bik: "Заполните данные анкеты" }),
    ...(hasValue(p.corrAccount) ? {} : { corrAccount: "Заполните данные анкеты" }),
    ...(hasValue(p.bankName) ? {} : { bankName: "Заполните данные анкеты" }),
    ...(hasValue(p.payment_details) ? {} : { payment_details: "Заполните данные анкеты" }),
  };
  if (Object.keys(requiredErrors).length > 0) {
    setRequiredFieldErrors(requiredErrors);
    setSubmitError("Заполните обязательные поля");
    return;
  }

  // ✅ (3.2) отдельная проверка банковских реквизитов
  const payErrs = validatePayment(p);
  if (Object.keys(payErrs).length > 0) {
    setFieldErrors(payErrs);
    setSubmitError("Проверьте банковские реквизиты");
    return;
  }

  setIsSubmitting(true);

  try {
    const response = await fetch("/api/tbank/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: c.name,
        full_name: c.name,
        inn: c.inn,
        kpp: c.kpp,
        ogrn: c.ogrn,
        legalAddress: c.legalAddress,
        phone: c.phone,
        ceo_first_name: c.ceo_first_name,
        ceo_last_name: c.ceo_last_name,
        ceo_middle_name: c.ceo_middle_name,
        payment_account: p.account,
        payment_bik: p.bik,
        payment_corr_account: p.corrAccount,
        bank_name: p.bankName,
        payment_details: p.payment_details,
        site_url: process.env.NEXT_PUBLIC_BASE_URL,
      }),
    });

if (!response.ok) {
  const errorData = await response.json().catch(() => ({}));
  const apiMsg =
    errorData?.error ||
    errorData?.message ||
    errorData?.details ||
    `Ошибка регистрации в Т-Банке (HTTP ${response.status})`;

  const pretty = prettifyTbankError(apiMsg, c.name);
  throw new Error(pretty);
}

    const resp = await response.json();
    const shopCode = resp.shopCode;
    const articleCode = resp.code;

      // Сохранение в БД (активная запись)
      await supabase.from("mycompany").update({ is_active: false }).eq("user_id", user.id);

      const companyId = companyData.company_id || crypto.randomUUID();
      const basePayload = {
        user_id: user.id,
        company_id: companyId,
        name: c.name,
        inn: c.inn,
        kpp: c.kpp,
        ceo_first_name: c.ceo_first_name,
        ceo_last_name: c.ceo_last_name,
        ceo_middle_name: c.ceo_middle_name,
        legal_address: c.legalAddress,
        phone: c.phone,
        ogrn: c.ogrn,
        payment_account: p.account,
        payment_bik: p.bik,
        payment_corr_account: p.corrAccount,
        bank_name: p.bankName,
        payment_details: p.payment_details,
        okveds: c.okveds,
        avatar_url: companyAvatarUrl,
        status: c.status || "acting",
        is_active: true,
        tbank_registered: true,
        tbank_shop_code: shopCode,
        tbank_code: articleCode || null,
        site_url: process.env.NEXT_PUBLIC_BASE_URL,
      };

      const up = await supabase.from("mycompany").upsert(basePayload).select().single();
      if (up.error) throw up.error;

      await supabase
        .from("profiles")
        .update({ phone: profilePhone })
        .eq("user_id", user.id);

      const saved = normalizeDBCompany(up.data);
      setCompanyData(saved);
      setIsSaved(true);
      setSubmitError("");

// ✅ ВОТ СЮДА ВСТАВИТЬ (очистка черновика)
if (typeof window !== "undefined" && draftKey) {
sessionStorage.removeItem(draftKey);
}
restoredDraftRef.current = false;

      showToast("Компания зарегистрирована и сохранена");

      // финальная валидация точки
      if (saved.tbank_shop_code) {
        try { await fetch(`/api/tbank/shop?shopCode=${encodeURIComponent(saved.tbank_shop_code)}`, { method: "GET", headers: { Accept: "application/json" } }); } catch {}
      }

      originalCompanyRef.current = saved;
      originalPaymentRef.current = {
        account: p.account,
        bik: p.bik,
        corrAccount: p.corrAccount,
        bankName: p.bankName,
        payment_details: p.payment_details,
      };

  } catch (error) {
    // ✅ ошибка рядом с кнопкой (не toast)
    setSubmitError(error?.message ? String(error.message) : "Ошибка сохранения");
  } finally {
    setIsSubmitting(false);
  }
};

  // ===== Создание чата под смену реквизитов: тип company_edit (с фолбэком)
  async function ensureSupportChatForChange() {
    if (!user || !supabase) return null;
    const TITLE = "Смена реквизитов организации";

    const readableMsg = `[COMPANY_CHANGE_REQUEST] Пользователь хочет сменить реквизиты организации "${companyData?.name || ""}"`;

    // пробуем создать company_edit
    try {
      const { data: newChat, error: insErr } = await supabase
        .from("chats")
        .insert({
          title: TITLE,
          chat_type: "company_edit",
          is_group: false,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (insErr) throw insErr;

      await supabase.from("chat_participants").insert({ chat_id: newChat.id, user_id: user.id });
      await supabase.from("chat_messages").insert({
        chat_id: newChat.id,
        user_id: user.id,
        content: readableMsg,
        created_at: new Date().toISOString(),
        read: false,
      });

      return newChat.id;
    } catch (e) {
      // Фолбэк: если check constraint ещё не обновлён — создадим support
      console.warn("[company_edit fallback to support]", e?.message || e);
      const { data: fallbackChat, error: fallbackErr } = await supabase
        .from("chats")
        .insert({
          title: TITLE,
          chat_type: "support",
          is_group: false,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (fallbackErr) {
        console.error("[support fallback failed]", fallbackErr);
        return null;
      }

      await supabase.from("chat_participants").insert({ chat_id: fallbackChat.id, user_id: user.id });
      await supabase.from("chat_messages").insert({
        chat_id: fallbackChat.id,
        user_id: user.id,
        content: readableMsg,
        created_at: new Date().toISOString(),
        read: false,
      });

      return fallbackChat.id;
    }
  }

  // ===== UI helpers
  const isCompanyEntity = useMemo(() => {
    const currentInn = (companyData?.inn || inn || "").trim();
    if (/^\d{10}$/.test(currentInn)) return true;
    if (/^\d{12}$/.test(currentInn)) return false;
    return true;
  }, [companyData?.inn, inn]);

  const startManualInput = () => {
    setCompanyData({
      company_id: "",
      name: "",
      inn: inn || "",
      kpp: "",
      ceo_first_name: "",
      ceo_last_name: "",
      ceo_middle_name: "",
      legalAddress: "",
      phone: profilePhone || "",
      ogrn: "",
      okveds: [],
      status: "acting",
      tbank_registered: false,
      site_url: process.env.NEXT_PUBLIC_BASE_URL,
    });
    setShowInnInput(false);
    setIsSaved(false);
  };

  return (
    <div className={styles.companyTab}>
{companyData?.tbank_registered ? (
  <AvatarEditor
    user={user}
    avatarUrl={companyAvatarUrl}
    updateAvatarUrl={setCompanyAvatarUrl}
    supabase={supabase}
    type="company"
    canEditAvatar={true}
  />
) : (
  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
    <div
      onClick={() => {
        showToast("Аватар можно прикрепить после регистрации организации в Т-Банке. Сначала заполните данные и нажмите «Сохранить компанию».");
      }}
      style={{
        width: 64,
        height: 64,
        borderRadius: "50%",
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        cursor: "pointer",
        background: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      title="Добавить аватар"
    >
      <img
        src={companyAvatarUrl || "/avatar-default.svg"}
        alt="company avatar"
        style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.6 }}
      />
    </div>

    <div style={{ fontSize: 14, color: "#64748b" }}>
      Аватар организации
    </div>
  </div>
)}

      {/* Шаг 1: Получение по ИНН (для новых компаний) */}
      {showInnInput && (
        <div className={styles.inputGroup}>
          <label>Введите ИНН организации:</label>
          <input
            type="text"
            value={inn}
            onChange={(e) => {
              const value = e.target.value.replace(/\D/g, "");
              setInn(value);
            }}
            maxLength={12}
            placeholder="10 цифр для ООО, 12 для ИП"
          />
          <button className={styles.actionButton} onClick={fetchCompanyDataFromTBank}>
            Получить данные
          </button>
          {manualMode && (
            <button className={styles.retryButton} type="button" onClick={startManualInput}>
              Ввести данные вручную
            </button>
          )}
        </div>
      )}


      {/* Шаг 2: Просмотр/сохранение */}
      {companyData && (
        <div>
          <div className={styles.companySection}>
            <h3 className={styles.sectionTitle}>Данные организации</h3>



            {/* Название */}
            <div className={styles.inputGroup}>
              <label>Название</label>
              {isSaved ? (
                <span className={!companyData.name ? styles.errorText : ""}>
                  {companyData.name || "Нужно заполнить"}
                </span>
              ) : (
                <>
                  <input
                    value={companyData.name || ""}
                    onChange={(e) => {
                      setCompanyData({ ...companyData, name: e.target.value });
                      clearRequiredFieldError("name");
                    }}
                    className={`${styles.input} ${requiredFieldErrors.name ? styles.errorInput : ""}`}
                  />
                  {requiredFieldErrors.name && <div className={styles.errorText}>{requiredFieldErrors.name}</div>}
                </>
              )}
            </div>

            {/* ИНН */}
            <div className={styles.inputGroup}>
              <label>ИНН</label>
              <input value={companyData.inn || ""} disabled className={styles.input} />
            </div>

            {/* ОГРН */}
            <div className={styles.inputGroup}>
              <label>ОГРН / ОГРНИП</label>
              {isSaved ? (
                <span className={!companyData.ogrn ? styles.errorText : ""}>
                  {companyData.ogrn || "Нужно заполнить"}
                </span>
              ) : (
                <>
                <input
                  value={companyData.ogrn || ""}
                  onChange={(e) =>
setCompanyData({
...companyData,
ogrn: e.target.value.replace(/\D/g, "").slice(0, 15),
})
}
                  onBlur={() => clearRequiredFieldError("ogrn")}
inputMode="numeric"
pattern="\\d*"
                  className={`${styles.input} ${requiredFieldErrors.ogrn ? styles.errorInput : ""}`}
                />
                {requiredFieldErrors.ogrn && <div className={styles.errorText}>{requiredFieldErrors.ogrn}</div>}
                </>
              )}
            </div>

            {/* КПП */}
            <div className={styles.inputGroup}>
              <label>КПП</label>
              {isCompanyEntity ? (
                isSaved ? (
                  <span className={!companyData.kpp ? styles.errorText : ""}>
                    {companyData.kpp || "Нужно заполнить"}
                  </span>
                ) : (
                  <>
                  <input
                    value={companyData.kpp || ""}
                    onChange={(e) =>
setCompanyData({
...companyData,
kpp: e.target.value.replace(/\D/g, "").slice(0, 9),
})
}
                    onBlur={() => clearRequiredFieldError("kpp")}
inputMode="numeric"
pattern="\\d*"
                    className={`${styles.input} ${requiredFieldErrors.kpp ? styles.errorInput : ""}`}
                  />
                  {requiredFieldErrors.kpp && <div className={styles.errorText}>{requiredFieldErrors.kpp}</div>}
                  </>
                )
              ) : (
                <span>Не требуется для ИП</span>
              )}
            </div>

            {/* ФИО руководителя */}
            {[
              ["ceo_last_name", "Фамилия руководителя"],
              ["ceo_first_name", "Имя руководителя"],
              ["ceo_middle_name", "Отчество руководителя"],
            ].map(([key, label]) => (
              <div className={styles.inputGroup} key={key}>
                <label>{label}</label>
                {isSaved ? (
                  <span className={!companyData[key] ? styles.errorText : ""}>
                    {companyData[key] || "Нужно заполнить"}
                  </span>
                ) : (
                  <>
                    <input
                      value={companyData[key] || ""}
                      onChange={(e) => {
                        setCompanyData({ ...companyData, [key]: e.target.value });
                        clearRequiredFieldError(key);
                      }}
                      className={`${styles.input} ${requiredFieldErrors[key] ? styles.errorInput : ""}`}
                    />
                    {requiredFieldErrors[key] && <div className={styles.errorText}>{requiredFieldErrors[key]}</div>}
                  </>
                )}
              </div>
            ))}

            {/* Юр. адрес — теперь с DaData */}
            <div className={styles.inputGroup}>
              <label>Юр. адрес</label>
              {isSaved ? (
                <span className={!companyData.legalAddress ? styles.errorText : ""}>
                  {companyData.legalAddress || "Нужно заполнить"}
                </span>
              ) : (
                <>
                  <AddressSuggestInput
                    value={companyData.legalAddress || ""}
                    onChange={(val) => {
                      setCompanyData({ ...companyData, legalAddress: val });
                      clearRequiredFieldError("legalAddress");
                    }}
                    placeholder="Начните вводить адрес (DaData)"
                    disabled={false}
                    hasError={!!requiredFieldErrors.legalAddress}
                  />
                  {requiredFieldErrors.legalAddress && <div className={styles.errorText}>{requiredFieldErrors.legalAddress}</div>}
                </>
              )}
            </div>

            {/* Телефон */}
            <div className={styles.inputGroup}>
              <label>Телефон</label>
              {isSaved ? (
                <span className={!companyData.phone ? styles.errorText : ""}>
                  {companyData.phone || "Нужно заполнить"}
                </span>
              ) : (
                <>
                  <input
                    value={companyData.phone || ""}
                    onChange={(e) => {
                      setCompanyData({ ...companyData, phone: e.target.value });
                      clearRequiredFieldError("phone");
                    }}
                    placeholder="+79991234567"
                    className={`${styles.input} ${requiredFieldErrors.phone ? styles.errorInput : ""}`}
                  />
                  {requiredFieldErrors.phone && <div className={styles.errorText}>{requiredFieldErrors.phone}</div>}
                </>
              )}
            </div>

            {/* Статус */}
            <div className={styles.inputGroup}>
              <label>Статус</label>
              <input
                value={companyData.status === "acting" ? "Действующая" : "Недействующая"}
                disabled
                className={styles.input}
              />
            </div>

            {/* ОКВЭДы */}
            <div className={styles.inputGroup}>
              <label>ОКВЭДы</label>
              <div>
                {Array.isArray(companyData.okveds) && companyData.okveds.length > 0 ? (
                  companyData.okveds.map((o) => (
                    <div key={`${o.code}-${o.name}`}>
                      {o.code} — {o.name} <span className={styles.success}>✔️</span>
                    </div>
                  ))
                ) : (
                  <span className={styles.error}>ОКВЭДы отсутствуют</span>
                )}
              </div>
            </div>
          </div>

          {/* Платёжные реквизиты (редактируются только до регистрации) */}
          <div className={styles.companySection}>
            <h3 className={styles.sectionTitle}>Данные для оплаты</h3>
            {[
              ["account", "Расчётный счёт"],
              ["bik", "БИК"],
              ["corrAccount", "Кор. счёт"],
              ["bankName", "Название банка"],
              ["payment_details", "Назначение платежа"],
            ].map(([key, label]) => (
              <div className={styles.inputGroup} key={key}>
                <label>{label}</label>
                {isSaved ? (
                  <input
                    value={
                      key === "account"
                        ? paymentData.account
                        : key === "bik"
                        ? paymentData.bik
                        : key === "corrAccount"
                        ? paymentData.corrAccount
                        : key === "bankName"
                        ? paymentData.bankName
                        : paymentData.payment_details
                    }
                    disabled
                    className={`${styles.input}`}
                  />
) : (
<>
<input
value={
key === "account"
? paymentData.account
: key === "bik"
? paymentData.bik
: key === "corrAccount"
? paymentData.corrAccount
: key === "bankName"
? paymentData.bankName
: paymentData.payment_details
}
onChange={(e) => {
const v = e.target.value;


// цифры-only для нужных полей
if (key === "account" || key === "bik" || key === "corrAccount") {
setPaymentField(key, v);
} else {
setPaymentData((prev) => ({ ...prev, [key]: v }));
setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
clearRequiredFieldError(key);
}
}}
inputMode={
key === "account" || key === "bik" || key === "corrAccount"
? "numeric"
: undefined
}
pattern={
key === "account" || key === "bik" || key === "corrAccount"
? "\\d*"
: undefined
}
className={`${styles.input} ${
(requiredFieldErrors[key] ? styles.errorInput : "")
} ${fieldErrors[key] ? styles.errorInput : ""}`}
/>


{/* текст ошибки под полем */}
{fieldErrors[key] && (
<div className={styles.errorText} style={{ marginTop: 6 }}>
{fieldErrors[key]}
</div>
)}
{requiredFieldErrors[key] && !fieldErrors[key] && (
<div className={styles.errorText} style={{ marginTop: 6 }}>
{requiredFieldErrors[key]}
</div>
)}
</>
)}
              </div>
            ))}
          </div>

          {/* Кнопки действий */}
<div className={styles.buttonGroup}>
  {!isSaved ? (
    <div className={styles.saveRow}>
  <button
    className={styles.actionButton}
    onClick={handleSaveCompany}
    disabled={isSubmitting}
  >
    {isSubmitting ? "Сохранение..." : "Сохранить компанию"}
  </button>

  {/* ✅ Новый ИНН — только пока НЕ сохранено */}
<button
  type="button"
  className={styles.retryButton}
  onClick={handleResetInn}
  disabled={isSubmitting}
  title="Ввести другой ИНН"
>
  Новый ИНН
</button>

  {!!submitError && (
    <div className={styles.inlineError} role="alert" title={submitError}>
      {submitError}
    </div>
  )}
</div>
  ) : (
    <button
      type="button"
      className={styles.actionButton}
      onClick={() => setAskChangeOpen(true)}
    >
      Поменять реквизиты организации?
    </button>
  )}
</div>

          {/* Статус регистрации */}
          {isSaved && (
            <div className={styles.verificationSection}>
              <h3 className={styles.sectionTitle}>Статус регистрации</h3>
              {companyData.tbank_registered ? (
                <p className={styles.verificationStatus}>
                  ✅ Компания зарегистрирована в Т-Банке
                </p>
              ) : (
                <p className={styles.verificationStatus}>
                  ⚠️ Сохраните данные для регистрации в Т-Банке
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {message && <div className={styles.toast}>{message}</div>}

      {/* Диалог: подтверждение создания чата (без «перейти в сообщения») */}
      {askChangeOpen && (
        <div
          onClick={() => setAskChangeOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 12,
              width: 420,
              maxWidth: "96vw",
              padding: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Поменять реквизиты организации?
            </div>
            <div style={{ marginBottom: 12, opacity: 0.85 }}>
              Будет создан чат в разделе «Сообщения → Поддержка» с названием
              «Смена реквизитов организации».
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setAskChangeOpen(false)} className={styles.retryButton}>
                Нет
              </button>
              <button
                onClick={async () => {
                  setAskChangeOpen(false);
                  const chatId = await ensureSupportChatForChange();
                  if (!chatId) {
                    showToast("Не удалось создать чат поддержки");
                    return;
                  }
                  // Без доп. сообщений и редиректов
                  showToast("Запрос отправлен в поддержку");
                }}
                className={styles.actionButton}
              >
                Да
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompanySettings;
