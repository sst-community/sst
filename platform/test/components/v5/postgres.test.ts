import { expect, it } from "vitest";
import { rdsInstanceSuite } from "./rds-instance.suite";

// What every database on an RDS instance passes, with Postgres's values
rdsInstanceSuite(
  {
    name: "Postgres",
    label: "Postgres",
    server: "PostgreSQL server",
    engine: "postgres",
    load: async () => {
      await import("../../../src/components/aws/takeover/postgres");
      return {
        original: (await import("../../../src/components/aws/postgres"))
          .Postgres,
        v5: (await import("../../../src/components/aws/v5/postgres")).Postgres,
      };
    },
    // 4.x's `Postgres` has a `.v1`, and marks which one a stage has
    versionMarker: true,
    port: 5432,
    devPort: 5433,
    username: "postgres",
    tags: { version: "2", password: "sst:lookup:password" },
    versions: { every: "16.4", output: "15", replica: "17.2" },
    defaults: { version: "17", family: "postgres17", performanceInsights: true },
    chosen: { version: "16.4", family: "postgres16" },
  },
  ({ pulumi, vpc, component, resource }) => {
    it("sets the parameters Postgres needs", async () => {
      const Postgres = component();
      new Postgres("MyDatabase", { vpc });
      await pulumi.settle();

      expect(resource("MyDatabaseParameterGroup").inputs.parameters).toEqual([
        { name: "rds.force_ssl", value: "0" },
        {
          name: "rds.logical_replication",
          value: "1",
          applyMethod: "pending-reboot",
        },
      ]);
    });
  },
);
