import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

process.on("unhandledRejection", (err: any) => {
  if (err?.code === "ERR_TRACE_EVENTS_UNAVAILABLE") return;
  throw err;
});

// @ts-ignore
global.$app = { name: "app", stage: "test" };
global.$util = pulumi;
// @ts-ignore
global.$dev = false;
// @ts-ignore
global.$jsonStringify = pulumi.jsonStringify;
// @ts-ignore
global.$cli = {
  paths: { root: "/", work: "/.sst", platform: "/" },
  state: { version: {} },
};

interface Created {
  type: string;
  name: string;
  inputs: any;
}

let created: Created[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      created.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}_id`,
        state: { ...args.inputs, arn: `arn:test:${args.name}` },
      };
    },
    call: (args) => {
      if (args.token === "aws:index/getPartition:getPartition")
        return { partition: "aws" };
      if (args.token === "aws:iam/getPolicyDocument:getPolicyDocument")
        return { ...args.inputs, json: JSON.stringify(args.inputs.statements) };
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

async function settle() {
  let count = -1;
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = created.length === count ? quiet + 1 : 0;
    count = created.length;
  }
}

let StepFunctions: typeof import("../../src/components/aws/step-functions").StepFunctions;
let Choice: typeof import("../../src/components/aws/step-functions/choice").Choice;
let Pass: typeof import("../../src/components/aws/step-functions/pass").Pass;
let Succeed: typeof import("../../src/components/aws/step-functions/succeed").Succeed;
let Fail: typeof import("../../src/components/aws/step-functions/fail").Fail;
let Wait: typeof import("../../src/components/aws/step-functions/wait").Wait;
let Parallel: typeof import("../../src/components/aws/step-functions/parallel").Parallel;

beforeAll(async () => {
  StepFunctions = (await import("../../src/components/aws/step-functions"))
    .StepFunctions;
  Choice = (await import("../../src/components/aws/step-functions/choice"))
    .Choice;
  Pass = (await import("../../src/components/aws/step-functions/pass")).Pass;
  Succeed = (await import("../../src/components/aws/step-functions/succeed"))
    .Succeed;
  Fail = (await import("../../src/components/aws/step-functions/fail")).Fail;
  Wait = (await import("../../src/components/aws/step-functions/wait")).Wait;
  Parallel = (await import("../../src/components/aws/step-functions/parallel"))
    .Parallel;
});

let count = 0;

// The definition the state machine is created with
async function definition(state: any) {
  created = [];
  new StepFunctions(`Machine${count++}`, { definition: state });
  await settle();
  const machine = created.find(
    (r) => r.type === "aws:sfn/stateMachine:StateMachine",
  );
  expect(machine).toBeDefined();
  const json: string = await new Promise((resolve) =>
    pulumi.output(machine!.inputs.definition).apply(resolve as any),
  );
  const out = JSON.parse(json);
  return { startAt: out.StartAt, states: Object.keys(out.States).sort(), out };
}

// Start -> Decide -> (DoSomething | DoNothing) -> Finalize -> Complete
function flow() {
  const start = new Pass({ name: "Start" });
  const doSomething = new Pass({ name: "DoSomething" });
  const doNothing = new Pass({ name: "DoNothing" });
  const finalize = new Pass({ name: "Finalize" });
  const complete = new Succeed({ name: "Complete" });
  const decide = new Choice({ name: "Decide" })
    .when("{% $exists($states.input.doSomething) %}", doSomething)
    .otherwise(doNothing);
  start.next(decide);
  doSomething.next(finalize).next(complete);
  doNothing.next(finalize);
  return { start, doSomething, doNothing, finalize, complete, decide };
}

const all = [
  "Complete",
  "Decide",
  "DoNothing",
  "DoSomething",
  "Finalize",
  "Start",
];

describe("StepFunctions definition that is a state after a Choice", () => {
  it("keeps the states before the Choice for the last state", async () => {
    const s = flow();
    const out = await definition(s.complete);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(all);
  });

  it("keeps the states before the Choice for a state of the when branch", async () => {
    const s = flow();
    const out = await definition(s.doSomething);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(all);
  });

  it("keeps the states before the Choice for the otherwise branch", async () => {
    const s = flow();
    const out = await definition(s.doNothing);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(all);
  });

  it("walks up through more than one Choice", async () => {
    const start = new Pass({ name: "Start" });
    const a = new Pass({ name: "A" });
    const b = new Pass({ name: "B" });
    const end = new Succeed({ name: "End" });
    start.next(
      new Choice({ name: "First" })
        .when("{% true %}", a)
        .otherwise(new Fail({ name: "No1" })),
    );
    a.next(
      new Choice({ name: "Second" })
        .when("{% true %}", b)
        .otherwise(new Fail({ name: "No2" })),
    );
    b.next(end);
    const out = await definition(end);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(
      ["A", "B", "End", "First", "No1", "No2", "Second", "Start"].sort(),
    );
  });

  it("walks up out of a Choice in a Parallel branch", async () => {
    const start = new Pass({ name: "Start" });
    const inner = new Pass({ name: "Inner" });
    const parallel = new Parallel({ name: "Both" }).branch(
      new Choice({ name: "Pick" })
        .when("{% true %}", inner)
        .otherwise(new Pass({ name: "Other" })),
    );
    start.next(parallel);
    const out = await definition(inner);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(["Both", "Start"]);
  });
});

describe("StepFunctions definitions that already work stay the same", () => {
  it("keeps every state of a branch written as a chain", async () => {
    const start = new Pass({ name: "Start" });
    const a = new Pass({ name: "StepA" });
    const b = new Pass({ name: "StepB" });
    const end = new Succeed({ name: "End" });
    start.next(
      new Choice({ name: "Decide" })
        .when("{% true %}", a.next(b))
        .otherwise(new Fail({ name: "No" })),
    );
    b.next(end);
    const out = await definition(end);
    expect(out.states).toContain("StepA");
    expect(out.states).toContain("StepB");
  });

  it("first state", async () => {
    const s = flow();
    const out = await definition(s.start);
    expect(out.startAt).toBe("Start");
    expect(out.states).toEqual(all);
  });

  it("the Choice, or start.next(choice)", async () => {
    const a = flow();
    const fromChoice = await definition(a.decide);
    const b = flow();
    const fromStart = await definition(b.start);
    expect(fromChoice.out).toEqual(fromStart.out);
  });

  it("a chain shaped like the aws-step-functions example", async () => {
    const pass = new Pass({ name: "Pass" });
    const wait = new Wait({ name: "Wait", time: "2 seconds" });
    const choice = new Choice({ name: "Choice" });
    const parallel = new Parallel({ name: "Parallel" });
    const success = new Succeed({ name: "Succeed" });
    const fail = new Fail({ name: "Fail" });
    const last = new Pass({ name: "Last" });
    const first = new Pass({ name: "First" });
    const out = await definition(
      first
        .next(pass)
        .next(wait)
        .next(
          parallel
            .branch(new Pass({ name: "ParallelA" }))
            .branch(new Pass({ name: "ParallelC" })),
        )
        .next(
          choice
            .when("{% 1+1 = 2 %}", success)
            .when("{% 1+1 = 3 %}", fail)
            .otherwise(last),
        ),
    );
    expect(out.startAt).toBe("First");
    expect(out.states).toEqual(
      ["Choice", "Fail", "First", "Last", "Parallel", "Pass", "Succeed", "Wait"],
    );
  });
});

describe("Choice branch written as a chain", () => {
  it("when() starts the branch at the chain's first state", async () => {
    const a = new Pass({ name: "StepA" });
    const b = new Pass({ name: "StepB" });
    const decide = new Choice({ name: "Decide" })
      .when("{% true %}", a.next(b))
      .otherwise(new Pass({ name: "Fallback" }));
    const out = await definition(decide);
    expect(out.out.States.Decide.Choices[0].Next).toBe("StepA");
    expect(out.out.States.StepA.Next).toBe("StepB");
    expect(out.states).toEqual(["Decide", "Fallback", "StepA", "StepB"]);
  });

  it("otherwise() starts the branch at the chain's first state", async () => {
    const a = new Pass({ name: "StepA" });
    const b = new Pass({ name: "StepB" });
    const decide = new Choice({ name: "Decide" })
      .when("{% true %}", new Pass({ name: "Match" }))
      .otherwise(a.next(b));
    const out = await definition(decide);
    expect(out.out.States.Decide.Default).toBe("StepA");
    expect(out.out.States.StepA.Next).toBe("StepB");
    expect(out.states).toEqual(["Decide", "Match", "StepA", "StepB"]);
  });

  it("a state in the middle of a chain also starts the branch at the chain's first state", async () => {
    // Before this change, the cached path went straight to Respond.
    const fetch = new Pass({ name: "Fetch" });
    const respond = new Pass({ name: "Respond" });
    fetch.next(respond);
    const cached = new Choice({ name: "Cached" })
      .when("{% $states.input.cached %}", respond)
      .otherwise(fetch);
    const out = await definition(cached);
    expect(out.out.States.Cached.Choices[0].Next).toBe("Fetch");
    expect(out.out.States.Cached.Default).toBe("Fetch");
  });

  it("keeps the states before the Choice when the definition is the chain's last state", async () => {
    const start = new Pass({ name: "Start" });
    const a = new Pass({ name: "StepA" });
    const b = new Pass({ name: "StepB" });
    start.next(
      new Choice({ name: "Decide" })
        .when("{% true %}", a.next(b))
        .otherwise(new Fail({ name: "No" })),
    );
    const out = await definition(b);
    expect(out.startAt).toBe("Start");
    expect(out.out.States.Decide.Choices[0].Next).toBe("StepA");
    expect(out.states).toEqual(["Decide", "No", "Start", "StepA", "StepB"]);
  });
});
