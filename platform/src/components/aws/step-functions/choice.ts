import { ComponentResourceOptions } from "@pulumi/pulumi";
import { isJSONata, JSONata, State, StateArgs } from "./state";

export interface ChoiceArgs extends StateArgs { }

/**
 * The `Choice` state is internally used by the `StepFunctions` component to add a [Choice
 * workflow state](https://docs.aws.amazon.com/step-functions/latest/dg/state-choice.html)
 * to a state machine.
 *
 * :::note
 * This component is not intended to be created directly.
 * :::
 *
 * You'll find this component returned by the `choice` method of the `StepFunctions` component.
 */
export class Choice extends State {
  private choices: {
    condition: JSONata;
    next: State;
  }[] = [];
  private defaultNext?: State;

  constructor(protected args: ChoiceArgs) {
    super(args);
  }

  /**
   * Add a matching condition to the `Choice` state. If the given condition matches,
   * it'll continue execution to the given state.
   *
   * The condition needs to be a JSONata expression that evaluates to a boolean.
   *
   * @example
   *
   * ```ts
   * sst.aws.StepFunctions.choice({
   *   // ...
   * })
   * .when(
   *   "{% $states.input.status === 'unpaid' %}",
   *   state
   * );
   * ```
   *
   * @param condition The JSONata condition to evaluate.
   * @param next The state to transition to.
   */
  public when(condition: JSONata, next: State) {
    if (!isJSONata(condition))
      throw new Error("Condition must start with '{%' and end with '%}'.");

    this.addChoiceBranch(next);
    this.choices.push({ condition, next });
    return this;
  }

  /**
   * Add a default next state to the `Choice` state. If no other condition matches,
   * continue execution with the given state.
   */
  public otherwise(next: State) {
    this.addChoiceBranch(next);
    this.defaultNext = next;
    return this;
  }

  /**
   * Continue every branch of the `Choice` state to the same state, once the branch
   * is done. Call it after `when` and `otherwise`.
   *
   * A branch continues from its last state. So if a branch `a` already has a
   * next state, as in `a.next(b)`, it's `b` that continues to the given state.
   * Branches that end in a `Succeed` or `Fail` state stay as they are. If a branch
   * is another `Choice` state, its own branches continue to the given state. A
   * `Choice` state without `otherwise` still fails when no condition matches.
   *
   * It returns an object with a `next` method that takes that state. `next`
   * returns the given state, so you can keep adding states with `next`.
   *
   * @example
   *
   * ```ts
   * sst.aws.StepFunctions.choice({
   *   // ...
   * })
   * .when("{% $states.input.status === 'unpaid' %}", makePayment)
   * .otherwise(skipPayment)
   * .afterwards()
   * .next(sendReceipt);
   * ```
   */
  public afterwards() {
    return {
      next: <T extends State>(state: T): T => {
        const ends = this.getEnds();
        if (!ends.length)
          throw new Error(
            `The "${this.name}" state has no branch that can continue to "${state.name}". Each branch ends in a Succeed or Fail state, or there are no branches yet.`,
          );
        return this.addNextToEnds(ends, state);
      },
    };
  }

  /**
   * @internal
   */
  public getEnds(seen: Set<State> = new Set()): State[] {
    if (seen.has(this)) return [];
    seen.add(this);
    return [
      ...this.choices.flatMap((c) => c.next.getEnds(seen)),
      ...(this.defaultNext?.getEnds(seen) ?? []),
    ];
  }

  /**
   * @internal
   */
  public assertStateNameUnique(states: Map<string, State> = new Map()) {
    super.assertStateNameUnique(states);
    this.choices.forEach((c) => c.next.assertStateNameUnique(states));
    this.defaultNext?.assertStateNameUnique(states);
  }

  /**
   * @internal
   */
  public assertStateNotReused(
    states: Map<State, string> = new Map(),
    graphId: string = "main",
  ) {
    super.assertStateNotReused(states, graphId);
    this.choices.forEach((c) => c.next.assertStateNotReused(states, graphId));
    this.defaultNext?.assertStateNotReused(states, graphId);
  }

  /**
   * @internal
   */
  public getPermissions(opts?: ComponentResourceOptions) {
    return [
      ...this.choices.flatMap((c) => c.next.getPermissions(opts)),
      ...(this.defaultNext?.getPermissions(opts) || []),
      ...super.getPermissions(opts),
    ];
  }

  /**
   * @internal
   */
  public serialize() {
    return {
      ...super.serialize(),
      ...this.defaultNext?.serialize(),
      ...this.choices.reduce(
        (acc, c) => ({ ...acc, ...c.next.serialize() }),
        {},
      ),
    };
  }

  protected toJSON() {
    return {
      Type: "Choice",
      Choices: this.choices.map((c) => ({
        Condition: c.condition,
        Next: c.next.name,
      })),
      Default: this.defaultNext?.name,
      ...super.toJSON(),
      End: undefined,
    };
  }
}
