export function normalizePhoneLoose(input: string) {
  let d = input.replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  if (d.length !== 11 || !d.startsWith('7')) return null;
  return d;
}
