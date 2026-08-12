'use client';

import { useActionState } from 'react';
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  ADDRESS_LINE_MAX_LENGTH,
  TOWN_MAX_LENGTH,
} from '@platform/contracts';
import type { MyProfile } from '@platform/contracts';
import { saveProfileAction } from '../app/account/profile/actions';
import { INITIAL_PROFILE_FORM_STATE } from '../app/account/profile/state';
import { ProfileFormStatus } from './profile-form-status';

/**
 * The profile form.
 *
 * A client component only because it uses `useActionState` to show what came
 * back from the save. The submission itself runs on the server — the API is not
 * reachable from a browser, and the session token never reaches client
 * JavaScript.
 *
 * **Every field here is labelled with who can see it.** That is not decoration.
 * People are being asked for a home address and a phone number by a platform
 * that will send strangers to their door, and a form that collects those
 * silently is asking for trust it has not earned. The labels are also the only
 * place a person learns that their full postcode stays private while its
 * district does not.
 */
export function ProfileForm({ profile }: { profile: MyProfile | null }) {
  const [state, action, pending] = useActionState(
    saveProfileAction,
    INITIAL_PROFILE_FORM_STATE,
  );

  return (
    <form action={action}>
      <ProfileFormStatus state={state} />

      <fieldset>
        <legend>Public — anyone can see this</legend>

        <p>
          <label htmlFor="displayName">Display name</label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            minLength={DISPLAY_NAME_MIN_LENGTH}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            defaultValue={profile?.displayName ?? ''}
            // The browser's own validation is a convenience that matches the
            // contract. It is never the control — the API validates the same
            // rules, because anything a browser enforces a client can skip.
            aria-describedby="displayName-help"
          />
        </p>
        <p id="displayName-help">
          Shown on your profile and beside anything you list. Many people use a first
          name and an initial.
        </p>
      </fieldset>

      <fieldset>
        <legend>Private — shared only when you agree a rental</legend>

        <p>
          Nobody sees these until you and the other person have agreed a booking. Your
          address is never shown in full: your profile shows only the first part of your
          postcode, which covers thousands of homes.
        </p>

        <p>
          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue={profile?.phone ?? ''}
            aria-describedby="phone-help"
          />
        </p>
        <p id="phone-help">UK numbers only, for now.</p>

        <p>
          <label htmlFor="line1">Address line 1</label>
          <input
            id="line1"
            name="line1"
            type="text"
            autoComplete="address-line1"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            defaultValue={profile?.address?.line1 ?? ''}
          />
        </p>

        <p>
          <label htmlFor="line2">Address line 2</label>
          <input
            id="line2"
            name="line2"
            type="text"
            autoComplete="address-line2"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            defaultValue={profile?.address?.line2 ?? ''}
          />
        </p>

        <p>
          <label htmlFor="town">Town or city</label>
          <input
            id="town"
            name="town"
            type="text"
            autoComplete="address-level2"
            maxLength={TOWN_MAX_LENGTH}
            defaultValue={profile?.address?.town ?? ''}
            aria-describedby="town-help"
          />
        </p>
        <p id="town-help">
          This one is public — it appears on your profile beside your postcode district.
        </p>

        <p>
          <label htmlFor="postcode">Postcode</label>
          <input
            id="postcode"
            name="postcode"
            type="text"
            autoComplete="postal-code"
            defaultValue={profile?.address?.postcode ?? ''}
            aria-describedby="postcode-help"
          />
        </p>
        <p id="postcode-help">
          Only the district — the part before the space — is ever shown publicly.
        </p>
      </fieldset>

      {/*
        **A legal question, asked plainly** (BRD §8.3, slice 2.13). A renter has
        materially stronger rights against a business than against a private
        individual, so they have to be told which they are dealing with before
        they book — and the only way we can tell them truthfully is to ask.

        **Nothing is pre-selected**, which is the rule 2.8c-i's moderation radios
        established for a different reason and which applies twice over here: a
        default would be the platform answering a legal question on somebody's
        behalf, and because "private" is the likely answer it would be wrong
        rarely and invisibly — the worst frequency there is.

        The business option is offered rather than hidden even though we cannot
        publish one. Hiding it would leave a business either lying or leaving
        silently, and we would learn nothing; offering it means a real answer, an
        honest refusal, and a recorded signal of demand for the day this is
        reconsidered.
      */}
      <fieldset>
        <legend>How you list</legend>

        <p id="owner-status-help">
          Renters have different legal rights depending on whether they rent from a
          private individual or from a business, so we have to say which you are. You
          cannot publish a listing until you have answered.
        </p>

        <p>
          <label htmlFor="owner-status-private">
            <input
              id="owner-status-private"
              name="ownerStatus"
              type="radio"
              value="private_owner"
              defaultChecked={profile?.ownerStatus === 'private_owner'}
              aria-describedby="owner-status-help"
            />{' '}
            I am a private individual, lending my own things
          </label>
        </p>

        <p>
          <label htmlFor="owner-status-trader">
            <input
              id="owner-status-trader"
              name="ownerStatus"
              type="radio"
              value="professional_trader"
              defaultChecked={profile?.ownerStatus === 'professional_trader'}
            />{' '}
            I am a business, or I do this as a trade
          </label>
        </p>

        {/*
          **Said here rather than discovered at publish.** Somebody who ticks
          business and then finds out three screens later that they cannot list
          has been wasted, and a platform that only mentions its limits when you
          hit them is one people stop trusting.
        */}
        <p>
          We only accept listings from private individuals at the moment. If you list as
          a business you can still use the site, but you will not be able to publish —
          tell us anyway, because it is how we find out there is demand for it.
        </p>
      </fieldset>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile'}
        </button>
      </p>
    </form>
  );
}
