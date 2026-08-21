import { describe, expect, it, vi } from 'vitest';
import { Time } from '@platform/core';
import { createRecordingLogger } from '@platform/observability/testing';
import type { PaymentIntentRecord, PaymentIntentStatus } from './payment-intent.js';
import { ReconciliationService } from './reconciliation.service.js';
import type { PaymentRefresher } from './reconciliation.service.js';
import { FakePaymentIntentStore } from './testing/fakes.js';

/**
 * The reconciliation sweep (§8.7, §14's *daily reconciliation job* — slice 5.4a).
 *
 * **What is worth testing here is the sorting of outcomes, not the arithmetic.**
 * There is none: the sweep decides which attempts to look at, what to do with each,
 * and which number to report it under — and the number that matters is
 * `unreconcilable`, because it is the one that means *money may have moved and we
 * cannot find it*.
 */

const NOW = Time.fromIsoUtc('2026-08-21T12:00:00.000Z');
const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

let sequence = 0;

/** An attempt as it already stands, which is what a sweep meets. */
function attempt(
  over: Partial<PaymentIntentRecord> & { readonly minutesSinceUpdate: number },
): PaymentIntentRecord {
  sequence += 1;
  const updatedAt = Time.addMinutes(NOW, -over.minutesSinceUpdate);

  return {
    id: `intent-${String(sequence)}`,
    bookingId: `booking-${String(sequence)}`,
    ownerId: 'user-owner',
    categoryVersionId: 'version-1',
    purpose: 'hire_charge',
    attemptKey: `key-${String(sequence)}`,
    status: 'processing' as PaymentIntentStatus,
    provider: 'fake',
    providerReference: `pi_${String(sequence)}`,
    itemCharge: gbp(5_000),
    renterFee: gbp(400),
    amount: gbp(5_400),
    createdAt: updatedAt,
    updatedAt,
    ...over,
  };
}

function sweepOver(
  rows: readonly PaymentIntentRecord[],
  refresh: PaymentRefresher['refresh'] = (id) =>
    Promise.resolve(rows.find((row) => row.id === id) ?? null),
) {
  const intents = new FakePaymentIntentStore();
  for (const row of rows) intents.given(row);

  const recording = createRecordingLogger();
  const service = new ReconciliationService(
    intents,
    { refresh },
    recording.logger,
    () => NOW,
  );

  return { service, recording };
}

describe('which attempts it looks at', () => {
  it('ignores an attempt that changed recently', () => {
    // A payment in progress is not stuck. Sweeping it would spend a provider call
    // to be told what we already knew, on every payment in flight.
    const fresh = attempt({ minutesSinceUpdate: 1 });

    return sweepOver([fresh])
      .service.sweep()
      .then((result) => {
        expect(result.examined).toBe(0);
      });
  });

  it('looks at one that has not changed for longer than the threshold', async () => {
    const stale = attempt({ minutesSinceUpdate: 30 });

    const result = await sweepOver([stale]).service.sweep();

    expect(result.examined).toBe(1);
  });

  /**
   * **Terminal attempts are excluded by the store's query.** Every payment ever
   * taken is `succeeded`, so a sweep that pulled them back to discard them would
   * grow more expensive with every booking the platform ever completes.
   */
  it('never looks at an attempt that has already settled', async () => {
    const result = await sweepOver([
      attempt({ minutesSinceUpdate: 300, status: 'succeeded' }),
      attempt({ minutesSinceUpdate: 300, status: 'failed' }),
    ]).service.sweep();

    expect(result.examined).toBe(0);
  });

  it('looks at every non-terminal status', async () => {
    const result = await sweepOver([
      attempt({ minutesSinceUpdate: 60, status: 'initiated' }),
      attempt({ minutesSinceUpdate: 60, status: 'pending_payer_action' }),
      attempt({ minutesSinceUpdate: 60, status: 'processing' }),
    ]).service.sweep();

    expect(result.examined).toBe(3);
  });
});

describe('what it does with each', () => {
  it('counts one the provider has settled', async () => {
    const stale = attempt({ minutesSinceUpdate: 30 });

    const result = await sweepOver([stale], () =>
      Promise.resolve({ ...stale, status: 'succeeded' }),
    ).service.sweep();

    expect(result).toMatchObject({ examined: 1, settled: 1, stillPending: 0 });
  });

  it('counts one the provider says is still in flight', async () => {
    // Ordinary and expected — a challenge somebody has not finished. Nothing to do
    // but look again next time.
    const stale = attempt({ minutesSinceUpdate: 30 });

    const result = await sweepOver([stale], () =>
      Promise.resolve(stale),
    ).service.sweep();

    expect(result).toMatchObject({ examined: 1, settled: 0, stillPending: 1 });
  });

  it('counts a failed card as settled, because a decline is an answer', async () => {
    const stale = attempt({ minutesSinceUpdate: 30 });

    const result = await sweepOver([stale], () =>
      Promise.resolve({ ...stale, status: 'failed' }),
    ).service.sweep();

    expect(result.settled).toBe(1);
  });
});

/**
 * **The number this whole slice exists to surface.**
 *
 * An attempt with no provider reference was written before the provider was called
 * and never updated: either the call never left, or it left and the answer was
 * lost. In the second case money may have moved with nothing pointing at it — and
 * **re-reading cannot find it**, because there is no reference to read.
 */
describe('an attempt that cannot be reconciled at all', () => {
  /*
   * **The field is removed rather than set to `undefined`.** `exactOptionalProperty
   * Types` is on, and the distinction is the point here: `PaymentIntentRecord`
   * models "there is no reference" as the property being absent, so a test that set
   * it to `undefined` would be asserting against a shape the store cannot produce.
   */
  const orphan = (): PaymentIntentRecord => {
    const withReference = attempt({ minutesSinceUpdate: 120, status: 'initiated' });
    const without: Record<string, unknown> = { ...withReference };
    delete without['providerReference'];
    return without as unknown as PaymentIntentRecord;
  };

  it('is counted separately, never as examined-and-fine', async () => {
    const result = await sweepOver([orphan()]).service.sweep();

    expect(result).toMatchObject({ examined: 1, unreconcilable: 1, stillPending: 0 });
  });

  it('is never sent to the provider, because there is nothing to ask about', async () => {
    const refresh = vi.fn();

    await sweepOver([orphan()], refresh).service.sweep();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('is warned about, so it is visible without waiting for an alert rule', async () => {
    const { service, recording } = sweepOver([orphan()]);

    await service.sweep();

    const warned = recording.records.find(
      (entry) =>
        entry.level === 'warn' && entry.message.includes('cannot be reconciled'),
    );
    expect(warned).toBeDefined();
  });

  /**
   * **No amount, no payee, no attempt key.** A machine with no user triggered this;
   * the booking id is what a human needs to find the hire, and nothing more belongs
   * in a log line on an unscoped path.
   */
  it('logs the booking but not the money', async () => {
    const { service, recording } = sweepOver([orphan()]);

    await service.sweep();

    const warned = recording.records.find((entry) => entry.level === 'warn');
    expect(warned?.fields).toHaveProperty('bookingId');
    expect(warned?.fields).not.toHaveProperty('amount');
    expect(warned?.fields).not.toHaveProperty('ownerId');
    expect(warned?.fields).not.toHaveProperty('attemptKey');
  });
});

describe('when a provider call fails', () => {
  /**
   * **One failure does not abandon the rest**, deliberately unlike the expiry
   * sweep, whose work is a single `UPDATE`. Eighty-seven unreconciled attempts is a
   * worse outcome than one unreconciled attempt, and nothing about the failed one
   * changed — so the next sweep picks it up again.
   */
  it('carries on with the others', async () => {
    const rows = [
      attempt({ minutesSinceUpdate: 60 }),
      attempt({ minutesSinceUpdate: 50 }),
      attempt({ minutesSinceUpdate: 40 }),
    ];
    const doomed = rows[0]?.id;

    const result = await sweepOver(rows, (id) =>
      id === doomed
        ? Promise.reject(new Error('provider timeout'))
        : Promise.resolve(rows.find((row) => row.id === id) ?? null),
    ).service.sweep();

    expect(result.examined).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.stillPending).toBe(2);
  });

  it('logs the failure rather than swallowing it', async () => {
    const stale = attempt({ minutesSinceUpdate: 60 });
    const { service, recording } = sweepOver([stale], () =>
      Promise.reject(new Error('provider timeout')),
    );

    await service.sweep();

    expect(
      recording.records.some(
        (entry) =>
          entry.level === 'error' && entry.message.includes('could not reconcile'),
      ),
    ).toBe(true);
  });

  it('does not report a failure as settled', async () => {
    const stale = attempt({ minutesSinceUpdate: 60 });

    const result = await sweepOver([stale], () =>
      Promise.reject(new Error('nope')),
    ).service.sweep();

    expect(result.settled).toBe(0);
    expect(result.stillPending).toBe(0);
  });
});

describe('the batch bound', () => {
  it('says so when it filled the batch, so the caller comes back sooner', async () => {
    const rows = Array.from({ length: ReconciliationService.BATCH_LIMIT }, () =>
      attempt({ minutesSinceUpdate: 60 }),
    );

    const result = await sweepOver(rows).service.sweep();

    expect(result.examined).toBe(ReconciliationService.BATCH_LIMIT);
    expect(result.reachedLimit).toBe(true);
  });

  it('does not claim a limit it did not reach', async () => {
    const result = await sweepOver([
      attempt({ minutesSinceUpdate: 60 }),
    ]).service.sweep();

    expect(result.reachedLimit).toBe(false);
  });
});

/**
 * **Production's actual state today**, and the reason this is not a dead control:
 * `booking.payment` is off everywhere, so no attempt can be opened and the sweep
 * has nothing to find. A job with nothing to do has succeeded.
 */
describe('when there is nothing to reconcile', () => {
  it('reports zeroes rather than failing', async () => {
    const result = await sweepOver([]).service.sweep();

    expect(result).toEqual({
      examined: 0,
      settled: 0,
      stillPending: 0,
      unreconcilable: 0,
      failed: 0,
      reachedLimit: false,
    });
  });
});
