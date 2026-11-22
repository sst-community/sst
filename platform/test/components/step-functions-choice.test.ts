import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

pulumi.runtime.setMocks(
  {
    newResource: (args) => ({ id: `${args.name}_id`, state: args.inputs }),
    call: (args) => args.inputs,
  },
  "project",
  "stack",
  false,
);

function resolve<T>(value: pulumi.Input<T>) {
  return new Promise<any>((resolve) => pulumi.output(value).apply(resolve));
}

let Choice: typeof import("../../src/components/aws/step-functions/choice").Choice;
let Pass: typeof import("../../src/components/aws/step-functions/pass").Pass;
let Succeed: typeof import("../../src/components/aws/step-functions/succeed").Succeed;
let Fail: typeof import("../../src/components/aws/step-functions/fail").Fail;
let Parallel: typeof import("../../src/components/aws/step-functions/parallel").Parallel;
let Map: typeof import("../../src/components/aws/step-functions/map").Map;

beforeAll(async () => {
  Choice = (await import("../../src/components/aws/step-functions/choice"))
    .Choice;
  Pass = (await import("../../src/components/aws/step-functions/pass")).Pass;
  Succeed = (await import("../../src/components/aws/step-functions/succeed"))
    .Succeed;
  Fail = (await import("../../src/components/aws/step-functions/fail")).Fail;
  Parallel = (await import("../../src/components/aws/step-functions/parallel"))
    .Parallel;
  Map = (await import("../../src/components/aws/step-functions/map")).Map;
});

// What the StepFunctions component does with `definition`.
async function build(definition: any) {
  const root = definition.getRoot();
  root.assertStateNameUnique();
  root.assertStateNotReused();
  return {
    StartAt: root.name,
    States: JSON.parse(JSON.stringify(await resolve(root.serialize()))),
  };
}

describe("Choice afterwards", () => {
  it("continues both branches to the same state (upstream #5997)", async () => {
    const start = new Pass({ name: "Start" });
    const decision = new Choice({ name: "Decide" })
      .when("{% $exists($states.input.doSomething) %}", new Pass({ name: "DoSomething" }))
      .otherwise(new Pass({ name: "DoNothing" }));
    const definition = start
      .next(decision)
      .afterwards()
      .next(new Pass({ name: "Finalize" }))
      .next(new Succeed({ name: "Complete" }));

    const { StartAt, States } = await build(definition);
    expect(StartAt).toBe("Start");
    expect(Object.keys(States).sort()).toEqual(
      ["Complete", "Decide", "DoNothing", "DoSomething", "Finalize", "Start"],
    );
    expect(States.Start.Next).toBe("Decide");
    expect(States.Decide.Choices[0].Next).toBe("DoSomething");
    expect(States.Decide.Default).toBe("DoNothing");
    expect(States.DoSomething.Next).toBe("Finalize");
    expect(States.DoNothing.Next).toBe("Finalize");
    expect(States.DoSomething.End).toBeUndefined();
    expect(States.Finalize.Next).toBe("Complete");
  });

  it("gives the same definition as linking each branch by hand", async () => {
    const make = () => {
      const start = new Pass({ name: "Start" });
      const a = new Pass({ name: "A" });
      const b = new Pass({ name: "B" });
      const decision = new Choice({ name: "Decide" })
        .when("{% true %}", a)
        .otherwise(b);
      start.next(decision);
      return { start, a, b, decision };
    };

    const manual = make();
    const join = new Pass({ name: "Join" });
    manual.a.next(join);
    manual.b.next(join);

    const viaAfterwards = make();
    viaAfterwards.decision.afterwards().next(new Pass({ name: "Join" }));

    expect(await build(viaAfterwards.start)).toEqual(await build(manual.start));
  });

  it("continues a branch that already has a next from its last state", async () => {
    const a = new Pass({ name: "A" });
    a.next(new Pass({ name: "B" }));
    const decision = new Choice({ name: "Decide" })
      .when("{% true %}", a)
      .otherwise(new Pass({ name: "C" }));
    const definition = decision.afterwards().next(new Pass({ name: "Join" }));

    const { StartAt, States } = await build(definition);
    expect(StartAt).toBe("Decide");
    expect(States.A.Next).toBe("B");
    expect(States.B.Next).toBe("Join");
    expect(States.C.Next).toBe("Join");
    expect(States.Join.End).toBe(true);
  });

  it("leaves branches that end in Succeed or Fail as they are", async () => {
    const decision = new Choice({ name: "Decide" })
      .when("{% $states.input.done %}", new Succeed({ name: "Done" }))
      .when("{% $states.input.bad %}", new Fail({ name: "Bad" }))
      .otherwise(new Pass({ name: "Work" }));
    const definition = decision.afterwards().next(new Pass({ name: "Join" }));

    const { States } = await build(definition);
    expect(States.Done).toEqual({ Type: "Succeed", QueryLanguage: "JSONata" });
    expect(States.Bad).toEqual({ Type: "Fail", QueryLanguage: "JSONata" });
    expect(States.Work.Next).toBe("Join");
  });

  it("continues the branches of a nested Choice", async () => {
    const inner = new Choice({ name: "Inner" })
      .when("{% $states.input.x %}", new Pass({ name: "X" }))
      .otherwise(new Pass({ name: "Y" }));
    const outer = new Choice({ name: "Outer" })
      .when("{% $states.input.nested %}", inner)
      .otherwise(new Pass({ name: "Z" }));
    const definition = outer.afterwards().next(new Pass({ name: "Join" }));

    const { StartAt, States } = await build(definition);
    expect(StartAt).toBe("Outer");
    expect(States.Inner.Choices[0].Next).toBe("X");
    expect(States.Inner.Default).toBe("Y");
    expect(States.Inner.Next).toBeUndefined();
    expect(States.X.Next).toBe("Join");
    expect(States.Y.Next).toBe("Join");
    expect(States.Z.Next).toBe("Join");
  });

  it("throws when no branch can continue", () => {
    const decision = new Choice({ name: "Decide" })
      .when("{% true %}", new Succeed({ name: "Done" }))
      .otherwise(new Fail({ name: "Bad" }));
    expect(() => decision.afterwards().next(new Pass({ name: "Join" }))).toThrow(
      'The "Decide" state has no branch that can continue to "Join".',
    );
  });

  it("starts a Parallel branch at the Choice when given the state after it", async () => {
    const decision = new Choice({ name: "Decide" })
      .when("{% true %}", new Pass({ name: "A" }))
      .otherwise(new Pass({ name: "B" }));
    const parallel = new Parallel({ name: "Both" }).branch(
      decision.afterwards().next(new Pass({ name: "Join" })),
    );
    const definition = new Pass({ name: "Start" }).next(parallel);

    const { StartAt, States } = await build(definition);
    expect(StartAt).toBe("Start");
    const branch = States.Both.Branches[0];
    expect(branch.StartAt).toBe("Decide");
    expect(Object.keys(branch.States).sort()).toEqual(["A", "B", "Decide", "Join"]);
    expect(branch.States.A.Next).toBe("Join");
    expect(branch.States.B.Next).toBe("Join");
  });

  it("starts a Map processor at the Choice when given the state after it", async () => {
    const decision = new Choice({ name: "Decide" })
      .when("{% true %}", new Pass({ name: "A" }))
      .otherwise(new Pass({ name: "B" }));
    const map = new Map({
      name: "Each",
      processor: decision.afterwards().next(new Pass({ name: "Join" })),
    });
    const definition = new Pass({ name: "Start" }).next(map);

    const { StartAt, States } = await build(definition);
    expect(StartAt).toBe("Start");
    const processor = States.Each.ItemProcessor;
    expect(processor.StartAt).toBe("Decide");
    expect(Object.keys(processor.States).sort()).toEqual(["A", "B", "Decide", "Join"]);
    expect(processor.States.A.Next).toBe("Join");
    expect(processor.States.B.Next).toBe("Join");
  });
});
