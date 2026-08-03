'use client';

import { useActionState } from 'react';
import { CATEGORY_RISK_LEVELS, MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import type { AdminCategory, CategoryRiskLevel } from '@platform/contracts';
import {
  INITIAL_CATEGORY_STATE,
  createCategoryAction,
  reconfigureCategoryAction,
} from '../app/admin/categories/actions';
import { AttributeSchemaEditor } from './attribute-schema-editor';

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

function Feedback({
  status,
  message,
}: {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
}) {
  if (message === null) return null;
  if (status === 'error') return <p role="alert">{message}</p>;
  if (status === 'done') return <p role="status">{message}</p>;
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

  return (
    <form action={action}>
      <Feedback status={state.status} message={state.message} />

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

      <AttributeSchemaEditor name="attributes" idPrefix="create" />

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

  const id = (field: string) => `${category.slug}-${field}`;

  return (
    <form action={action}>
      <Feedback status={state.status} message={state.message} />

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
