import { useEffect, useMemo, useRef, useState } from "react";
import mobileStyles from "../styles/company-settings.mobile.module.css";
import AvatarEditorMobile from "./AvatarEditorMobile";

// CompanySettingsMobile (как PC):
// - корректный парсинг /api/tbank/company (PC-формат)
// - fallback на /api/datanewton/counterparty
// - нормализация записи из mycompany (snake_case -> camelCase)
// - сохранение черновика в localStorage (чтобы не терять данные при сворачивании вкладки)
// - ✅ создание чата «Смена реквизитов организации» (company_edit) в «Сообщения → Поддержка»
// - ✅ защита от дублей: если чат уже создан — кнопка затемняется + сообщение «Запрос уже отправлен»
// - ✅ created_at / joined_at не выставляем вручную — пусть ставит сервер

const CompanySettingsMobile = ({ user, supabase, profilePhone }) => {
  const TITLE_CHANGE = "Смена реквизитов организации";

  const [companyData, setCompanyData] = useState(null);
  const [inn, setInn] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const [paymentData, setPaymentData] = useState({
    account: "",
    bik: "",
    corrAccount: "",
    bankName: "",
    payment_details: "",
  });

  // модалка «смены реквизитов»
  const [askChangeOpen, setAskChangeOpen] = useState(false);
  const [isCreatingChangeChat, setIsCreatingChangeChat] = useState(false);

  // защита от повторной отправки
  const [changeRequestSent, setChangeRequestSent] = useState(false);
  const [existingChangeChatId, setExistingChangeChatId] = useState(null);

  const [message, setMessage] = useState(null);
  const toastTimerRef = useRef(null);
  const [requiredErrors, setRequiredErrors] = useState({});
  const [companyAvatarUrl, setCompanyAvatarUrl] = useState("/avatar-default.svg");
  const [addressSuggestions, setAddressSuggestions] = useState([]);

  const [isSaved, setIsSaved] = useState(false);
  const [showInnInput, setShowInnInput] = useState(true);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPrefilling, setIsPrefilling] = useState(false);

  const tourismOkveds = ["55.10", "55.20", "79.11", "79.12", "79.90", "93.19", "49.39"];

  const toast = (text, ms = 3000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setMessage(text);
    if (text) {
      toastTimerRef.current = setTimeout(() => {
        setMessage(null);
        toastTimerRef.current = null;
      }, Math.max(ms, 10000));
    }
  };

  const closeToast = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setMessage(null);
  };

  useEffect(() => {
    if (!message) return;
    const onMouseDown = () => closeToast();
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [message]);

  const safeUUID = () => {
    try {
      if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {}
    return `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  const safeParseArray = (val) => {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") {
      try {
        const arr = JSON.parse(val);
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const normalizeDBCompany = (row) => {
    const okveds = safeParseArray(row?.okveds).map((o) => ({
      code: o?.code || "",
      name: o?.name || "",
      isMain: !!o?.isMain,
    }));

    return {
      company_id: row?.company_id || "",
      name: row?.name || "",
      inn: row?.inn || "",
      kpp: row?.kpp || "",
      ogrn: row?.ogrn || "",
      legalAddress: row?.legal_address || row?.legalAddress || "",
      phone: row?.phone || "",
      ceo_first_name: row?.ceo_first_name || "",
      ceo_last_name: row?.ceo_last_name || "",
      ceo_middle_name: row?.ceo_middle_name || "",
      okveds,
      status: row?.status || "",
      tbank_registered: !!row?.tbank_registered,
      tbank_shop_code: row?.tbank_shop_code || "",
      tbank_code: row?.tbank_code || "",
      site_url: row?.site_url || process.env.NEXT_PUBLIC_BASE_URL,
      avatar_url: row?.avatar_url || "",
    };
  };

  const isCompanyEntity = useMemo(
    () => /^\d{10}$/.test(String(companyData?.inn || inn || "").trim()),
    [companyData?.inn, inn]
  );

  // =========================
  // Draft cache (localStorage)
  // =========================
  const DRAFT_KEY = useMemo(() => `onloc:companyDraft:${user?.id || "anon"}`, [user?.id]);

  const saveDraft = (patch = {}) => {
    try {
      if (typeof window === "undefined") return;

      const draft = {
        v: 1,
        updatedAt: new Date().toISOString(),
        inn,
        companyData,
        paymentData,
        isEditing,
        isSaved,
        showInnInput,
        companyAvatarUrl,
        patch,
      };

      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
      console.warn("[CompanySettingsMobile] saveDraft failed:", e);
    }
  };

  const loadDraft = () => {
    try {
      if (typeof window === "undefined") return null;

      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;

      const draft = JSON.parse(raw);

      // TTL 24 часа
      const ts = draft?.updatedAt ? new Date(draft.updatedAt).getTime() : 0;
      const ageMs = Date.now() - ts;
      if (ts && ageMs > 24 * 60 * 60 * 1000) {
        window.localStorage.removeItem(DRAFT_KEY);
        return null;
      }

      return draft;
    } catch (e) {
      console.warn("[CompanySettingsMobile] loadDraft failed:", e);
      return null;
    }
  };

  const clearDraft = () => {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(DRAFT_KEY);
    } catch {}
  };

  // автосейв черновика
  useEffect(() => {
    if (!user?.id) return;
    if (!companyData && !inn) return;

    if (isSaved) {
      clearDraft();
      return;
    }

    saveDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, inn, companyData, paymentData, isEditing, isSaved, showInnInput, companyAvatarUrl]);

  // =========================
  // Init: загрузка активной компании из БД
  // + если нет в БД — восстановление черновика
  // =========================
  useEffect(() => {
    let alive = true;

    const run = async () => {
      try {
        if (!user?.id || !supabase) return;

        // ВАЖНО: если по ошибке осталось несколько активных записей —
        // берём самую свежую, чтобы не падать на maybeSingle().
        const { data, error } = await supabase
          .from("mycompany")
          .select("*")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (error) {
          // 406 / not found — это не фатально, просто нет записи
          if (error?.code !== "PGRST116" && error?.status !== 406) {
            console.error("[CompanySettingsMobile] fetch mycompany error:", error);
            if (alive) toast("Не удалось загрузить данные компании. Проверь доступ/политику.", 4000);
          }
        }

        if (data) {
          const normalized = normalizeDBCompany(data);

          if (!alive) return;

          setCompanyData(normalized);
          setInn(String(data.inn || ""));
          setPaymentData({
            account: data.payment_account || "",
            bik: data.payment_bik || "",
            corrAccount: data.payment_corr_account || "",
            bankName: data.bank_name || "",
            payment_details: data.payment_details || "",
          });
          setCompanyAvatarUrl(data.avatar_url || "/avatar-default.svg");

          setIsSaved(true);
          setIsEditing(false);
          setShowInnInput(false);

          // т.к. в БД уже есть — черновик больше не нужен
          clearDraft();
          return;
        }

        // если активной компании в БД нет — пробуем поднять черновик
        const draft = loadDraft();
        if (draft?.companyData && alive) {
          setInn(draft.inn || "");
          setCompanyData(draft.companyData);

          setPaymentData(
            draft.paymentData || {
              account: "",
              bik: "",
              corrAccount: "",
              bankName: "",
              payment_details: "",
            }
          );

          setCompanyAvatarUrl(draft.companyAvatarUrl || "/avatar-default.svg");
          setIsEditing(typeof draft.isEditing === "boolean" ? draft.isEditing : true);
          setIsSaved(!!draft.isSaved);
          setShowInnInput(typeof draft.showInnInput === "boolean" ? draft.showInnInput : false);
        }
      } catch (e) {
        console.error("[CompanySettingsMobile] init error:", e);
        if (alive) toast("Ошибка загрузки компании. Попробуйте обновить страницу.", 4000);
      }
    };

    run();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, supabase]);


  // =========================
  // Проверка: есть ли уже чат «Смена реквизитов организации»
  // =========================
  const checkExistingChangeChat = async () => {
    try {
      if (!user?.id || !supabase) return { exists: false, chatId: null };

      // 1) все чаты пользователя
      const { data: parts, error: partsErr } = await supabase
        .from("chat_participants")
        .select("chat_id")
        .eq("user_id", user.id)
        .limit(500);

      if (partsErr) throw partsErr;

      const chatIds = (parts || []).map((p) => p.chat_id).filter(Boolean);
      if (!chatIds.length) return { exists: false, chatId: null };

      // 2) фильтруем нужные по title + типу + не закрытые (если есть флаг)
      const { data: chats, error: chatsErr } = await supabase
        .from("chats")
        .select("id,title,chat_type,created_at,support_close_confirmed")
        .in("id", chatIds)
        .eq("title", TITLE_CHANGE)
        .in("chat_type", ["company_edit", "support"])
        .or("support_close_confirmed.is.null,support_close_confirmed.eq.false");

      if (chatsErr) throw chatsErr;

      if (!chats?.length) return { exists: false, chatId: null };

      // выбираем самый свежий (по created_at) — но это только для выбора, НЕ для записи
      const sorted = [...chats].sort((a, b) => {
        const ta = a?.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b?.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
      });

      return { exists: true, chatId: sorted[0]?.id || null };
    } catch (e) {
      console.warn("[CompanySettingsMobile] checkExistingChangeChat failed:", e?.message || e);
      return { exists: false, chatId: null };
    }
  };

  // когда компания сохранена — сразу проверяем, нет ли уже созданного чата
  useEffect(() => {
    let alive = true;

    const run = async () => {
      if (!isSaved) return;

      const res = await checkExistingChangeChat();
      if (!alive) return;

      if (res?.exists && res?.chatId) {
        setChangeRequestSent(true);
        setExistingChangeChatId(res.chatId);
      } else {
        setChangeRequestSent(false);
        setExistingChangeChatId(null);
      }
    };

    run();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSaved, user?.id]);

  const validateInn = (val) => /^\d{10}$/.test(val) || /^\d{12}$/.test(val);

  const checkInnExists = async (innVal) => {
    const { data, error } = await supabase.from("mycompany").select("inn").eq("inn", innVal).maybeSingle();
    const notFound = error && (error.code === "PGRST116" || error.status === 406);
    return { exists: !!data, error: notFound ? null : error };
  };

  const getPhoneForCompany = async () => {
    const phone = String(profilePhone || "").trim();
    if (phone && phone !== "+7") return phone;

    const { data, error } = await supabase.from("profiles").select("phone").eq("user_id", user.id).maybeSingle();
    if (error) return "";
    return data?.phone || "";
  };

  // ===== fallback DataNewton (как PC)
  const mapDataNewtonToCompanyData = async (dnJson) => {
    const root = dnJson?.payload || dnJson || {};
    const comp = root.company || {};
    const ip = root.individual || {};

    const name =
      comp.company_names?.full_name ||
      comp.company_names?.short_name ||
      comp.company_names?.full ||
      ip?.fio_full ||
      ip?.fio ||
      "";

    const innValue = (comp?.inn || ip?.inn || inn || "").toString().replace(/\D/g, "");
    const kppValue = (comp?.kpp || "").toString().replace(/\D/g, "");

    const ogrnValue = (comp?.ogrn || ip?.ogrnip || ip?.ogrn || "").toString().replace(/\D/g, "");

    const address =
      comp?.address?.raw ||
      comp?.address?.value ||
      comp?.legal_address?.raw ||
      comp?.legal_address?.value ||
      root?.address?.raw ||
      root?.address?.value ||
      "";

    const phone = comp?.phone || root?.phone || (await getPhoneForCompany()) || "";

    const ceo =
      comp?.management?.ceo ||
      comp?.ceo ||
      comp?.management?.head ||
      comp?.management?.fio ||
      "";

    const ceoParts = String(ceo || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const ceo_last_name = ceoParts[0] || "";
    const ceo_first_name = ceoParts[1] || "";
    const ceo_middle_name = ceoParts[2] || "";

    const okvedRaw =
      comp?.okveds ||
      comp?.okved ||
      comp?.activity?.okveds ||
      comp?.activities?.okveds ||
      comp?.okved_list ||
      [];

    const okveds = safeParseArray(okvedRaw).map((o, idx) => ({
      code: o?.code || o?.okved || o?.value || "",
      name: o?.name || o?.title || o?.text || "",
      isMain: !!o?.isMain || !!o?.main || idx === 0,
    }));

    return {
      company_id: "",
      name: String(name || ""),
      inn: innValue,
      kpp: kppValue,
      ogrn: ogrnValue,
      legalAddress: String(address || ""),
      phone: String(phone || ""),
      ceo_first_name: String(ceo_first_name || ""),
      ceo_last_name: String(ceo_last_name || ""),
      ceo_middle_name: String(ceo_middle_name || ""),
      okveds,
      status: comp?.status || comp?.state || "acting",
      tbank_registered: false,
      tbank_shop_code: "",
      tbank_code: "",
      site_url: process.env.NEXT_PUBLIC_BASE_URL,
      avatar_url: companyAvatarUrl || "/avatar-default.svg",
    };
  };

  // ===== Получение компании по ИНН (tbank -> datanewton fallback)
  const fetchCompanyData = async () => {
    const innVal = String(inn || "").replace(/\D/g, "");
    if (!validateInn(innVal)) {
      toast("Введите корректный ИНН (10 или 12 цифр)");
      return;
    }

    setInn(innVal);

    const check = await checkInnExists(innVal);
    if (check?.error) {
      console.error("[CompanySettingsMobile] checkInnExists error:", check.error);
      toast("Не удалось проверить ИНН. Попробуйте позже.");
      return;
    }
    if (check?.exists) {
      toast("Организация с таким ИНН уже зарегистрирована на платформе");
      return;
    }

    setIsPrefilling(true);
    try {
      // 1) TBank company endpoint
      try {
        const r = await fetch(`/api/tbank/company?inn=${encodeURIComponent(innVal)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        if (j?.ok === false) throw new Error(j?.error || `TBank ${j?.status || "lookup failed"}`);

        const src = j?.data || j;

        const mapped = {
          company_id: "",
          name: src?.name || src?.full_name || "",
          inn: innVal,
          kpp: src?.kpp || "",
          ogrn: src?.ogrn || src?.ogrnip || "",
          legalAddress: src?.address || src?.legal_address || src?.legalAddress || "",
          phone: src?.phone || (await getPhoneForCompany()) || "",
          ceo_first_name: src?.ceo_first_name || src?.ceo?.firstName || "",
          ceo_last_name: src?.ceo_last_name || src?.ceo?.lastName || "",
          ceo_middle_name: src?.ceo_middle_name || src?.ceo?.middleName || "",
          okveds: safeParseArray(src?.okveds || src?.okved || []),
          status: src?.status || "acting",
          tbank_registered: false,
          tbank_shop_code: "",
          tbank_code: "",
          site_url: process.env.NEXT_PUBLIC_BASE_URL,
          avatar_url: companyAvatarUrl || "/avatar-default.svg",
        };

        setCompanyData(mapped);
        setShowInnInput(false);
        setIsEditing(true);
        toast("Данные получены");
        return;
      } catch (e) {
        console.warn("[CompanySettingsMobile] /api/tbank/company failed, fallback to datanewton:", e?.message || e);
      }

      // 2) DataNewton fallback
      const dn = await fetch(`/api/datanewton/counterparty?inn=${encodeURIComponent(innVal)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const dnJson = await dn.json().catch(() => ({}));
      if (!dn.ok) throw new Error(dnJson?.error || `HTTP ${dn.status}`);
      if (dnJson?.ok === false) throw new Error(dnJson?.error || `DataNewton ${dnJson?.status || "lookup failed"}`);

      const mapped2 = await mapDataNewtonToCompanyData(dnJson);
      setCompanyData(mapped2);
      setShowInnInput(false);
      setIsEditing(true);
      toast("Данные получены (fallback)");
    } catch (error) {
      console.error("[CompanySettingsMobile] fetchCompanyData error:", error);
      toast(`Ошибка: ${error?.message || "не удалось получить данные"}`);
    } finally {
      setIsPrefilling(false);
    }
  };

  // ===== DaData address suggestions
  const fetchAddressSuggestions = async (query) => {
    const q = String(query || "");
    if (q.length < 3) {
      setAddressSuggestions([]);
      return;
    }
    try {
      const response = await fetch("https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Token ${process.env.NEXT_PUBLIC_DADATA_TOKEN}`,
        },
        body: JSON.stringify({ query: q, count: 5 }),
      });
      if (!response.ok) throw new Error("Ошибка подсказок адреса");
      const data = await response.json();
      setAddressSuggestions(data.suggestions || []);
    } catch (error) {
      console.error("Ошибка загрузки подсказок DaData:", error);
    }
  };

  const handleAddressChange = (e) => {
    const value = e.target.value;
    setCompanyData((prev) => ({ ...(prev || {}), legalAddress: value }));
    setRequiredErrors((prev) => ({ ...prev, legalAddress: undefined }));
    fetchAddressSuggestions(value);
  };

  const handleAddressSelect = (s) => {
    const value = s?.value || "";
    setCompanyData((prev) => ({ ...(prev || {}), legalAddress: value }));
    setRequiredErrors((prev) => ({ ...prev, legalAddress: undefined }));
    setAddressSuggestions([]);
  };

  const hasValue = (v) => String(v ?? "").trim().length > 0;

  const isSaveDisabled = () => {
    if (!companyData) return true;
    const needKpp = /^\d{10}$/.test(String(companyData.inn || "").trim());

    return (
      !hasValue(companyData.name) ||
      !hasValue(companyData.inn) ||
      !hasValue(companyData.ogrn) ||
      !hasValue(companyData.legalAddress) ||
      !hasValue(companyData.phone) ||
      !hasValue(companyData.ceo_first_name) ||
      !hasValue(companyData.ceo_last_name) ||
      !hasValue(companyData.ceo_middle_name) ||
      (needKpp && !hasValue(companyData.kpp)) ||
      !hasValue(paymentData.account) ||
      !hasValue(paymentData.bik) ||
      !hasValue(paymentData.corrAccount) ||
      !hasValue(paymentData.bankName) ||
      !hasValue(paymentData.payment_details)
    );
  };

  const handleSaveCompany = async () => {
    if (!companyData) return;
    const nextRequiredErrors = {
      ...(hasValue(companyData.name) ? {} : { name: "Заполните данные анкеты" }),
      ...(hasValue(companyData.ogrn) ? {} : { ogrn: "Заполните данные анкеты" }),
      ...(hasValue(companyData.legalAddress) ? {} : { legalAddress: "Заполните данные анкеты" }),
      ...(hasValue(companyData.phone) ? {} : { phone: "Заполните данные анкеты" }),
      ...(hasValue(companyData.ceo_last_name) ? {} : { ceo_last_name: "Заполните данные анкеты" }),
      ...(hasValue(companyData.ceo_first_name) ? {} : { ceo_first_name: "Заполните данные анкеты" }),
      ...(hasValue(companyData.ceo_middle_name) ? {} : { ceo_middle_name: "Заполните данные анкеты" }),
      ...(!isCompanyEntity || hasValue(companyData.kpp) ? {} : { kpp: "Заполните данные анкеты" }),
      ...(hasValue(paymentData.account) ? {} : { account: "Заполните данные анкеты" }),
      ...(hasValue(paymentData.bik) ? {} : { bik: "Заполните данные анкеты" }),
      ...(hasValue(paymentData.corrAccount) ? {} : { corrAccount: "Заполните данные анкеты" }),
      ...(hasValue(paymentData.bankName) ? {} : { bankName: "Заполните данные анкеты" }),
      ...(hasValue(paymentData.payment_details) ? {} : { payment_details: "Заполните данные анкеты" }),
    };
    setRequiredErrors(nextRequiredErrors);
    if (Object.keys(nextRequiredErrors).length > 0 || isSaveDisabled()) {
      toast("Заполните все обязательные поля");
      return;
    }
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      const r = await fetch("/api/tbank/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: companyData.name,
          full_name: companyData.name,
          inn: companyData.inn,
          kpp: isCompanyEntity ? (companyData.kpp || "") : "",
          ogrn: companyData.ogrn,
          legalAddress: companyData.legalAddress,
          phone: companyData.phone,
          ceo_first_name: companyData.ceo_first_name,
          ceo_last_name: companyData.ceo_last_name,
          ceo_middle_name: companyData.ceo_middle_name,
          payment_account: paymentData.account,
          payment_bik: paymentData.bik,
          payment_corr_account: paymentData.corrAccount,
          bank_name: paymentData.bankName,
          payment_details: paymentData.payment_details,
          site_url: process.env.NEXT_PUBLIC_BASE_URL,
        }),
      });

      const reg = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(reg?.error || `HTTP ${r.status}`);

      const shopCode = reg?.shopCode || reg?.shop_code || "";
      const tbankCode = reg?.code || reg?.article || "";

      await supabase.from("mycompany").update({ is_active: false }).eq("user_id", user.id);

      const companyId = companyData.company_id || safeUUID();

      const payload = {
        user_id: user.id,
        company_id: companyId,
        name: companyData.name,
        inn: companyData.inn,
        kpp: isCompanyEntity ? (companyData.kpp || "") : "",
        ogrn: companyData.ogrn,
        ceo_first_name: companyData.ceo_first_name,
        ceo_last_name: companyData.ceo_last_name,
        ceo_middle_name: companyData.ceo_middle_name,
        legal_address: companyData.legalAddress,
        phone: companyData.phone,
        okveds: Array.isArray(companyData.okveds) ? companyData.okveds : [],
        status: companyData.status || "acting",
        tbank_registered: true,
        tbank_shop_code: shopCode ? String(shopCode) : null,
        tbank_code: tbankCode ? String(tbankCode) : null,
        site_url: process.env.NEXT_PUBLIC_BASE_URL,
        avatar_url: companyAvatarUrl || "/avatar-default.svg",
        payment_account: paymentData.account,
        payment_bik: paymentData.bik,
        payment_corr_account: paymentData.corrAccount,
        bank_name: paymentData.bankName,
        payment_details: paymentData.payment_details,
        is_active: true,
      };

      const { data: saved, error: saveError } = await supabase.from("mycompany").upsert(payload).select("*");
      if (saveError) throw saveError;

      await supabase
        .from("profiles")
        .update({ is_legal_entity: true, company_id: companyId })
        .eq("user_id", user.id);

      const normalizedSaved = saved?.[0] ? normalizeDBCompany(saved[0]) : { ...companyData, company_id: companyId };

      normalizedSaved.tbank_registered = true;
      normalizedSaved.tbank_shop_code = shopCode ? String(shopCode) : normalizedSaved.tbank_shop_code;
      normalizedSaved.tbank_code = tbankCode ? String(tbankCode) : normalizedSaved.tbank_code;
      normalizedSaved.company_id = companyId;

      setCompanyData(normalizedSaved);
      setIsSaved(true);
      setIsEditing(false);
      setShowInnInput(false);

      clearDraft();
      toast("Организация зарегистрирована в Т-Банке!");
    } catch (error) {
      console.error("[CompanySettingsMobile] save error:", error);
      toast(`Ошибка: ${error?.message || "не удалось сохранить"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ===== Создание чата под смену реквизитов: тип company_edit (с фолбэком)
  async function ensureSupportChatForChange() {
    if (!user || !supabase) return { chatId: null, existed: false };

    // ✅ если уже есть — не плодим дубли
    const existing = await checkExistingChangeChat();
    if (existing?.exists && existing?.chatId) {
      return { chatId: existing.chatId, existed: true };
    }

    const readableMsg = `[COMPANY_CHANGE_REQUEST] Пользователь хочет сменить реквизиты организации "${companyData?.name || ""}"`;

    // пробуем создать company_edit
    try {
      const { data: newChat, error: insErr } = await supabase
        .from("chats")
        .insert({
          title: TITLE_CHANGE,
          chat_type: "company_edit",
          is_group: false,
          // created_at НЕ задаём — пусть ставит сервер
        })
        .select("id")
        .single();

      if (insErr) throw insErr;

      // joined_at НЕ задаём — пусть ставит сервер
      await supabase.from("chat_participants").insert({ chat_id: newChat.id, user_id: user.id });

      // created_at НЕ задаём — пусть ставит сервер
      await supabase.from("chat_messages").insert({
        chat_id: newChat.id,
        user_id: user.id,
        content: readableMsg,
        read: false,
      });

      return { chatId: newChat.id, existed: false };
    } catch (e) {
      // Фолбэк: если check constraint ещё не обновлён — создадим support
      console.warn("[company_edit fallback to support]", e?.message || e);

      const { data: fallbackChat, error: fallbackErr } = await supabase
        .from("chats")
        .insert({
          title: TITLE_CHANGE,
          chat_type: "support",
          is_group: false,
        })
        .select("id")
        .single();

      if (fallbackErr) {
        console.error("[support fallback failed]", fallbackErr);
        return { chatId: null, existed: false };
      }

      await supabase.from("chat_participants").insert({ chat_id: fallbackChat.id, user_id: user.id });
      await supabase.from("chat_messages").insert({
        chat_id: fallbackChat.id,
        user_id: user.id,
        content: readableMsg,
        read: false,
      });

      return { chatId: fallbackChat.id, existed: false };
    }
  }

  const handleRetryInn = () => {
    clearDraft();

    setCompanyData(null);
    setInn("");
    setIsSaved(false);
    setIsEditing(false);
    setShowInnInput(true);
    setAddressSuggestions([]);
    setPaymentData({ account: "", bik: "", corrAccount: "", bankName: "", payment_details: "" });

    // сброс статуса запроса
    setChangeRequestSent(false);
    setExistingChangeChatId(null);
  };

  const changeBtnText = changeRequestSent
    ? "Запрос уже отправлен"
    : isCreatingChangeChat
      ? "Открываем чат…"
      : "Поменять реквизиты организации?";

  return (
    <div className={mobileStyles.container}>
      <div className={mobileStyles.avatarSection}>
        <AvatarEditorMobile
          user={user}
          avatarUrl={companyAvatarUrl}
          updateAvatarUrl={setCompanyAvatarUrl}
          supabase={supabase}
          type="company"
          canEditAvatar={!!companyData?.tbank_registered}
          blockedMessage="Аватар можно прикрепить после регистрации организации в Т-Банке. Сначала заполните данные и нажмите «Сохранить компанию»."
        />
      </div>

      {showInnInput && (
        <div className={mobileStyles.inputSection}>
          <span className={mobileStyles.sectionTitle}>Получить данные по ИНН</span>
          <input
            type="text"
            value={inn}
            onChange={(e) => setInn(e.target.value.replace(/\D/g, ""))}
            maxLength={12}
            placeholder="10 цифр (ООО) или 12 (ИП)"
            className={mobileStyles.input}
          />
          <button onClick={fetchCompanyData} className={mobileStyles.button} disabled={isPrefilling}>
            {isPrefilling ? "Получаем…" : "Получить данные"}
          </button>
        </div>
      )}

      {companyData && (
        <div>
          <div className={mobileStyles.inputSection}>
            <span className={mobileStyles.sectionTitle}>Данные организации</span>

            <div className={mobileStyles.inputGroup}>
              <label>Название</label>
              {isEditing ? (
                <input
                  value={companyData.name || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, name: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.name ? mobileStyles.errorInput : ""}`}
                />
              ) : (
                <input
                  value={companyData.name || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.name ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.name && <div className={mobileStyles.errorText}>{requiredErrors.name}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>ИНН</label>
              <input value={companyData.inn || ""} disabled className={mobileStyles.input} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }} />
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>ОГРН / ОГРНИП</label>
              {isEditing ? (
                <input
                  value={companyData.ogrn || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, ogrn: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, ogrn: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.ogrn ? mobileStyles.errorInput : ""}`}
                />
              ) : (
                <input
                  value={companyData.ogrn || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.ogrn ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.ogrn && <div className={mobileStyles.errorText}>{requiredErrors.ogrn}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>КПП</label>
              {isCompanyEntity ? (
                isEditing ? (
                  <input
                    value={companyData.kpp || ""}
                    onChange={(e) => {
                      setCompanyData({ ...companyData, kpp: e.target.value.replace(/\D/g, "") });
                      setRequiredErrors((prev) => ({ ...prev, kpp: undefined }));
                    }}
                    className={`${mobileStyles.input} ${requiredErrors.kpp ? mobileStyles.errorInput : ""}`}
                    maxLength={9}
                    placeholder="9 цифр"
                  />
                ) : (
                  <input
                    value={companyData.kpp || ""}
                    readOnly
                    className={`${mobileStyles.input} ${requiredErrors.kpp ? mobileStyles.errorInput : ""}`}
                    style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                  />
                )
              ) : (
                <span className={mobileStyles.mutedText}>Для ИП КПП не требуется</span>
              )}
              {requiredErrors.kpp && <div className={mobileStyles.errorText}>{requiredErrors.kpp}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Юридический адрес</label>
              {isEditing ? (
                <>
                  <input
                    value={companyData.legalAddress || ""}
                    onChange={handleAddressChange}
                    className={`${mobileStyles.input} ${requiredErrors.legalAddress ? mobileStyles.errorInput : ""}`}
                    placeholder="Город, улица, дом…"
                  />
                  {addressSuggestions?.length > 0 && (
                    <div className={mobileStyles.suggestions}>
                      {addressSuggestions.map((s) => (
                        <div
                          key={s.value}
                          className={mobileStyles.suggestionItem}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => handleAddressSelect(s)}
                        >
                          {s.value}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <textarea
                  value={companyData.legalAddress || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.legalAddress ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a", minHeight: 52 }}
                />
              )}
              {requiredErrors.legalAddress && <div className={mobileStyles.errorText}>{requiredErrors.legalAddress}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Телефон</label>
              {isEditing ? (
                <input
                  value={companyData.phone || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, phone: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, phone: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.phone ? mobileStyles.errorInput : ""}`}
                  placeholder="+7..."
                />
              ) : (
                <input
                  value={companyData.phone || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.phone ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.phone && <div className={mobileStyles.errorText}>{requiredErrors.phone}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Фамилия директора</label>
              {isEditing ? (
                <input
                  value={companyData.ceo_last_name || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, ceo_last_name: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, ceo_last_name: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.ceo_last_name ? mobileStyles.errorInput : ""}`}
                />
              ) : (
                <input
                  value={companyData.ceo_last_name || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.ceo_last_name ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.ceo_last_name && <div className={mobileStyles.errorText}>{requiredErrors.ceo_last_name}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Имя директора</label>
              {isEditing ? (
                <input
                  value={companyData.ceo_first_name || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, ceo_first_name: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, ceo_first_name: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.ceo_first_name ? mobileStyles.errorInput : ""}`}
                />
              ) : (
                <input
                  value={companyData.ceo_first_name || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.ceo_first_name ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.ceo_first_name && <div className={mobileStyles.errorText}>{requiredErrors.ceo_first_name}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Отчество директора</label>
              {isEditing ? (
                <input
                  value={companyData.ceo_middle_name || ""}
                  onChange={(e) => {
                    setCompanyData({ ...companyData, ceo_middle_name: e.target.value });
                    setRequiredErrors((prev) => ({ ...prev, ceo_middle_name: undefined }));
                  }}
                  className={`${mobileStyles.input} ${requiredErrors.ceo_middle_name ? mobileStyles.errorInput : ""}`}
                />
              ) : (
                <input
                  value={companyData.ceo_middle_name || ""}
                  readOnly
                  className={`${mobileStyles.input} ${requiredErrors.ceo_middle_name ? mobileStyles.errorInput : ""}`}
                  style={{ background: "#f8fafc", border: "1px solid #e2e8f0", color: "#0f172a" }}
                />
              )}
              {requiredErrors.ceo_middle_name && <div className={mobileStyles.errorText}>{requiredErrors.ceo_middle_name}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>ОКВЭДы</label>
              {Array.isArray(companyData.okveds) && companyData.okveds.length > 0 ? (
                <>
                  <div className={mobileStyles.okvedBox}>
                    {companyData.okveds.map((o) => (
                      <div key={`${o.code}-${o.name}`}>
                        {o.code} — {o.name}
                        {o.isMain ? " (основной)" : ""}
                      </div>
                    ))}
                  </div>

                  {companyData.okveds.some((o) => tourismOkveds.includes(o.code)) ? (
                    <div className={mobileStyles.okvedInfo}>В выписке найден туристический ОКВЭД ✅</div>
                  ) : (
                    <div className={mobileStyles.okvedInfo}>
                      Нет подходящих ОКВЭДов в выписке (или источник не вернул ОКВЭД).
                    </div>
                  )}
                </>
              ) : (
                <div className={mobileStyles.okvedInfo}>ОКВЭДы отсутствуют</div>
              )}
            </div>
          </div>

          <div className={mobileStyles.inputSection}>
            <span className={mobileStyles.sectionTitle}>Реквизиты для выплат</span>

            <div className={mobileStyles.inputGroup}>
              <label>Расчётный счёт</label>
              <input
                value={paymentData.account}
                onChange={(e) => {
                  setPaymentData({ ...paymentData, account: e.target.value });
                  setRequiredErrors((prev) => ({ ...prev, account: undefined }));
                }}
                disabled={!isEditing}
                className={`${mobileStyles.input} ${requiredErrors.account ? mobileStyles.errorInput : ""}`}
                placeholder="20 цифр"
              />
              {requiredErrors.account && <div className={mobileStyles.errorText}>{requiredErrors.account}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>БИК</label>
              <input
                value={paymentData.bik}
                onChange={(e) => {
                  setPaymentData({ ...paymentData, bik: e.target.value });
                  setRequiredErrors((prev) => ({ ...prev, bik: undefined }));
                }}
                disabled={!isEditing}
                className={`${mobileStyles.input} ${requiredErrors.bik ? mobileStyles.errorInput : ""}`}
                placeholder="9 цифр"
              />
              {requiredErrors.bik && <div className={mobileStyles.errorText}>{requiredErrors.bik}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Кор. счёт</label>
              <input
                value={paymentData.corrAccount}
                onChange={(e) => {
                  setPaymentData({ ...paymentData, corrAccount: e.target.value });
                  setRequiredErrors((prev) => ({ ...prev, corrAccount: undefined }));
                }}
                disabled={!isEditing}
                className={`${mobileStyles.input} ${requiredErrors.corrAccount ? mobileStyles.errorInput : ""}`}
                placeholder="20 цифр"
              />
              {requiredErrors.corrAccount && <div className={mobileStyles.errorText}>{requiredErrors.corrAccount}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Название банка</label>
              <input
                value={paymentData.bankName}
                onChange={(e) => {
                  setPaymentData({ ...paymentData, bankName: e.target.value });
                  setRequiredErrors((prev) => ({ ...prev, bankName: undefined }));
                }}
                disabled={!isEditing}
                className={`${mobileStyles.input} ${requiredErrors.bankName ? mobileStyles.errorInput : ""}`}
                placeholder="Т-Банк…"
              />
              {requiredErrors.bankName && <div className={mobileStyles.errorText}>{requiredErrors.bankName}</div>}
            </div>

            <div className={mobileStyles.inputGroup}>
              <label>Назначение платежа</label>
              <textarea
                value={paymentData.payment_details}
                onChange={(e) => {
                  setPaymentData({ ...paymentData, payment_details: e.target.value });
                  setRequiredErrors((prev) => ({ ...prev, payment_details: undefined }));
                }}
                disabled={!isEditing}
                className={`${mobileStyles.input} ${requiredErrors.payment_details ? mobileStyles.errorInput : ""}`}
                placeholder="Перевод средств по договору…"
              />
              {requiredErrors.payment_details && <div className={mobileStyles.errorText}>{requiredErrors.payment_details}</div>}
            </div>
          </div>

          <div className={mobileStyles.buttonSection}>
            {!isSaved && (
              <label className={mobileStyles.editToggle}>
                <input type="checkbox" checked={isEditing} onChange={() => setIsEditing((v) => !v)} />
                Редактировать
              </label>
            )}

            {!isSaved ? (
              <button
                onClick={handleSaveCompany}
                disabled={isSubmitting}
                className={mobileStyles.button}
                title="Сохранить компанию"
              >
                {isSubmitting ? "Сохранение…" : "Сохранить и зарегистрировать"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (changeRequestSent) {
                      toast("Запрос уже отправлен. Откройте чат в «Сообщения → Поддержка».", 3500);
                      return;
                    }
                    setAskChangeOpen(true);
                  }}
                  className={mobileStyles.button}
                  disabled={isCreatingChangeChat || changeRequestSent}
                  style={changeRequestSent ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                >
                  {changeBtnText}
                </button>

                {changeRequestSent && (
                  <div className={mobileStyles.okvedInfo} style={{ marginTop: 8 }}>
                    Запрос уже отправлен{existingChangeChatId ? "" : ""}. Откройте чат в «Сообщения → Поддержка».
                  </div>
                )}
              </>
            )}

            {companyData && (
              <button
                onClick={handleRetryInn}
                className={mobileStyles.retryButton}
                type="button"
                disabled={isSubmitting || isCreatingChangeChat}
              >
                Новый ИНН
              </button>
            )}

            {isSaved && (
              <div className={mobileStyles.verificationSection}>
                <span className={mobileStyles.sectionTitle}>Статус регистрации</span>
                {companyData.tbank_registered ? (
                  <p className={`${mobileStyles.statusText} ${mobileStyles.success}`}>Компания зарегистрирована в Т-Банке</p>
                ) : (
                  <p className={mobileStyles.statusText}>Сохраните данные для регистрации в Т-Банке</p>
                )}
              </div>
            )}
          </div>

          {message && <div className={mobileStyles.toast}>{message}</div>}
        </div>
      )}

      {/* Диалог: подтверждение создания чата */}
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
            padding: 12,
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
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Поменять реквизиты организации?</div>
            <div style={{ marginBottom: 12, opacity: 0.85 }}>
              Будет создан чат в разделе «Сообщения → Поддержка» с названием «Смена реквизитов организации».
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setAskChangeOpen(false)}
                className={mobileStyles.retryButton}
                disabled={isCreatingChangeChat}
              >
                Нет
              </button>
              <button
                type="button"
                onClick={async () => {
                  setAskChangeOpen(false);
                  if (isCreatingChangeChat) return;

                  setIsCreatingChangeChat(true);
                  try {
                    const res = await ensureSupportChatForChange();
                    if (!res?.chatId) {
                      toast("Не удалось создать чат поддержки", 3000);
                      return;
                    }

                    // ✅ фиксируем, что запрос уже отправлен (и не даём повторять)
                    setChangeRequestSent(true);
                    setExistingChangeChatId(res.chatId);

                    if (res.existed) {
                      toast("Запрос уже отправлен. Откройте чат в «Сообщения → Поддержка».", 3500);
                    } else {
                      toast("Запрос отправлен в поддержку", 2500);
                    }
                  } finally {
                    setIsCreatingChangeChat(false);
                  }
                }}
                className={mobileStyles.button}
                disabled={isCreatingChangeChat}
              >
                {isCreatingChangeChat ? "Создаём…" : "Да"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CompanySettingsMobile;
