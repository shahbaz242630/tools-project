import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * That every photograph is sized by its slot rather than by its own pixels
 * (slice 2.6c).
 *
 * **This file reads CSS text, which is a weak kind of test, and it exists
 * because the defect it guards is invisible to the strong kind.** jsdom computes
 * no layout: `getBoundingClientRect()` is all zeroes, `aspect-ratio` does
 * nothing, and a component test asserting `height="300"` is on the element
 * passes whether the card renders 4:3 or 263 × 300.
 *
 * The defect was real and was found by looking at `/browse` in a browser. Every
 * `<img>` here carries `width` and `height` attributes so the browser can
 * reserve space before the bytes arrive — and those attributes are
 * *presentational hints* that set CSS `width` and `height`. `width: 100%`
 * overrides one of them. Without `height: auto` the other stands, the element
 * keeps its intrinsic 300px, `aspect-ratio` is ignored, and a photographed card
 * is 100px taller than the one beside it.
 *
 * So this asserts the pair travels together. It cannot prove the layout is
 * right; it can stop somebody deleting the line that makes it right, which is
 * the failure that would otherwise ship unnoticed a second time.
 *
 * **`LESSONS.md`'s standing lesson, one layer along:** a green suite cannot see
 * a false sentence — and it cannot see a ragged grid either. Somebody has to
 * read the page.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every rule that sizes a photograph, and the file it lives in. */
const SIZED_PHOTOGRAPHS: readonly { file: string; selector: string }[] = [
  { file: 'browse.module.css', selector: '.cardPhoto' },
  { file: 'public-listing.module.css', selector: '.photo' },
  { file: 'listing-photographs.module.css', selector: '.image' },
];

/** The body of one rule, or null if the selector is not in the file. */
function ruleBody(css: string, selector: string): string | null {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return null;

  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (close === -1) return null;

  return css.slice(open + 1, close);
}

describe.each(SIZED_PHOTOGRAPHS)('$file $selector', ({ file, selector }) => {
  const css = readFileSync(path.join(HERE, file), 'utf8');
  const body = ruleBody(css, selector);

  it('exists — a renamed rule must not silently drop these guarantees', () => {
    expect(body).not.toBeNull();
  });

  it('sets height: auto, or the intrinsic height wins and aspect-ratio does nothing', () => {
    expect(body).toContain('height: auto');
  });

  it('states the shape of its slot rather than inheriting the file’s', () => {
    expect(body).toContain('aspect-ratio');
  });

  it('covers rather than stretches, so a portrait photograph is not distorted', () => {
    expect(body).toContain('object-fit: cover');
  });
});

describe('the thumbnail strip', () => {
  /*
   * The one exception, stated rather than left as an inconsistency. The strip's
   * thumbnails are a fixed 88 × 66 box — both dimensions given — so there is no
   * intrinsic height to override and no ratio to declare. `object-fit` still
   * matters, for the same reason it does everywhere else.
   */
  const css = readFileSync(path.join(HERE, 'public-listing.module.css'), 'utf8');
  const body = ruleBody(css, '.thumbnail');

  it('sizes both edges explicitly, so it needs no aspect-ratio', () => {
    expect(body).toContain('width:');
    expect(body).toContain('height:');
    expect(body).not.toContain('height: auto');
  });

  it('still covers rather than stretches', () => {
    expect(body).toContain('object-fit: cover');
  });
});
