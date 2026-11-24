// A stand-in for a payment API that's down about half the time. Like a real one, it
// charges once per idempotency key, so a retry, or a run that's retried after a
// fix, doesn't charge twice.
const charges = new Map<string, string>();

export class PaymentsUnavailable extends Error {}
export class CardDeclined extends Error {}

export async function charge(input: { amount: number; idempotencyKey: string }) {
  const done = charges.get(input.idempotencyKey);
  if (done) return { chargeId: done };
  if (Math.random() < 0.5) throw new PaymentsUnavailable("Payments returned 503");
  if (input.amount > 1_000_000) throw new CardDeclined("Card declined");
  const chargeId = `ch_${input.idempotencyKey}`;
  charges.set(input.idempotencyKey, chargeId);
  return { chargeId };
}
