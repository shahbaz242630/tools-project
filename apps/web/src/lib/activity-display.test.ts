import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeActor,
  describeActorForAdmin,
} from './activity-display';

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
