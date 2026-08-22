import { describe, expect, it } from 'vitest';
import {
  LISTING_QUOTES_ROUTE,
  QUOTE_ROUTE,
  QUOTE_VALIDITY_MINUTES,
  RENTAL_UNITS,
  RENTAL_UNIT_DAYS,
  WEEKEND_START_WEEKDAY,
  listingQuotesPath,
  parseQuoteLineItems,
  parseQuoteRequest,
  parseRentalQuote,
  quotePath,
} from './quotes.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

const A_REQUEST = {
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  postcode: 'bs7 8aa',
};

const A_QUOTE = {
  id: 'quote-1',
  listingId: 'listing-1',
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  days: 3,
  postcode: 'BS7 8AA',
  lineItems: [{ unit: 'day', count: 3, unitPrice: gbp(1_800), subtotal: gbp(5_400) }],
  itemCharge: gbp(5_400),
  renterFee: gbp(432),
  minimumFeeApplied: false,
  total: gbp(5_832),
  appliedExcess: { amount: gbp(7_500), boundBy: 'floor' as const },
  expiresAt: '2026-08-20T09:30:00.000Z',
};

describe('the quote routes', () => {
  it('builds the paths the routes declare', () => {
    expect(listingQuotesPath('listing-1')).toBe('/listings/listing-1/quotes');
    expect(quotePath('quote-1')).toBe('/quotes/quote-1');
  });

  it('keeps the templates and the builders in step', () => {
    // The pair that goes wrong silently: a builder minting a path no controller
    // has registered answers 404 and looks like a missing row.
    expect(LISTING_QUOTES_ROUTE).toBe('/listings/:id/quotes');
    expect(QUOTE_ROUTE).toBe('/quotes/:quoteId');
  });
});

describe('the rate units', () => {
  it('gives every unit a day count', () => {
    // A unit with no length is one the engine cannot use to cover a period.
    for (const unit of RENTAL_UNITS) {
      expect(RENTAL_UNIT_DAYS[unit]).toBeGreaterThan(0);
    }
  });

  it('treats a weekend as three days, not two', () => {
    // §8.5.2 names a weekend separately from a two-day daily charge precisely
    // because it is not one: Friday to Sunday.
    expect(RENTAL_UNIT_DAYS.weekend).toBe(3);
    expect(RENTAL_UNIT_DAYS.week).toBe(7);
  });

  it('anchors the weekend rate to Friday in ISO numbering', () => {
    // 1 is Monday, as `Time.weekdayOf` has it — so 5 is Friday. Getting this
    // wrong would apply weekend pricing to a Tuesday.
    expect(WEEKEND_START_WEEKDAY).toBe(5);
  });

  it('holds a price for long enough to act on and not longer', () => {
    expect(QUOTE_VALIDITY_MINUTES).toBe(30);
  });
});

describe('parseQuoteRequest', () => {
  it('accepts dates and a postcode, normalising the postcode', () => {
    const request = parseQuoteRequest(A_REQUEST);

    expect(request.postcode).toBe('BS7 8AA');
    expect(request.startDate).toBe('2026-08-21');
  });

  it('accepts a single-day hire', () => {
    // The end is inclusive, so the same day twice is one day — not an error.
    expect(() =>
      parseQuoteRequest({ ...A_REQUEST, endDate: A_REQUEST.startDate }),
    ).not.toThrow();
  });

  it('refuses a last day before the first', () => {
    expect(() => parseQuoteRequest({ ...A_REQUEST, endDate: '2026-08-20' })).toThrow(
      /cannot fall before/i,
    );
  });

  it('refuses a date that is not a date', () => {
    // The schema validates with the same function that later converts, so a
    // date it accepts cannot throw on conversion.
    expect(() => parseQuoteRequest({ ...A_REQUEST, startDate: '2026-02-30' })).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('refuses a missing postcode, because §8.5.2 makes it an input', () => {
    expect(() =>
      parseQuoteRequest({ startDate: '2026-08-21', endDate: '2026-08-23' }),
    ).toThrow();
  });

  it('refuses a postcode that is not one', () => {
    expect(() => parseQuoteRequest({ ...A_REQUEST, postcode: 'nowhere' })).toThrow(
      /valid UK postcode/i,
    );
  });
});

describe('parseRentalQuote', () => {
  it('accepts the projection the API sends', () => {
    expect(() => parseRentalQuote(A_QUOTE)).not.toThrow();
  });

  it('refuses an unexpected field, so an instant cannot reach a page', () => {
    // The reason it is a `strictObject`: 4.3b settled that a date a person chose
    // becomes an instant on the server, and a `startAt` on this projection is
    // one a browser would render in the device's timezone.
    expect(() =>
      parseRentalQuote({ ...A_QUOTE, startAt: '2026-08-20T23:00:00Z' }),
    ).toThrow();
  });

  it('refuses a quote with no line items, because it could not be explained', () => {
    expect(() => parseRentalQuote({ ...A_QUOTE, lineItems: [] })).toThrow();
  });

  it('refuses a hire of no days', () => {
    expect(() => parseRentalQuote({ ...A_QUOTE, days: 0 })).toThrow();
  });
});

describe('parseQuoteLineItems', () => {
  it('reads back what was stored in the jsonb column', () => {
    const items = parseQuoteLineItems(A_QUOTE.lineItems);

    expect(items).toHaveLength(1);
    expect(items[0]?.unit).toBe('day');
  });

  it('names its subject, so a drifted row says which one it is', () => {
    expect(() =>
      parseQuoteLineItems([{ unit: 'fortnight' }], 'the line items on quote q1'),
    ).toThrow(/the line items on quote q1/);
  });

  it('refuses an empty array and a non-array', () => {
    expect(() => parseQuoteLineItems([])).toThrow();
    expect(() => parseQuoteLineItems({ unit: 'day' })).toThrow();
  });

  it('refuses a unit the engine does not price', () => {
    expect(() =>
      parseQuoteLineItems([
        { unit: 'hour', count: 1, unitPrice: gbp(100), subtotal: gbp(100) },
      ]),
    ).toThrow();
  });

  it('refuses a count of zero', () => {
    expect(() =>
      parseQuoteLineItems([
        { unit: 'day', count: 0, unitPrice: gbp(100), subtotal: gbp(0) },
      ]),
    ).toThrow();
  });
});
