/**
 * A contract violation, as a sentence somebody can act on.
 *
 * **This exists because the same defect has now been found four times**: 2.4b on
 * an attribute key, 2.4c-i through `parseWith`, 2.7a on `feePolicy`, and 2.7b on
 * `rates`. Each time a validation message named the field twice — once by its
 * label on screen and once by a path the reader has never seen — and each time
 * it was fixed for that one field. A fifth nested object would have arrived with
 * the same problem.
 *
 * ## The rule
 *
 * `field: message` is right when the path **is** what the reader sees. `slug`,
 * `title` and `riskLevel` are all labelled that way on their forms, and
 * "slug: must be lowercase letters" reads correctly.
 *
 * It is wrong the moment a schema nests. `feePolicy.minimumPlatformFee.amount`
 * is three segments of internal structure against a field labelled "Minimum
 * platform fee (£)"; `rates.daily` is two against "Daily rate (£)". No reader
 * can act on either.
 *
 * So: **a message that is a sentence names its own subject and is shown alone; a
 * message that is a fragment is prefixed with its path.** The distinction is
 * visible in the message itself — a fragment starts lowercase (`is required`,
 * `must be at least 2 characters`) and only makes sense after a field name; a
 * sentence starts with a capital (`A daily rate is needed…`) and already says
 * what it is about.
 *
 * That makes the convention self-enforcing rather than a list of paths somebody
 * has to remember to extend. Whoever writes a validation message on a nested
 * object writes a sentence, and it renders correctly without anybody wiring
 * anything up.
 */
export interface ContractIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function asSentence(issue: ContractIssue): string {
  const path = issue.path.join('.');
  if (path === '') return issue.message;

  // A sentence — it names its own subject, so the path would name it twice.
  if (/^[A-Z]/.test(issue.message)) return issue.message;

  return `${path}: ${issue.message}`;
}

/** Every issue in a violation, joined as one line for a form's message area. */
export function asSentences(issues: readonly ContractIssue[]): string {
  return issues.map(asSentence).join('; ');
}

/**
 * The first issue as a standalone sentence, with the field name stripped off.
 *
 * **The counterpart to `asSentence`, for forms whose controls are not named
 * after the JSON.** That function's rule — prefix a fragment with its path — is
 * right where the path *is* the label. It is wrong on a form with two date
 * controls labelled "First day" and "Last day", where `endDate: the last day
 * cannot fall before the first` names the field twice and once in a vocabulary
 * the reader has never seen.
 *
 * **The first issue only**, because a message area above a three-field form can
 * carry one sentence usefully and a semicolon-joined list of three badly. The
 * fields a person is looking at are the other half of the message.
 *
 * `fallback` is the caller's, because a violation with no issues in it is a
 * situation only the caller can describe — it has never been observed and the
 * alternative is an empty message area under a form that refused.
 */
export function asStandaloneSentence(
  issues: readonly string[],
  fallback: string,
): string {
  const [first] = issues;
  if (first === undefined) return fallback;

  const withoutField = first.includes(': ')
    ? first.slice(first.indexOf(': ') + 2)
    : first;
  return `${withoutField.charAt(0).toUpperCase()}${withoutField.slice(1)}.`;
}
