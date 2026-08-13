import { describe, expect, it } from 'vitest';
import { GATE_COUNT, parseArguments } from './search-load-options.mjs';

/**
 * The pure half of the load generator.
 *
 * `scripts/` sits outside the coverage thresholds deliberately (see
 * `vitest.config.ts`), and the way that is paid for is this: the logic that can
 * be tested without Docker is tested, and the parts that drive Docker are
 * covered by running them.
 *
 * **The guard is what matters here.** The generator writes tens of thousands of
 * rows, and the only thing between it and a database somebody cares about is
 * the allowlist this exercises.
 */
describe('which database the load generator will touch', () => {
  it('defaults to the local development database', () => {
    expect(parseArguments(['--count', '10']).database).toBe('rental_dev');
  });

  it('allows the test database, which the integration suite uses', () => {
    expect(
      parseArguments(['--database', 'rental_test', '--count', '10']).database,
    ).toBe('rental_test');
  });

  it.each(['neondb', 'rental_production', 'postgres', 'rental_staging'])(
    'refuses %s',
    (database) => {
      expect(() => parseArguments(['--database', database])).toThrow(
        /Refusing to touch/,
      );
    },
  );

  it('says what it would have done, so the refusal is not cryptic', () => {
    expect(() => parseArguments(['--database', 'neondb'])).toThrow(
      /tens of thousands of fake rows/,
    );
  });
});

describe('how many rows it will write', () => {
  it('defaults to the count the exit gate asks about', () => {
    expect(parseArguments([]).count).toBe(GATE_COUNT);
  });

  it('takes a count', () => {
    expect(parseArguments(['--count', '1000']).count).toBe(1_000);
  });

  it.each(['0', '-5', 'lots', '1.5'])('refuses %s', (count) => {
    expect(() => parseArguments(['--count', count])).toThrow(/positive whole number/);
  });

  it('refuses a count that would measure the machine rather than the query', () => {
    expect(() => parseArguments(['--count', '5000000'])).toThrow(
      /beyond what this is for/,
    );
  });

  it('needs no count when cleaning', () => {
    // Demanding one would make the tidy-up harder to run than the thing it
    // tidies up after.
    expect(parseArguments(['--clean']).clean).toBe(true);
  });
});
