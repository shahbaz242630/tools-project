# 0026. Leave suspicious-login alerting with the identity provider until we have a channel

- **Status:** Accepted
- **Date:** 2026-08-02
- **Relates to:** BRD §8.1, §4.1, §10.1; ADR 0015, ADR 0020, ADR 0025

## Context

BRD §8.1 asks for three things: "authentication events, device/session
management and suspicious-login alerts". Slice 1.11a built the first.
Slice 1.11b established that the second already exists — Clerk's
`<UserProfile />`, mounted at `/account/email` since slice 1.7, lists active
devices with a browser, an IP and a city it resolves client-side, which our
server-side webhook cannot see (ADR 0025).

The third is alerting, and **we cannot build it, for a reason that has nothing
to do with detection.** An alert needs somewhere to go.

BRD §4.1 is explicit that push is supplementary: iOS web push works only for
home-screen-installed applications, so every critical event must be deliverable
by email or SMS, and a critical send with no non-push channel is a failure
rather than a silent success. A security alert is exactly a critical send.

We have neither channel. Email is slice 1.3, which is undecided — Clerk's own
transactional emails or our own through Resend — and Resend needs a verified
domain for DKIM, which needs a domain, which waits on the brand name. SMS is
Twilio in Phase 6, and phone numbers are captured today but **unverified**, so
they must not be read as a trust signal. The chain from "notice a suspicious
sign-in" to "tell the person" is broken at the last link, and no amount of code
in this repository closes it.

Meanwhile the provider already does it. Clerk sends new-device sign-in emails
from its own instance, on its own detection, to the address it holds — the same
address our mirror holds, because ADR 0020 keeps the two converged.

## Decision

**Clerk owns suspicious-login alerting until we have an email channel of our
own.** We neither detect nor notify. The _record_ a person reads is ours — the
sign-in history from 1.11a; the _alert_ that reaches them unprompted is the
provider's.

**We do not build a detection with nowhere to send its output.** A detector
whose only sink is a log line nobody watches is the failure this project already
carries for stuck webhooks: recorded, and nobody is watching. It reads as a
control in a review and is not one, which is worse than an acknowledged gap
because it stops anybody looking for the real thing.

**We do not promise an alert in our own interface.** The sign-in history says
what it holds and what to do about an entry the reader does not recognise. It
makes no claim that anybody will be told. A page that implies a watchman where
there is none is the same defect one layer up.

## Consequences

**Detection quality is Clerk's and we cannot tune it.** It fires on their
heuristics, and we have no visibility into what they are or when they change.

**An instance with Clerk's alert emails disabled alerts nobody, and nothing
errors.** This is the same silent-failure shape as a missing `fva` claim
(ADR 0021) and a webhook endpoint not subscribed to the `session.*` events
(ADR 0025): correctly-signed, entirely functional, and quietly missing a
control. It therefore joins ADR 0015's per-instance provisioning list as
something to verify rather than assume, on staging and production alike.

**We already hold the data a better detection would need.**
`authentication_events` carries the device, browser and address of every
sign-in, per account. When the channel exists, the detection is ours to write
against a table that is already there — this decision defers the alert, not the
evidence.

**If we ever leave Clerk, the alerting leaves with it**, and the sign-in history
becomes the only thing standing between a compromised account and nobody
noticing. That is an argument for revisiting this at the same time as any
provider change, not for building it now.

## Alternatives considered

**Build the detection now and log the alert.** Rejected on the reasoning above:
a control whose output nobody reads is worse than a stated gap, because it
answers the review question without answering the real one.

**Use web push as the channel.** Rejected by BRD §4.1. Push is supplementary
precisely because iOS restricts it to home-screen-installed apps, and a security
alert with no non-push fallback is a failure that looks like a success.

**Use SMS through Twilio, ahead of Phase 6.** Rejected. The numbers we hold are
unverified, so we would be sending a security alert to an address nobody has
proved they control — which is not merely useless but a disclosure: it tells
whoever holds that number that the account exists and that somebody signed in.

**Show a banner at the next sign-in instead of sending anything.** Rejected as
the primary mechanism, for two reasons that are worth keeping. Somebody whose
account was taken over may not sign in again for days, and the alert is useless
after the fact. And an in-app message reaches whoever is signed in — which, in
the case this exists for, is the attacker. Reasonable as a supplement once a
real channel exists; never as the channel itself.

**Send our own alerts through Clerk's email infrastructure.** Not available:
Clerk sends its own templated messages, and driving it as a generic email
provider is not something its API offers. Slice 1.3 is the decision that gets us
a sender.

## What would change this

**Slice 1.3 landing an email channel.** That is the unblock, and it is a
product-owner decision plus a domain registration rather than engineering work.
The moment a verified sender exists, this ADR should be revisited rather than
left to expire quietly.

**A detection Clerk cannot make.** Clerk sees sign-ins. We see sign-ins _and
what was done afterwards_ — "signed in from an unrecognised device and then
exported everything we hold" is a correlation only we are positioned to make,
and it is a far stronger signal than a new device on its own. Slice 1.11c, which
records the session alongside audit entries, is what makes that query possible.
When both that and a channel exist, building our own detection stops being
duplication and starts being the point.

**Leaving Clerk**, for any reason. The alert is theirs, so it leaves with them,
and nothing in this repository would replace it automatically.
