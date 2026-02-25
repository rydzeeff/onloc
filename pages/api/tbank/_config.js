const warned = new Set();

const mask = (value, left = 4, right = 4) => {
  if (!value) return '(empty)';
  const str = String(value);
  if (str.length <= left + right) return `${str[0] || '*'}***${str[str.length - 1] || '*'}`;
  return `${str.slice(0, left)}…${str.slice(-right)}`;
};

const warnOnce = (key, message, extra = {}) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[TBANK][config] ${message}`, extra);
};

const stripTrailingSlashes = (url = '') => String(url || '').trim().replace(/\/+$/, '');

const stripE2C = (tk = '') => String(tk || '').replace(/E2C$/i, '');
const ensureE2C = (tk = '') => {
  const base = stripE2C(tk);
  return base ? `${base}E2C` : '';
};

const TEST_API_BASE = 'https://rest-api-test.tinkoff.ru';
const PROD_API_BASE = 'https://securepay.tinkoff.ru';

function deriveFromRestBase(restBase) {
  const base = stripTrailingSlashes(restBase || TEST_API_BASE);
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return '';
    }
  })();

  const isTest = host.includes('rest-api-test.tinkoff.ru');
  return {
    formBase: isTest ? 'https://securepayments-test.tcsbank.ru' : 'https://securepay.tinkoff.ru',
    partnerApiBase: isTest ? 'https://acqapi-test.tinkoff.ru' : 'https://acqapi.tinkoff.ru',
  };
}

export function getTbankConfig() {
  const env = process.env;

  if (env.TBANK_ENV) {
    warnOnce('TBANK_ENV', 'TBANK_ENV is deprecated. Use TBANK_API_BASE as single environment selector.', {
      TBANK_ENV: env.TBANK_ENV,
    });
  }
  if (env.TBANK_E2C_BASE) {
    warnOnce('TBANK_E2C_BASE', 'TBANK_E2C_BASE is deprecated. Use TBANK_API_BASE and derived a2cBaseV2.', {
      TBANK_E2C_BASE: stripTrailingSlashes(env.TBANK_E2C_BASE),
    });
  }
  if (env.TBANK_PASSWORD) {
    warnOnce('TBANK_PASSWORD', 'TBANK_PASSWORD is deprecated alias. Use TBANK_SECRET.', {
      TBANK_PASSWORD: mask(env.TBANK_PASSWORD),
    });
  }

  const restBase = stripTrailingSlashes(
    env.TBANK_API_BASE ||
      env.TBANK_BASE ||
      (env.TBANK_ENV === 'production' ? PROD_API_BASE : TEST_API_BASE)
  );

  const derived = deriveFromRestBase(restBase);

  const formBase = stripTrailingSlashes(env.TBANK_FORM_BASE || derived.formBase);
  const partnerApiBase = stripTrailingSlashes(env.TBANK_PARTNER_API_BASE || env.TBANK_BASE_URL || derived.partnerApiBase);

  const terminalSecret = env.TBANK_SECRET || env.TBANK_PASSWORD || '';
  if (env.TBANK_SECRET && env.TBANK_PASSWORD && env.TBANK_SECRET !== env.TBANK_PASSWORD) {
    warnOnce('TBANK_SECRET_MISMATCH', 'TBANK_SECRET and TBANK_PASSWORD differ. Using TBANK_SECRET.', {
      TBANK_SECRET: mask(env.TBANK_SECRET),
      TBANK_PASSWORD: mask(env.TBANK_PASSWORD),
    });
  }

  const terminalKeyBase = env.TBANK_TERMINAL_KEY || '';

  return {
    restBase,
    eacqBaseV2: `${restBase}/v2`,
    a2cBaseV2:
      stripTrailingSlashes(env.TBANK_E2C_BASE) ||
      `${restBase}/e2c/v2`,
    formBase,
    partnerApiBase,
    terminalSecret,
    terminalKeyBase,
    stripE2C,
    ensureE2C,
    terminalKeyEacq: stripE2C(terminalKeyBase),
    terminalKeyA2c: ensureE2C(terminalKeyBase),
  };
}
