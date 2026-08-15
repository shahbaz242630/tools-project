import { Controller, Get, Inject } from '@nestjs/common';
import { PUBLIC_CATEGORIES_ROUTE } from '@platform/contracts';
import type { PublicCategory } from '@platform/contracts';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import type { ListingsService } from './listings.service.js';

/**
 * The categories anybody may narrow a search to (slice 3.2b).
 *
 * **A third unguarded controller, and its own file for the reason the second one
 * gives inverted.** An unguarded route among guarded ones reads as an oversight,
 * so unguarded routes get their own class — and two unguarded *routes* in one
 * class would make the next addition a decision nobody notices making. One
 * public surface per file keeps the count visible, and the count is now three.
 *
 * **Why this exists at all rather than reusing `/categories`.** That route sits
 * behind `AuthGuard`, and Browse is the page a signed-out stranger meets first —
 * so the filter would have been a control that works only once you have an
 * account, which is the same dead control BRD §15 forbids wearing a login
 * prompt. It also answers a different question: an owner filling in a form needs
 * the attribute schema and the transport options, and a searcher needs a name.
 *
 * **What makes it safe to publish is what is on the shape, not this class.**
 * `PublicCategory` is a slug and a name — the slug is already in every listing
 * URL and the name is already rendered on every listing card, so this discloses
 * nothing that a crawler could not assemble from the listings themselves. The
 * risk level and the reportable-activity flag are administrative configuration
 * (ADR 0028) and are absent from the type, not filtered out by this class.
 *
 * **It returns no counts, deliberately.** A category with a listing count beside
 * it would tell anybody who asked exactly how thin our supply is, per category,
 * updated live — which is BRD §17's dominant risk published as an endpoint. The
 * control needs a name and a value; it does not need to say how empty we are.
 *
 * **It is a collection with no caller-supplied input**, which makes it cheaper to
 * serve than the search beside it but no less enumerable. It joins the same
 * rate-limiting list as `/public/listings` the moment one exists
 * (`SECURITY.md`), and the honest statement of today's mitigation is still that
 * no domain points at us.
 */
@Controller()
export class PublicCategoriesController {
  constructor(@Inject(LISTINGS_SERVICE) private readonly listings: ListingsService) {}

  @Get(PUBLIC_CATEGORIES_ROUTE)
  async categories(): Promise<{ readonly categories: readonly PublicCategory[] }> {
    return { categories: await this.listings.publicCategories() };
  }
}
