/** What the business description says about a company's place in the theme. `none` is the only verdict that scores a gate KPI at level 0. */
export type ExposureVerdict = 'none' | 'exposed' | 'unknown';

/** The options of the exposure Choice. The keys are the answers Jev may give, so it cannot invent one. */
export const exposureOptions = {
  core: "The company's main business, or one of its main segments, makes or sells products or services in the theme.",
  partial: 'Some of the company\'s products or services are in the theme, but they are not its main business.',
  none: "The passages describe what the company does and none of its products or services are in the theme.",
  cannot_tell: 'The passages do not describe what the company does well enough to judge.',
} as const;
export type ExposureOption = keyof typeof exposureOptions;

/** The least probability on `none`, with that answer chosen, for code to call a name outside the theme. Provisional until the labelled evaluation sets it. */
export const noExposureThreshold = 0.95;

/** The question Jev answers about a company's business passages. The theme is the analyst's brief, so the same words define the theme everywhere. */
export const exposureInstructions = (theme: string) => `Read the passages from the company's own filing. Using only what they say about the company's products, services and customers, which option describes its exposure to this theme? Theme: ${theme}`;

/**
 * Turns Jev's Choice answer into a verdict. Code decides. Only a confident `none` is a verdict of no exposure.
 * `core` and `partial` leave the name to normal scoring, and a doubtful or `cannot_tell` answer stays unknown, never zero.
 */
export function decideExposure(answer: { choice: string; probabilities: Readonly<Record<string, number>> } | undefined): ExposureVerdict {
  if (!answer) return 'unknown';
  if (answer.choice === 'none' && (answer.probabilities.none ?? 0) >= noExposureThreshold) return 'none';
  if (answer.choice === 'core' || answer.choice === 'partial') return 'exposed';
  return 'unknown';
}
