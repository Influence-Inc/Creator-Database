import {
  normalizeCurrency,
  normalizeEmail,
  normalizeInstagram,
  normalizeName,
  parseDateLoose,
  parseNumericLoose,
  toBoundedInt,
  toNonNegativeFloat,
} from './normalize';

describe('normalize utils', () => {
  describe('parseNumericLoose', () => {
    it('expands shorthand suffixes', () => {
      expect(parseNumericLoose('40k')).toBe(40_000);
      expect(parseNumericLoose('2M')).toBe(2_000_000);
      expect(parseNumericLoose('1.2m')).toBe(1_200_000);
      expect(parseNumericLoose('3b')).toBe(3_000_000_000);
    });

    it('strips currency symbols and commas', () => {
      expect(parseNumericLoose('$40,000')).toBe(40_000);
      expect(parseNumericLoose('£1,250')).toBe(1_250);
    });

    it('passes through plain numbers', () => {
      expect(parseNumericLoose(40_000)).toBe(40_000);
      expect(parseNumericLoose('500')).toBe(500);
    });

    it('returns null for junk', () => {
      expect(parseNumericLoose('abc')).toBeNull();
      expect(parseNumericLoose(null)).toBeNull();
      expect(parseNumericLoose(undefined)).toBeNull();
    });
  });

  describe('toBoundedInt', () => {
    it('rounds and bounds to postgres int range', () => {
      expect(toBoundedInt('2M')).toBe(2_000_000);
      expect(toBoundedInt('1.6')).toBe(2);
      expect(toBoundedInt('-5')).toBeNull();
      expect(toBoundedInt('9999999999')).toBeNull();
    });
  });

  describe('toNonNegativeFloat', () => {
    it('accepts non-negative values, rejects negatives', () => {
      expect(toNonNegativeFloat('40k')).toBe(40_000);
      expect(toNonNegativeFloat(15.5)).toBe(15.5);
      expect(toNonNegativeFloat('-1')).toBeNull();
    });
  });

  describe('normalizeEmail', () => {
    it('lowercases and trims valid emails', () => {
      expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com');
    });
    it('rejects invalid emails', () => {
      expect(normalizeEmail('not-an-email')).toBeNull();
      expect(normalizeEmail('')).toBeNull();
      expect(normalizeEmail(123)).toBeNull();
    });
  });

  describe('normalizeInstagram', () => {
    it('strips @ and lowercases', () => {
      expect(normalizeInstagram('@JaneDoe')).toBe('janedoe');
    });
    it('extracts the handle from a profile URL', () => {
      expect(normalizeInstagram('https://instagram.com/jane.doe/')).toBe('jane.doe');
    });
    it('rejects invalid handles', () => {
      expect(normalizeInstagram('has spaces')).toBeNull();
    });
  });

  describe('normalizeName', () => {
    it('collapses whitespace', () => {
      expect(normalizeName('  Jane   Doe ')).toBe('Jane Doe');
      expect(normalizeName('')).toBeNull();
    });
  });

  describe('normalizeCurrency', () => {
    it('upper-cases valid ISO codes', () => {
      expect(normalizeCurrency('usd')).toBe('USD');
      expect(normalizeCurrency('gbp')).toBe('GBP');
    });
    it('rejects non-3-letter codes', () => {
      expect(normalizeCurrency('dollars')).toBeNull();
    });
  });

  describe('parseDateLoose', () => {
    it('parses ISO dates', () => {
      const d = parseDateLoose('2026-07-18');
      expect(d?.getUTCFullYear()).toBe(2026);
      expect(d?.getUTCMonth()).toBe(6); // July (0-indexed)
    });

    it('parses partial dates against a reference "now"', () => {
      const now = new Date('2026-07-01T00:00:00Z');
      const d = parseDateLoose('July 18', now);
      expect(d?.getMonth()).toBe(6);
      expect(d?.getDate()).toBe(18);
      expect(d?.getFullYear()).toBe(2026);
    });

    it('rolls a past partial date forward to next year', () => {
      const now = new Date('2026-12-01T00:00:00Z');
      const d = parseDateLoose('January 5', now);
      expect(d?.getFullYear()).toBe(2027);
    });

    it('returns null for junk', () => {
      expect(parseDateLoose('whenever')).toBeNull();
      expect(parseDateLoose(null)).toBeNull();
    });
  });
});
