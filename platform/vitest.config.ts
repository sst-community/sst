import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Under SST_TEST_PLAIN=1, the `sst` package the components are from
    setupFiles: ["test/setup.ts"],
  },
});
