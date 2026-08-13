'use client';

import { useActionState, useState } from 'react';
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  ADDRESS_LINE_MAX_LENGTH,
  TOWN_MAX_LENGTH,
} from '@platform/contracts';
import type { MyProfile } from '@platform/contracts';
import { Postcode } from '@platform/core';
import { saveProfileAction } from '../app/account/profile/actions';
import { INITIAL_PROFILE_FORM_STATE } from '../app/account/profile/state';
import { ProfileFormStatus } from './profile-form-status';
import group from './form-card.module.css';
import styles from './profile-form.module.css';

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
 *
 * **Slice D5 gave that idea a shape**: three cards, one per audience, each
 * badged with who sees it. The `<fieldset>`/`<legend>` structure underneath is
 * unchanged — the legend is what associates the label with the whole group for a
 * screen reader, and it is the only element that does, so it is styled as a pill
 * rather than replaced by a heading.
 */
export function ProfileForm({ profile }: { profile: MyProfile | null }) {
  const [state, action, pending] = useActionState(
    saveProfileAction,
    INITIAL_PROFILE_FORM_STATE,
  );

  /*
   * **Tracked for the preview only; the input stays uncontrolled.** The design
   * shows the district live in the help text — the single most reassuring thing
   * on this page, because it turns "only the first part is published" from a
   * promise into something you can watch happen while you type.
   *
   * `defaultValue` plus `onChange` rather than `value` plus `onChange`: making
   * this a controlled input would put React between somebody and their own
   * keyboard for no benefit, and this codebase has been bitten before by
   * controlled inputs behaving differently under automation than under fingers.
   */
  const [postcode, setPostcode] = useState(profile?.address?.postcode ?? '');

  return (
    <form action={action}>
      <ProfileFormStatus state={state} />

      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={`${group.badge} ${group.badgePublic}`}>
            Public — anyone can see this
          </span>
        </legend>

        <div className={group.field}>
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
          <p id="displayName-help" className={group.help}>
            Shown on your profile and beside anything you list. Many people use a first
            name and an initial.
          </p>
        </div>
      </fieldset>

      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={group.badge}>
            Private — shared only when you agree a rental
          </span>
        </legend>

        <p className={group.intro}>
          Nobody sees these until you and the other person have agreed a booking. Your
          address is never shown in full: your profile shows only the first part of your
          postcode, which covers thousands of homes.
        </p>

        <div className={group.field}>
          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            defaultValue={profile?.phone ?? ''}
            aria-describedby="phone-help"
          />
          <p id="phone-help" className={group.help}>
            UK numbers only, for now.
          </p>
        </div>

        <div className={group.field}>
          <label htmlFor="line1">Address line 1</label>
          <input
            id="line1"
            name="line1"
            type="text"
            autoComplete="address-line1"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            defaultValue={profile?.address?.line1 ?? ''}
          />
        </div>

        <div className={group.field}>
          <label htmlFor="line2">Address line 2</label>
          <input
            id="line2"
            name="line2"
            type="text"
            autoComplete="address-line2"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            defaultValue={profile?.address?.line2 ?? ''}
          />
        </div>

        <div className={group.field}>
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
          <p id="town-help" className={group.help}>
            This one is public — it appears on your profile beside your postcode
            district.
          </p>
        </div>

        <div className={group.field}>
          <label htmlFor="postcode">Postcode</label>
          <input
            id="postcode"
            name="postcode"
            type="text"
            autoComplete="postal-code"
            defaultValue={profile?.address?.postcode ?? ''}
            onChange={(event) => setPostcode(event.target.value)}
            aria-describedby="postcode-help"
          />
          {/*
            **`aria-live` so the change is announced, not only seen.** The whole
            point of this line is that it moves while you type; somebody using a
            screen reader gets nothing from a change they are not told about.
            `polite` rather than `assertive`, because it must not interrupt the
            typing that caused it.
          */}
          <p id="postcode-help" className={group.help} aria-live="polite">
            <DistrictPreview postcode={postcode} />
          </p>
        </div>
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
      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={group.badge}>How you list</span>
        </legend>

        <p id="owner-status-help" className={group.intro}>
          Renters have different legal rights depending on whether they rent from a
          private individual or from a business, so we have to say which you are. You
          cannot publish a listing until you have answered.
        </p>

        <div className={group.choices}>
          <label htmlFor="owner-status-private" className={group.choice}>
            <input
              id="owner-status-private"
              name="ownerStatus"
              type="radio"
              className={group.radio}
              value="private_owner"
              defaultChecked={profile?.ownerStatus === 'private_owner'}
              aria-describedby="owner-status-help"
            />
            I am a private individual, lending my own things
          </label>

          <label htmlFor="owner-status-trader" className={group.choice}>
            <input
              id="owner-status-trader"
              name="ownerStatus"
              type="radio"
              className={group.radio}
              value="professional_trader"
              defaultChecked={profile?.ownerStatus === 'professional_trader'}
            />
            I am a business, or I do this as a trade
          </label>
        </div>

        {/*
          **Said here rather than discovered at publish.** Somebody who ticks
          business and then finds out three screens later that they cannot list
          has been wasted, and a platform that only mentions its limits when you
          hit them is one people stop trusting.
        */}
        <p className={group.help}>
          We only accept listings from private individuals at the moment. If you list as
          a business you can still use the site, but you will not be able to publish —
          tell us anyway, because it is how we find out there is demand for it.
        </p>
      </fieldset>

      <div className={group.actions}>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  );
}

/**
 * The part of a postcode that gets published, shown while it is typed.
 *
 * **Three states, and the middle one is the reason this is a component.** With
 * nothing typed it explains the rule; with a valid postcode it shows the actual
 * district; with something half-typed it goes back to explaining rather than
 * flashing an error, because "SW1" on the way to "SW11 4AB" is not a mistake and
 * telling somebody off mid-word is the fastest way to make a form feel hostile.
 *
 * `Postcode.outwardCode` throws on anything it does not recognise, so validity
 * is checked first — the same pairing `AccountHeader` uses.
 */
export function DistrictPreview({ postcode }: { readonly postcode: string }) {
  const typed = postcode.trim();

  if (typed !== '' && Postcode.isValid(typed)) {
    return (
      <>
        Only the district —{' '}
        <span className={styles.district}>{Postcode.outwardCode(typed)}</span> — is ever
        shown publicly.
      </>
    );
  }

  return <>Only the district — the part before the space — is ever shown publicly.</>;
}
