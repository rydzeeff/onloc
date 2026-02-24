// pages/api/tbank/update.js
import { tbankPatchShopBankAccount, parseAddress } from './_client';

export const config = { api: { bodyParser: true } };

const DEBUG = String(process.env.TBANK_DEBUG || '').toLowerCase() === '1' || String(process.env.TBANK_DEBUG || '').toLowerCase() === 'true';
function dlog(...args) { if (DEBUG) console.log('[TBANK][update]', ...args); }

function digits(v = '') { return String(v || '').replace(/\D/g, ''); }
function isEmpty(v) { return v == null || String(v).trim() === ''; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    dlog('Incoming body:', JSON.stringify(req.body, null, 2));

    const {
      // идентификатор точки (из Т-Банк)
      shopCode,

      // банковские реквизиты
      payment_account,
      payment_bik,
      payment_corr_account,
      bank_name,
      payment_details,

      // прочие поля, которые пользователь мог менять
      name,
      inn,
      kpp,
      ogrn,
      legal_address,
      phone,
    } = req.body || {};

    const result = { success: true, shopCode, steps: {} };

    // --- базовые проверки shopCode ---
    if (isEmpty(shopCode)) {
      result.success = false;
      result.steps.general = {
        status: 'error',
        message: 'Не передан shopCode — невозможно синхронизировать с Т-Банк.',
      };
      return res.status(400).json(result);
    }
    if (!/^\d+$/.test(String(shopCode))) {
      result.success = false;
      result.steps.general = {
        status: 'error',
        message: 'shopCode должен быть числовым идентификатором точки Т-Банк.',
      };
      return res.status(400).json(result);
    }

    // --- попытка PATCH банковских реквизитов точки ---
    // Менять имеет смысл только если что-то передано
    const bankAccountPayload = {
      account: String(payment_account || '').trim(),
      korAccount: String(payment_corr_account || '').trim() || undefined,
      bankName: String(bank_name || '').trim(),
      bik: String(payment_bik || '').trim(),
      details: String(payment_details || '').trim(),
    };

    const anyBankField =
      bankAccountPayload.account ||
      bankAccountPayload.korAccount ||
      bankAccountPayload.bankName ||
      bankAccountPayload.bik ||
      bankAccountPayload.details;

    if (anyBankField) {
      // валидации, чтобы вернуть читабельные причины
      const bankErrors = [];
      if (bankAccountPayload.account && digits(bankAccountPayload.account).length !== 20) {
        bankErrors.push('Р/с некорректен — должно быть 20 цифр.');
      }
      if (bankAccountPayload.korAccount && digits(bankAccountPayload.korAccount).length !== 20) {
        bankErrors.push('К/с некорректен — должно быть 20 цифр.');
      }
      if (bankAccountPayload.bik && digits(bankAccountPayload.bik).length !== 9) {
        bankErrors.push('БИК некорректен — должно быть 9 цифр.');
      }
      if (bankErrors.length) {
        result.success = false;
        result.steps.bankAccount = {
          status: 'error',
          message: bankErrors.join(' '),
        };
      } else {
        try {
          dlog('PATCH bankAccount →', JSON.stringify(bankAccountPayload));
          const patchRes = await tbankPatchShopBankAccount(shopCode, bankAccountPayload);
          dlog('PATCH bankAccount ← ok');
          result.steps.bankAccount = {
            status: 'success',
            message: 'Банковские реквизиты обновлены в Т-Банк.',
            raw: patchRes,
          };
        } catch (e) {
          const status = e?.response?.status || 400;
          dlog('PATCH bankAccount ERROR status:', status);
          dlog('PATCH bankAccount ERROR body:', JSON.stringify(e?.response?.data || {}, null, 2));
          result.success = false;
          const bankApiMsg =
            e?.response?.data?.message ||
            e?.response?.data?.error ||
            e?.message ||
            'Ошибка обновления банковских реквизитов в Т-Банк';
          result.steps.bankAccount = {
            status: 'error',
            message: bankApiMsg,
            details: e?.response?.data || null,
          };
        }
      }
    } else {
      result.steps.bankAccount = {
        status: 'skipped',
        message: 'Банковские реквизиты не переданы — PATCH не выполнялся.',
      };
    }

    // --- Остальные поля (название, ИНН/КПП/ОГРН, телефон, юр.адрес) ---
    // По текущей спецификации sm-register PATCH меняет банковские реквизиты точки.
    // Обновление юр.данных (название/ИНН/адрес/телефон) недоступно через этот PATCH — нужна переоформление или другой процесс.
    // Поэтому возвращаем "skipped" с пояснением, чтобы фронт показал читаемо в чате.
    const readableSkip = 'Изменение этого поля не поддержано публичным PATCH для точки — сохранено на платформе ОНЛОК.';
    if (!isEmpty(name)) result.steps.name = { status: 'skipped', message: readableSkip };
    if (!isEmpty(inn)) {
      if (!/^\d{10,12}$/.test(digits(inn))) {
        result.success = false;
        result.steps.inn = { status: 'error', message: 'ИНН некорректен — 10 (для юр.лиц) или 12 (для ИП) цифр.' };
      } else {
        result.steps.inn = { status: 'skipped', message: readableSkip };
      }
    }
    if (!isEmpty(kpp)) {
      if (!/^\d{9}$/.test(digits(kpp))) {
        result.success = false;
        result.steps.kpp = { status: 'error', message: 'КПП некорректен — 9 цифр.' };
      } else {
        result.steps.kpp = { status: 'skipped', message: readableSkip };
      }
    }
    if (!isEmpty(ogrn)) {
      if (!/^\d{13,15}$/.test(digits(ogrn))) {
        result.success = false;
        result.steps.ogrn = { status: 'error', message: 'ОГРН/ОГРНИП некорректен — 13 или 15 цифр.' };
      } else {
        result.steps.ogrn = { status: 'skipped', message: readableSkip };
      }
    }
    if (!isEmpty(legal_address)) {
      // Можно попытаться распарсить адрес, но отправка в Т-Банк не реализована документированным PATCH
      try { parseAddress?.(String(legal_address)); } catch {}
      result.steps.legal_address = { status: 'skipped', message: readableSkip };
    }
    if (!isEmpty(phone)) {
      const ph = digits(phone);
      if (ph.length < 10) {
        result.success = false;
        result.steps.phone = { status: 'error', message: 'Телефон некорректен — укажите номер целиком.' };
      } else {
        result.steps.phone = { status: 'skipped', message: readableSkip };
      }
    }

    const httpCode = result.success ? 200 : 400;
    return res.status(httpCode).json(result);
  } catch (err) {
    const status = err?.response?.status || 400;
    dlog('ERROR status:', status);
    dlog('ERROR body:', JSON.stringify(err?.response?.data || {}, null, 2));
    return res.status(status).json({
      error: err?.message || 'Ошибка обновления в Т-Банк',
      details: err?.response?.data || null,
    });
  }
}
