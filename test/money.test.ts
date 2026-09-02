import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../src/money.js';

describe('money · fixed-point, never float', () => {
  it('parses plain and fractional amounts', () => {
    expect(parseAmount('100')).toBe(100_00000000n);
    expect(parseAmount('100.5')).toBe(100_50000000n);
    expect(parseAmount('-0.00000001')).toBe(-1n);
  });

  it('rejects >8 decimal places (would silently truncate)', () => {
    expect(() => parseAmount('0.000000001')).toThrow();
  });

  it('rejects scientific notation and non-strings', () => {
    expect(() => parseAmount('1e3')).toThrow();
    expect(() => parseAmount('NaN')).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => parseAmount(100 as any)).toThrow();
  });

  it('round-trips through formatting', () => {
    for (const s of ['0.5', '-123456789.98765432', '1000000', '-0.00000001']) {
      expect(formatAmount(parseAmount(s))).toBe(s.replace(/(\..*?)0+$/, '$1').replace(/\.$/, ''));
    }
  });

  it('sums signed bigints exactly (Σ of the §4 example is 0)', () => {
    const lines = ['-10000', '9850', '150'].map(parseAmount);
    const sum = lines.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(0n);
  });
});
