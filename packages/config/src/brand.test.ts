import { describe, expect, it } from 'vitest';
import {
  BRAND,
  BRAND_PLACEHOLDER,
  BrandNotConfiguredError,
  assertBrandConfigured,
  isBrandPlaceholder,
  type Brand,
} from './brand.js';

describe('brand configuration', () => {
  it('is still on the placeholder — expected until the name is chosen', () => {
    // This test is a reminder, not a failure. When the name is decided, update
    // BRAND and this expectation flips to false in the same commit.
    expect(isBrandPlaceholder(BRAND)).toBe(true);
  });

  it('refuses to start production while unnamed', () => {
    expect(() => assertBrandConfigured(BRAND)).toThrow(BrandNotConfiguredError);
  });

  it('reports every missing field, not just the first', () => {
    try {
      assertBrandConfigured(BRAND);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('name');
      expect(message).toContain('legalEntity');
      expect(message).toContain('domain');
      expect(message).toContain('supportEmail');
    }
  });

  it('passes once every field is set', () => {
    const configured: Brand = {
      name: 'Example',
      legalEntity: 'Example Ltd',
      domain: 'example.co.uk',
      supportEmail: 'help@example.co.uk',
    };
    expect(() => assertBrandConfigured(configured)).not.toThrow();
    expect(isBrandPlaceholder(configured)).toBe(false);
  });

  it('treats the placeholder name as unconfigured even if other fields are set', () => {
    const halfDone: Brand = {
      name: BRAND_PLACEHOLDER,
      legalEntity: 'Example Ltd',
      domain: 'example.co.uk',
      supportEmail: 'help@example.co.uk',
    };
    expect(() => assertBrandConfigured(halfDone)).toThrow(/name/);
  });
});
