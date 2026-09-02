/**
 * Fixed-point money: NUMERIC(28,8) modeled as bigint scaled by 10^8.
 *
 * Float/DOUBLE for money is on the anti-patterns list — sub-cent errors
 * compound into dollars. Every amount crosses this module as a decimal
 * *string*; nothing here ever touches a float.
 */

export const SCALE = 10n ** 8n;
const SCALE_DECIMALS = 8;

const MONEY_RE = /^-?\d{1,20}(\.\d{1,8})?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Parse a decimal string into scaled bigint. Rejects floats and >8dp. */
export function parseAmount(input: string): bigint {
  if (typeof input !== 'string' || !MONEY_RE.test(input)) {
    throw new MoneyError(
      `invalid amount ${JSON.stringify(input)}: expected a decimal string with at most ${SCALE_DECIMALS} fraction digits`,
    );
  }
  const neg = input.startsWith('-');
  const body = neg ? input.slice(1) : input;
  const parts = body.split('.');
  const intPart = parts[0] ?? '0';
  const fracPart = parts[1] ?? '';
  const frac = fracPart.padEnd(SCALE_DECIMALS, '0');
  const value = BigInt(intPart) * SCALE + BigInt(frac || '0');
  return neg ? -value : value;
}

/** Render a scaled bigint back to a minimal decimal string. */
export function formatAmount(value: bigint): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(SCALE_DECIMALS, '0').replace(/0+$/, '');
  const s = fracPart ? `${intPart}.${fracPart}` : `${intPart}`;
  return neg ? `-${s}` : s;
}

export function addAmount(a: bigint, b: bigint): bigint {
  return a + b;
}

/** Sum signed amounts; used for the conservation check (Σ must equal 0). */
export function sumAmount(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function negateAmount(v: bigint): bigint {
  return -v;
}

/** Numeric comes back from pg as a string; normalize to scaled bigint. */
export function fromDbNumeric(raw: string): bigint {
  // pg may render '100.00000000' — parseAmount already accepts that,
  // but a trailing-zero-only fraction still passes the regex.
  return parseAmount(raw);
}

export function toDbNumeric(value: bigint): string {
  return formatAmount(value);
}
