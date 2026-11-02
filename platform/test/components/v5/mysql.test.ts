import { expect, it } from "vitest";
import { rdsInstanceSuite } from "./rds-instance.suite";

type V5Postgres = typeof import("../../../src/components/aws/v5/postgres").Postgres;
type OriginalPostgres = typeof import("../../../src/components/aws/postgres").Postgres;

// What every database on an RDS instance passes, with MySQL's values
rdsInstanceSuite(
  {
    name: "Mysql",
    label: "MySQL",
    server: "MySQL server",
    engine: "mysql",
    load: async () => {
      await import("../../../src/components/aws/takeover/mysql");
      return {
        // The same shape as the `Postgres` the suite is written with
        original: (await import("../../../src/components/aws/mysql"))
          .Mysql as unknown as OriginalPostgres,
        v5: (await import("../../../src/components/aws/v5/mysql"))
          .Mysql as unknown as V5Postgres,
      };
    },
    versionMarker: false,
    port: 3306,
    devPort: 3307,
    username: "root",
    tags: { version: "1", password: "sst:ref:password" },
    versions: { every: "8.4.4", output: "8.0.39", replica: "8.4.4" },
    // Not offered on an instance this small
    defaults: { version: "8.0", family: "mysql8.0", performanceInsights: false },
    chosen: { version: "8.4.4", family: "mysql8.4" },
  },
  ({ pulumi, vpc, component, resource }) => {
    it("sets the parameters MySQL needs", async () => {
      const Mysql = component();
      new Mysql("MyDatabase", { vpc });
      await pulumi.settle();

      expect(resource("MyDatabaseParameterGroup").inputs.parameters).toEqual([
        { name: "require_secure_transport", value: "OFF" },
      ]);
    });

    it("turns performance insights on for instances that offer it", async () => {
      const Mysql = component();
      new Mysql("MyDatabase", { vpc, instance: "m7g.xlarge" });
      await pulumi.settle();

      expect(
        resource("MyDatabaseInstance").inputs.performanceInsightsEnabled,
      ).toBe(true);
    });
  },
);
