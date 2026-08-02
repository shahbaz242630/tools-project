import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeActivityOrigin,
  describeActor,
  describeActorForAdmin,
  devicesBySession,
} from './activity-display';
import type { SignInEntry } from '@platform/contracts';

// Typed as the contract rather than `as const`, so an override below is not a
// type error the suite would never see — vitest transpiles without checking.
const SIGN_IN: SignInEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  event: 'started',
  sessionId: 'sess_alice',
  occurredAt: '2026-08-02T10:53:19.422Z',
  ipAddress: '203.0.113.7',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

describe('describeAction', () => {
  it('turns a machine action into words', () => {
    expect(describeAction('admin.activity_viewed')).toBe('Account activity viewed');
  });

  it('falls back to the raw action rather than dropping it', () => {
    // A new action shipped by the API before this map knows it is a slightly
    // ugly row. A missing row in an audit trail is the failure that matters.
    expect(describeAction('account.suspended')).toBe('account.suspended');
  });

  it('names every action the API can currently record', () => {
    // The closed vocabulary in `AuditAction`. A new one added there without a
    // description here renders as a dotted identifier on a page a person reads
    // to understand what happened to their account.
    const actions = [
      'account.deletion_requested',
      'account.email_changed',
      'account.exported',
      'account.provisioned',
      'admin.activity_viewed',
      'profile.created',
      'profile.erased',
      'profile.updated',
    ];

    for (const action of actions) {
      expect(describeAction(action), action).not.toBe(action);
    }
  });
});

describe('describeActor', () => {
  it.each([
    ['subject', 'You'],
    ['administrator', 'An administrator'],
    ['system', 'Automatic'],
  ] as const)('reads %s as %s to the account holder', (by, expected) => {
    expect(describeActor(by)).toBe(expected);
  });

  it('names no individual administrator', () => {
    // The subject is entitled to know their account was read and why. They are
    // not entitled to the identity of the support worker who read it — and the
    // API never sends one, so there is nothing here to render.
    expect(describeActor('administrator')).toBe('An administrator');
  });
});

describe('describeActorForAdmin', () => {
  it('never says "you" to somebody reading another account', () => {
    // The reader is the administrator, not the subject. Getting this backwards
    // is how a support worker misreads whose action they are looking at.
    expect(describeActorForAdmin('subject')).toBe('Account holder');
  });

  it.each([
    ['administrator', 'An administrator'],
    ['system', 'Automatic'],
  ] as const)('leaves %s unchanged', (by, expected) => {
    expect(describeActorForAdmin(by)).toBe(expected);
  });
});

describe('devicesBySession', () => {
  it('maps a session to the device it was signed in from', () => {
    expect(devicesBySession([SIGN_IN]).get('sess_alice')).toBe('Edge on Windows');
  });

  it('keeps the device when a later event for the same session has none', () => {
    // One session produces several rows, and only some carry request
    // attributes — a sign-out often carries none. Letting the bare row win
    // would erase what the sign-in told us, which is the detail the whole
    // feature exists to show.
    const signOut: SignInEntry = {
      ...SIGN_IN,
      id: '22222222-2222-4222-8222-222222222222',
      event: 'ended',
      browserName: null,
      deviceType: null,
    };

    // Newest first, as the API serves them: the sign-out is the newer row.
    expect(devicesBySession([signOut, SIGN_IN]).get('sess_alice')).toBe(
      'Edge on Windows',
    );
  });

  it('holds no entry for a session nothing is known about', () => {
    const bare: SignInEntry = { ...SIGN_IN, browserName: null, deviceType: null };

    // Absent rather than "Device not recorded". A map entry saying nothing
    // would make the activity table claim it resolved a session when it did
    // not, and the fallback is what tells the reader the truth.
    expect(devicesBySession([bare]).has('sess_alice')).toBe(false);
  });

  it('is empty for no sign-ins at all', () => {
    expect(devicesBySession([]).size).toBe(0);
  });
});

describe('describeActivityOrigin', () => {
  const devices = new Map([['sess_alice', 'Edge on Windows']]);

  it('names the device and the address together', () => {
    // The sentence the slice exists to produce.
    expect(
      describeActivityOrigin(
        { sessionId: 'sess_alice', ipAddress: '203.0.113.7' },
        devices,
      ),
    ).toBe('Edge on Windows · 203.0.113.7');
  });

  it('gives the address alone when the session matches no sign-in', () => {
    // A `session.created` we never received. Bounded and expected (ADR 0025),
    // and it must degrade to what the page showed before this slice rather
    // than to an error or a blank.
    expect(
      describeActivityOrigin(
        { sessionId: 'sess_never_delivered', ipAddress: '203.0.113.7' },
        devices,
      ),
    ).toBe('203.0.113.7');
  });

  it('gives the address alone for an entry older than the column', () => {
    expect(
      describeActivityOrigin({ sessionId: null, ipAddress: '203.0.113.7' }, devices),
    ).toBe('203.0.113.7');
  });

  it('gives the device alone when no address was forwarded', () => {
    expect(
      describeActivityOrigin({ sessionId: 'sess_alice', ipAddress: null }, devices),
    ).toBe('Edge on Windows');
  });

  it('says nothing was recorded rather than rendering an empty cell', () => {
    // What an administrator's action looks like to the subject: both fields
    // withheld by the API. An empty cell reads as a loading state, which is the
    // one thing a security page must not look like.
    expect(describeActivityOrigin({ sessionId: null, ipAddress: null }, devices)).toBe(
      'Not recorded',
    );
  });

  it('resolves nothing when there are no devices to resolve against', () => {
    // The administrative view of somebody's trail. An administrator has no
    // access to that person's sign-ins (ADR 0022, ADR 0025), so the map is
    // empty and every row falls back — the narrowing needs no code because the
    // data is not there.
    expect(
      describeActivityOrigin(
        { sessionId: 'sess_alice', ipAddress: '203.0.113.7' },
        new Map(),
      ),
    ).toBe('203.0.113.7');
  });
});
