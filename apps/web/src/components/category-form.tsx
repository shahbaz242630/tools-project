'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  CATEGORY_REPORTABLE_ACTIVITIES,
  CATEGORY_RISK_LEVELS,
  MIN_ADMIN_REASON_LENGTH,
  activatesSellerReporting,
} from '@platform/contracts';
import type {
  AdminCategory,
  CategoryReportableActivity,
  CategoryRiskLevel,
} from '@platform/contracts';
import {
  createCategoryAction,
  reconfigureCategoryAction,
} from '../app/admin/categories/actions';
import { INITIAL_CATEGORY_STATE } from '../app/admin/categories/state';
import { AttributeSchemaEditor } from './attribute-schema-editor';
import { FeePolicyEditor } from './fee-policy-editor';
import { TransportOptionsEditor } from './transport-options-editor';

/** Human wording for the vocabulary. The values themselves are the contract's. */
const RISK_LABELS: Record<CategoryRiskLevel, string> = {
  low: 'Low — ordinary domestic use',
  medium: 'Medium — some skill or care needed',
  high: 'High — competence or protective equipment expected',
};

function RiskLevelField({
  id,
  defaultValue,
}: {
  readonly id: string;
  readonly defaultValue: CategoryRiskLevel;
}) {
  return (
    <p>
      <label htmlFor={id}>Risk level</label>
      <select id={id} name="riskLevel" defaultValue={defaultValue}>
        {CATEGORY_RISK_LEVELS.map((level) => (
          <option key={level} value={level}>
            {RISK_LABELS[level]}
          </option>
        ))}
      </select>
    </p>
  );
}

/**
 * Plain descriptions of the statutory heads, in the words of what a category
 * would actually contain rather than the words of the legislation.
 *
 * An administrator choosing a category's configuration knows they are adding
 * trailers; they do not necessarily know that a trailer is a "means of
 * transport" under the digital platform reporting rules. Naming the examples is
 * what makes the choice answerable by the person making it.
 */
const REPORTABLE_LABELS: Record<CategoryReportableActivity, string> = {
  none: 'None — renting out ordinary goods, which is not a reportable activity',
  means_of_transport:
    'Rental of a means of transport — trailers, vans, e-bikes, mobility scooters',
  personal_service:
    'Personal service — time- or task-based work done by a person, such as labour',
  sale_of_goods: 'Sale of goods — items sold rather than rented',
};

/**
 * The flag §8.14.2 requires, and the warning and confirmation it requires with
 * it.
 *
 * The confirmation appears **only when the choice needs one**, and that is the
 * point rather than a nicety. A tick box shown on every category — almost all
 * of which will be `none` forever — is one an administrator learns to tick
 * without reading, and it is then worth nothing on the single occasion it
 * matters.
 *
 * The checkbox is `required` so the browser refuses the submit, the server
 * action parses the same contract schema, and the API enforces it again. Three
 * layers, and only the third is a control: the other two exist so nobody
 * discovers the rule from a round trip.
 */
function ReportableActivityField({
  idPrefix,
  onChange,
  value,
}: {
  readonly idPrefix: string;
  readonly value: CategoryReportableActivity;
  readonly onChange: (next: CategoryReportableActivity) => void;
}) {
  const selectId = `${idPrefix}-reportable`;
  const confirmId = `${idPrefix}-reportable-confirm`;

  return (
    <>
      <p>
        <label htmlFor={selectId}>Reportable activity</label>
        {/*
          Controlled rather than uncontrolled, unlike every other field on this
          form. The warning below has to react to the choice as it is made — a
          confirmation that appeared only after a failed submit would be
          explaining a refusal instead of preventing one.
        */}
        <select
          id={selectId}
          name="reportableActivity"
          value={value}
          onChange={(event) => {
            onChange(event.target.value as CategoryReportableActivity);
          }}
          aria-describedby={`${selectId}-help`}
        >
          {CATEGORY_REPORTABLE_ACTIVITIES.map((activity) => (
            <option key={activity} value={activity}>
              {REPORTABLE_LABELS[activity]}
            </option>
          ))}
        </select>
      </p>
      <p id={`${selectId}-help`}>
        Almost always <strong>none</strong>. Renting out tools, garden equipment and
        household goods is not a reportable activity, and this is the only setting on
        the page that can change what the platform owes HMRC.
      </p>

      {activatesSellerReporting(value) ? (
        <div role="alert">
          <p>
            <strong>This makes the platform a reporting platform operator.</strong>{' '}
            Enabling this category means we must collect and verify tax data from every
            seller in it, register with HMRC, and file an annual return by its deadline.
            Sellers who do not provide their details must eventually be blocked from
            earning.
          </p>
          <p>
            It is not reversible by unticking this later: activity that happened while
            the category was flagged stays reportable.
          </p>
          <p>
            <input
              id={confirmId}
              name="reportingDutiesAcknowledged"
              type="checkbox"
              required
            />{' '}
            <label htmlFor={confirmId}>
              I confirm that <strong>counsel has determined the scope</strong> for this
              category, and that we accept the registration, collection, verification
              and annual filing duties that follow.
            </label>
          </p>
        </div>
      ) : null}
    </>
  );
}

/**
 * The outcome of a save, put where the person pressing the button is looking.
 *
 * This form has always rendered its message at the top and its button at the
 * bottom, and this slice made the gap much longer by adding a whole fieldset.
 * That is the failure session 25 found on the listing form: press Save, the page
 * does not move, and a message 300px above the fold reads as a form that does
 * nothing. Same shape, same fix — focus for a screen reader, scroll for
 * everybody else, and both because `focus()` on an already-focused node does not
 * scroll.
 *
 * **The effect depends on the whole state object, not on `state.message`.** A
 * second consecutive failure produces an identical string, and a dependency on
 * the string would compare equal and skip the effect entirely — leaving the page
 * perfectly still on the second press, which is exactly when somebody concludes
 * it is stuck. `useActionState` hands back a fresh object each time, so this
 * fires on every settled submit, including an identical repeat.
 */
function Feedback({
  state,
}: {
  readonly state: {
    readonly status: 'idle' | 'done' | 'error';
    readonly message: string | null;
  };
}) {
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.message === null) return;
    alert.current?.focus({ preventScroll: true });
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // test asserting the message should not fail on a browser affordance.
    alert.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  if (state.message === null) return null;

  // `tabIndex={-1}` makes it focusable without putting it in the tab order — it
  // is a message, not a control.
  if (state.status === 'error') {
    return (
      <p role="alert" ref={alert} tabIndex={-1}>
        {state.message}
      </p>
    );
  }
  if (state.status === 'done') {
    return (
      <p role="status" ref={alert} tabIndex={-1}>
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * Create a category.
 *
 * The slug is asked for separately from the name rather than derived from it.
 * Deriving looks friendlier and hides the one irreversible decision on the form:
 * renaming later must not move the URL, and an administrator who never chose the
 * slug will not expect that.
 */
export function CreateCategoryForm() {
  const [state, action, pending] = useActionState(
    createCategoryAction,
    INITIAL_CATEGORY_STATE,
  );
  // `none` is where a new category starts, and the state survives a rejected
  // submit because the form is not remounted — so what comes back still shows
  // what was chosen rather than quietly resetting to the safe answer.
  const [reportable, setReportable] = useState<CategoryReportableActivity>('none');

  return (
    <form action={action}>
      <Feedback state={state} />

      <p>
        <label htmlFor="create-name">Name</label>
        <input
          id="create-name"
          name="name"
          type="text"
          required
          defaultValue={state.name}
        />
      </p>

      <p>
        <label htmlFor="create-slug">URL slug</label>
        <input
          id="create-slug"
          name="slug"
          type="text"
          required
          defaultValue={state.slug}
          aria-describedby="slug-help"
          placeholder="outdoor-gardening"
        />
      </p>
      <p id="slug-help">
        Lowercase letters, digits and single hyphens. <strong>Permanent</strong> — it is
        the address of every page in this category, so renaming the category later will
        not change it.
      </p>

      <RiskLevelField id="create-risk" defaultValue="low" />

      <ReportableActivityField
        idPrefix="create"
        value={reportable}
        onChange={setReportable}
      />

      <AttributeSchemaEditor name="attributes" idPrefix="create" />

      <TransportOptionsEditor name="transportOptions" idPrefix="create" />

      <FeePolicyEditor idPrefix="create" />

      <p>
        <label htmlFor="create-reason">Why</label>
        <input
          id="create-reason"
          name="reason"
          type="text"
          required
          minLength={MIN_ADMIN_REASON_LENGTH}
          defaultValue={state.reason}
          aria-describedby="create-reason-help"
        />
      </p>
      <p id="create-reason-help">
        Recorded against the category. Configuration is versioned, and every booking is
        interpreted under the version in force when it was made.
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create category'}
        </button>
      </p>
    </form>
  );
}

/**
 * Change one category's configuration.
 *
 * The button says **Save as a new version**, not Save. An administrator who
 * believes they edited the existing configuration will be surprised when an old
 * booking still prices the old way; saying what actually happens costs nothing.
 */
export function ReconfigureCategoryForm({
  category,
}: {
  readonly category: AdminCategory;
}) {
  const [state, action, pending] = useActionState(
    reconfigureCategoryAction,
    INITIAL_CATEGORY_STATE,
  );
  // Seeded with what this category is now, because `PUT` replaces the whole
  // configuration — the same reason the attribute editor is seeded below.
  const [reportable, setReportable] = useState(category.reportableActivity);

  const id = (field: string) => `${category.slug}-${field}`;

  return (
    <form action={action}>
      <Feedback state={state} />

      <input type="hidden" name="slug" value={category.slug} />

      <p>
        <label htmlFor={id('name')}>Name</label>
        <input
          id={id('name')}
          name="name"
          type="text"
          required
          defaultValue={category.name}
        />
      </p>

      <RiskLevelField id={id('risk')} defaultValue={category.riskLevel} />

      <ReportableActivityField
        idPrefix={category.slug}
        value={reportable}
        onChange={setReportable}
      />

      {/*
        Seeded with what the category has now, because `PUT` replaces the whole
        configuration. An editor that started empty would look like "add some
        attributes" and mean "delete the ones that exist".
      */}
      <AttributeSchemaEditor
        name="attributes"
        idPrefix={category.slug}
        initial={category.attributes}
      />

      {/* Seeded for the same reason the attribute editor is: `PUT` replaces the
          whole configuration, so an editor that started with nothing ticked
          would look like "choose some" and mean "withdraw the ones you have". */}
      <TransportOptionsEditor
        name="transportOptions"
        idPrefix={category.slug}
        initial={category.transportOptions}
      />

      {/* Seeded for the same reason as the two editors above. An unpriced
          category seeds blank rates, which is what it has — not a zero it
          never chose. */}
      <FeePolicyEditor idPrefix={category.slug} initial={category.feePolicy} />

      <p>
        <label htmlFor={id('reason')}>Why</label>
        <input
          id={id('reason')}
          name="reason"
          type="text"
          required
          minLength={MIN_ADMIN_REASON_LENGTH}
          defaultValue={state.reason}
        />
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save as a new version'}
        </button>
      </p>
    </form>
  );
}
