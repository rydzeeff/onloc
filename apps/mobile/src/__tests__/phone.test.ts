import { normalizePhoneLoose } from '../lib/phone';

test('normalizes 10 digit russian phone', () => {
  expect(normalizePhoneLoose('9991234567')).toBe('79991234567');
});

test('normalizes 8 prefix', () => {
  expect(normalizePhoneLoose('8 (999) 123-45-67')).toBe('79991234567');
});

test('rejects invalid', () => {
  expect(normalizePhoneLoose('123')).toBeNull();
});
