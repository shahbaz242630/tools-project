# 0029. Read attribute values against the pinned version, and refuse a stale form

- **Status:** Accepted
- **Date:** 2026-08-04
- **Relates to:** BRD §8.2, §8.3, §6.2, §14 Phase 2; ADR 0002, ADR 0025, ADR 0027

## Context

ADR 0027 left one question open and named the slice that had to answer it:
_"Nothing validates attribute values yet. That belongs in slice 2.4, where the
first listing supplies some."_ The phase handoff put it more sharply — **renaming
an attribute key silently orphans stored values** — and recorded that the form
only warns, which is not an answer.

Slice 2.4a then built the listing, and the shape of the answer changed. A listing
carries a **composite foreign key** to `(categoryVersionId, categoryId)`, the
attribute schema lives on `category_versions`, and a trigger refuses `UPDATE` on
that row (slice 2.1). Three facts follow from that and they matter more than any
policy we could have written:

- A category is never edited. Reconfiguring it **appends a version**.
- A listing points at one specific version, for as long as it exists.
- That version's schema is therefore frozen from the listing's point of view.

So the feared orphaning does not happen. Rename `weight_kg` to `mass_kg` and an
existing listing still points at the version whose schema says `weight_kg`, still
holding a value under that key. The value and the definition it was written
against stay together.

What is genuinely reachable is narrower and was not on the original list: the
**stale form**. A page is rendered from version 3, an administrator reconfigures
to version 4, the owner presses Save. The server pins whatever is current at
write time, so the answers would be checked against a schema they were never
shown — and any answer to a renamed or removed attribute would be dropped, or
rejected with "that is not a field of this category" about a field the page had
just displayed.

There is a second constraint, and it decides the wire format. A `number`
attribute's value is a scaled integer whose scale is `decimalPlaces` — **category
configuration**. If the client sent the scaled integer, it would be supplying
both the value and the scale it was computed at, and `25` would be
indistinguishable from 2.5 kg entered against a tampered decimal place. No server
check can recover the difference after the fact.

## Decision

**Attribute values are always read against the version the listing pinned, never
against the category as it stands now.** The API returns the pinned schema beside
the values, because a value is unreadable without it: `25` means nothing until
something says kilograms at one decimal place, and `cordless` means nothing
without the label it was chosen by.

**A draft states which version it was built from, and a mismatch is refused with 409.** `categoryVersionNumber` is a required field on the create request. It is
**not** a choice of which version to pin — the server still pins whatever is
current when it writes, exactly as 2.4a specified. It is an assertion about what
was on screen, and the write refuses to proceed if that has stopped being true.

The check happens twice, deliberately. The service compares before it validates,
because it must know **which schema** to validate against. The store compares
again as it pins, inside the same read that resolves the version, because only
that check can see what is actually being written and the service cannot close
the window between its own read and the store's.

**`number` values travel as the text the person typed and are scaled by the
server** against the pinned definition. This keeps ADR 0002's rule — a decimal is
a string until something holding the scale converts it — and puts the conversion
where the authoritative scale is.

**Required attributes are not enforced when saving a draft.** §8.3 says owners
create drafts and save progress. Completeness is a publication rule and belongs
to slice 2.8, the same way the description is required to be _present_ and
allowed to be _empty_.

**Re-pinning a listing to a newer version must be an explicit, value-migrating
operation, never a side effect of saving.** Nothing does it today. This is the
rule slice 2.8 has to honour when editing and publication arrive, and it is
written here because it is the one way the orphaning above could still happen.

## Consequences

**Two listings in one category can be under different rules, indefinitely.** That
is §8.2 working as specified — a booking keeps the terms it was made under — and
it means anything aggregating across a category (search facets in Phase 3,
reporting later) must read each listing's own pinned schema rather than assuming
one shape per category. An attribute renamed twice leaves three live vocabularies
in one category, all valid.

**An owner filling in a form during a reconfiguration loses nothing but has to
look again.** They get a message saying the category changed, everything else
they typed is preserved, and the category-specific fields have to be checked. It
is the least pleasant outcome in the slice and it is still better than the two
alternatives, both of which discard an answer without saying so.

**The 409 fires even when the answers would still have been valid.** Version 3 to
version 4 is refused whether or not anything the owner typed was affected.
Comparing the schemas instead would mean the check only runs on the
reconfigurations that happen to matter, which is exactly when a subtle one would
slip through — and "did this change affect these answers" is a question with more
edge cases than the thing it is protecting.

**The request and response shapes differ for numbers**, which is unusual and will
look like a mistake to somebody reading only one of them. The request carries
`"2.5"`; the response carries `25` plus the schema that says what it means. Both
files say so at the point of definition.

**Unknown keys are refused rather than dropped.** A client sending an answer to a
field the category does not have gets a 400. Dropping it would throw away
something the owner typed with no error anywhere — the failure mode this whole
ADR exists to avoid, arriving through a different door.

**Nothing enforces `required` until 2.8**, so a draft can be saved with every
mandatory field blank. That is intended, and it means the publication slice
inherits a validation obligation rather than finding one already met.

## Alternatives considered

**Refuse the rename when values exist.** The obvious reading of the deferred
question, and it fails on inspection: it would make the _admin_ form depend on
listing data, breaking the module boundary in the wrong direction, and it would
freeze a category's vocabulary permanently after its first listing. Renaming a
label is a normal, safe act — the ADR 0027 split between `key` and `label` exists
precisely so it is — and the key can be renamed too, as long as stored values are
read against the version they were stored under. Which they are.

**Migrate stored values when a key is renamed.** Rewrites listings in place in
response to a configuration change, which is the thing versioning exists to
prevent: a listing would silently change its stored content because somebody
edited a category. It also needs a rename to be _distinguishable_ from a removal
plus an addition, and nothing in the schema says which one an administrator meant.

**Validate against the current version and accept the stale form.** Simplest, and
it is the silent data loss. An answer to a renamed attribute has nowhere to go
and would be dropped without an error.

**Pin the version the client stated, rather than the current one.** Avoids the
409 entirely and reintroduces exactly what 2.4a rejected: a form left open
overnight pinning configuration that was replaced hours ago. The listing would
then claim terms nobody can see any more.

**Send the scaled integer and trust the client's scale.** Simpler wire format,
and unverifiable. A wrong scale produces a plausible number with no way to detect
it — 25 kg where 2.5 kg was meant — and §8.3 will read weight to suggest a
transport requirement.

**Store the values in a child table keyed by attribute.** Relationally tidier and
queryable, which will matter in Phase 3. Rejected for now on the same grounds
ADR 0027 rejected it for definitions: the values are always read whole with the
listing, and a jsonb column inherits the row's lifecycle for nothing. Unlike the
definitions, there is no immutability argument here — a listing is mutable — so
this is a weaker rejection than 0027's and is the first thing to revisit if
attribute-based filtering needs indexing.

**A single check, in the store only.** Would close the race with less code and
would have to teach the adapter the attribute vocabulary to do the validation
there, putting domain logic in a Prisma class (BRD §5.1). The split — service
decides meaning, store guarantees the version it pinned is the one that was
checked — keeps each side doing only what it is placed to do.

## What would change this

If listing **editing** arrives and an owner needs their listing moved to the
current configuration, that is a re-pin, and it needs its own decision about what
happens to values under keys the new schema lacks. Do not let it become a side
effect of saving an edit — that is the silent orphaning this ADR rejected,
arriving in the slice that was not looking for it.

> **Answered on 11 August 2026 by [0042](0042-a-listing-pins-its-questions-not-its-fees.md),
> and not in the direction this paragraph expected.** Re-pinning is **not** a
> separate operation an owner performs: editing brings the listing onto the
> current version, because the form they are looking at _is_ the current version.
> That is not the silent orphaning warned against above — the current questions
> are on screen and the publication gate enforces the required ones — and the
> money consequence that made an explicit operation seem necessary is removed by
> the same ADR, which reads the fee policy from the _current_ version rather than
> the pinned one. What remains true, and 0042 restates it: **nothing may re-pin a
> listing nobody touched.** No background job, no migration, no side effect of
> publishing.

If attribute values ever need range queries or facet aggregation at volume, the
jsonb column may need GIN indexing or promotion to typed columns. The pinned-read
rule above survives either; the storage shape is what changes.

If a category ever legitimately needs its listings **re-validated** — a bug in an
earlier validator, say — that is a migration with an explicit audit trail, not a
lenient read at the boundary. Reading loosely to accommodate it would remove the
guarantee that a stored value was checked against the schema beside it.
