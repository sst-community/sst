/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS EventFlow use cases
 *
 * Inngest's use cases, each as one file in `src/use-cases/`, on one
 * [`EventFlow`](/docs/component/aws/eventflow). There are eleven functions, and they
 * all run in the EventFlow's one worker.
 *
 * | File | Use case | Uses |
 * |------|----------|------|
 * | `background-job.ts` | Work after a sign-up | `step.run`, retries |
 * | `webhooks.ts` | A webhook that starts two functions | fan-out, event IDs |
 * | `cart-abandonment.ts` | Remind when no purchase comes | `waitForEvent` with a timeout |
 * | `reminders.ts` | A reminder at a chosen time, unless cancelled | `sleepUntil`, `cancelOn` |
 * | `trial.ts` | A trial's nudge and end, unless the user upgrades | `sleep`, `cancelOn` |
 * | `digest.ts` | A weekly digest for each user | cron with `TZ=`, `sendEvent`, `throttle` |
 * | `sync.ts` | Walk a paginated API | a loop of steps, `concurrency` per tenant |
 * | `ai-chain.ts` | A chain of model calls | steps in parallel, `concurrency`, `throttle` |
 * | `human-in-the-loop.ts` | Wait for a person to approve | `waitForEvent` with `if` |
 *
 * Send a test event with your own credentials, then look at its run.
 *
 * ```bash
 * sst shell -- bun scripts/send.ts cart/item.added '{"cartId":"c1","email":"ada@example.com","timeout":"1m"}'
 * sst eventflow runs --function cart-abandonment
 * ```
 *
 * Cancel a reminder before it's sent.
 *
 * ```bash
 * sst shell -- bun scripts/send.ts reminder/scheduled '{"reminderId":"r1","remindAt":"2027-06-01T09:00:00Z","email":"ada@example.com","text":"Hi"}'
 * sst shell -- bun scripts/send.ts reminder/cancelled '{"reminderId":"r1"}'
 * ```
 *
 * The Stripe webhook checks Stripe's signature, with the secret Stripe gives you.
 *
 * ```bash
 * sst secret set StripeWebhookSecret whsec_...
 * ```
 */
export default $config({
  app(input) {
    return {
      name: "aws-eventflow-use-cases",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const flow = new sst.aws.EventFlow("Flow", {
      handler: "src/flow.handler",
      // A reminder or a trial can sleep for a long time. A run can last up to 366
      // days; the default is 14.
      timeout: { execution: "366 days" },
    });
    const stripeSecret = new sst.Secret("StripeWebhookSecret");
    const api = new sst.aws.Function("Webhooks", {
      handler: "src/api.handler",
      url: true,
      link: [flow, stripeSecret],
    });
    return { webhooks: api.url };
  },
});
