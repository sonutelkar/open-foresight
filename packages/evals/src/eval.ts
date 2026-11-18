import { z } from 'zod';

const id = z.string().trim().min(1);
const ratio = z.number().finite().min(0).max(1);

export const fixtureSchema = z.object({
  schemaVersion: z.literal(1),
  suiteId: id,
  cases: z.array(z.object({ id, expected: z.string(), actual: z.string() }).strict()).min(1),
}).strict().superRefine((fixture, context) => {
  const ids = new Set<string>();
  for (const item of fixture.cases) {
    if (ids.has(item.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate case ID: ${item.id}` });
    }
    ids.add(item.id);
  }
});

export const baselineSchema = z.object({
  schemaVersion: z.literal(1),
  suiteId: id,
  metric: z.literal('exact_match_rate'),
  value: ratio,
  minimum: ratio,
  maxDrop: ratio,
}).strict();

type Fixture = z.infer<typeof fixtureSchema>;
type Baseline = z.infer<typeof baselineSchema>;

// Convert the validated decimal's shortest representation to an exact fraction.
function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa = '', exponentText = '0'] = value.toString().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const exponent = Number(exponentText) - fraction.length;
  const digits = BigInt(whole + fraction);
  return exponent >= 0
    ? { numerator: digits * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-exponent) };
}

export function evaluate(fixture: Fixture, baseline: Baseline) {
  if (fixture.suiteId !== baseline.suiteId) throw new Error('Fixture and baseline suite IDs do not match');
  const cases = fixture.cases.map(({ id, expected, actual }) => ({ id, expected, actual, passed: expected === actual }));
  const passed = cases.filter(item => item.passed).length;
  const value = passed / cases.length;
  const minimum = decimalFraction(baseline.minimum);
  const reference = decimalFraction(baseline.value);
  const maxDrop = decimalFraction(baseline.maxDrop);
  const numerator = BigInt(passed);
  const denominator = BigInt(cases.length);
  const minimumPassed = numerator * minimum.denominator >= denominator * minimum.numerator;
  const regressionPassed = numerator * reference.denominator * maxDrop.denominator >=
    denominator * (reference.numerator * maxDrop.denominator - maxDrop.numerator * reference.denominator);
  return {
    schemaVersion: 1 as const,
    suiteId: fixture.suiteId,
    metric: 'exact_match_rate' as const,
    value,
    passedCases: passed,
    totalCases: cases.length,
    baseline: { value: baseline.value, minimum: baseline.minimum, maxDrop: baseline.maxDrop },
    checks: { minimumPassed, regressionPassed },
    passed: minimumPassed && regressionPassed,
    cases,
  };
}
