import { describe, beforeAll, it, expect, vi } from "vitest";
import { appsyncResourcesOf, build } from "./dev-appsync";

const arn = "arn:aws:appsync:us-east-1:111111111111:apis/stageapi";

vi.mock("../../src/components/aws/helpers/bootstrap", async () =>
  (await import("./dev-appsync")).bootstrapMock,
);
vi.mock("../../src/components/rpc/rpc", async () =>
  (await import("./dev-appsync")).rpcMock({
    http: "stageapi.http",
    realtime: "stageapi.realtime",
    arn: "arn:aws:appsync:us-east-1:111111111111:apis/stageapi",
    shared: false,
  }),
);

describe("dev.appsync stage", function () {
  beforeAll(build);

  it("lets a function's stub reach only the stage's Event API", async () => {
    expect(await appsyncResourcesOf("DevFnRole")).toEqual([[arn, `${arn}/*`]]);
  });

  it("lets a task's stub reach only the stage's Event API", async () => {
    expect(await appsyncResourcesOf("DevTaskTaskRole")).toEqual([
      [arn, `${arn}/*`],
    ]);
  });
});
