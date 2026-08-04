import type { ProfileFormState } from '../app/account/profile/state';

/**
 * What came back from the last save attempt.
 *
 * Split out of `ProfileForm` because it is the part with rules: the form itself
 * is fields, this decides what a person is told about their own data. Keeping
 * it presentational and exhaustive means adding a state to `ProfileFormState`
 * is a type error here rather than a silently blank panel — and it can be
 * tested directly, which a component owning `useActionState` cannot.
 *
 * The distinction it exists to preserve is between *saved* and *not saved*.
 * There is no ambiguous middle: anything that is not a confirmed save says so,
 * because somebody who believes their address is stored when it is not will
 * find out at a handover.
 */
export function ProfileFormStatus({ state }: { state: ProfileFormState }) {
  switch (state.status) {
    case 'idle':
      return null;

    case 'saved':
      // `role="status"` rather than `alert`: a success is announced politely,
      // without interrupting what a screen-reader user is doing.
      return <p role="status">Your profile has been saved.</p>;

    case 'invalid':
      return (
        <div role="alert">
          <p>Your profile was not saved:</p>
          <ul>
            {state.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      );

    case 'error':
      return <p role="alert">{state.message ?? 'Your profile was not saved.'}</p>;
  }
}
