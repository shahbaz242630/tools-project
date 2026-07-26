/**
 * Brand identity.
 *
 * The trading name is deliberately confined to this file. No package name, no
 * import path, no class name and no copy string anywhere else in the codebase
 * refers to the brand — so choosing (or later changing) the name is an edit
 * here plus a DNS record, not a refactor.
 *
 * The name is still being decided. `assertBrandConfigured` makes it impossible
 * to reach production while the placeholder is in place.
 */

export const BRAND_PLACEHOLDER = 'Rental Marketplace (unnamed)';

export interface Brand {
  /** Trading name shown to users. */
  readonly name: string;
  /** Registered company name, once incorporated. Required for consumer terms. */
  readonly legalEntity: string | null;
  /** Primary domain, without protocol. */
  readonly domain: string | null;
  /** Address consumers can reach a human on. Required before public launch. */
  readonly supportEmail: string | null;
}

export const BRAND: Brand = {
  name: BRAND_PLACEHOLDER,
  legalEntity: null,
  domain: null,
  supportEmail: null,
};

export class BrandNotConfiguredError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Brand is not configured for production. Missing or placeholder: ` +
        `${missing.join(', ')}. Set these in packages/config/src/brand.ts.`,
    );
    this.name = 'BrandNotConfiguredError';
  }
}

export function isBrandPlaceholder(brand: Brand = BRAND): boolean {
  return brand.name === BRAND_PLACEHOLDER;
}

/**
 * Fails fast when the brand is incomplete. Called during production startup
 * so an unnamed build cannot serve traffic.
 */
export function assertBrandConfigured(brand: Brand = BRAND): void {
  const missing: string[] = [];
  if (isBrandPlaceholder(brand)) missing.push('name');
  if (!brand.legalEntity) missing.push('legalEntity');
  if (!brand.domain) missing.push('domain');
  if (!brand.supportEmail) missing.push('supportEmail');

  if (missing.length > 0) {
    throw new BrandNotConfiguredError(missing);
  }
}
