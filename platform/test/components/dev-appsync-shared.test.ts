import { describe, beforeAll, it, expect, vi } from "vitest";
import { appsyncResourcesOf, build } from "./dev-appsync";

vi.mock("../../src/components/aws/helpers/bootstrap", async () =>
  (await import("./dev-appsync")).bootstrapMock,
);
vi.mock("../../src/components/rpc/rpc", async () =>
  (await import("./dev-appsync")).rpcMock({
    http: "shared.http",
    realtime: "shared.realtime",
    arn: "arn:aws:appsync:us-east-1:111111111111:apis/shared",
    shared: true,
  }),
);

describe("dev.appsync shared", function () {
  beforeAll(build);

  it("lets a function's stub reach any Event API, as before", async () => {
    expect(await appsyncResourcesOf("DevFnRole")).toEqual([["*"]]);
  });

  it("lets a task's stub reach any Event API, as before", async () => {
    expect(await appsyncResourcesOf("DevTaskTaskRole")).toEqual([["*"]]);
  });
});
