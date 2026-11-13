import path from "path";
import { vi } from "vitest";

// SST_TEST_PLAIN=1 runs the components' tests as Pulumi runs a program on its
// own, which has SST's components from the `sst` package. This repo's tests
// have none, so it's stood in for here, and SST's own resources are given
// SST's provider for their cloud, as they are in such a program. Settling
// checks they are (test/helpers/graph.ts).
vi.mock("../src/components/sst-package", async (original) =>
  process.env.SST_TEST_PLAIN === "1"
    ? {
        sstPackage: () => ({
          dir: path.resolve(__dirname, "../.."),
          name: "sst",
          version: "5.0.0-test",
        }),
      }
    : await original(),
);
