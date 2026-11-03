import { takeover } from "../../takeover";
import { Vector } from "../v5/vector";
import { childWithin } from "./helpers";

// The 4.x `Vector` kept its database in a `Postgres.v1` inside it, named
// after the vector with `Database` added. The V5 one keeps the database's
// resources itself. Its table and functions have the names they had.
const database = (vector: Vector, name: string, child: string) =>
  childWithin("sst:aws:Postgres", `${name}Database`, child, vector);

takeover(Vector, {
  moved: {
    cluster: (vector, { name }) => database(vector, name, "Cluster"),
    instance: (vector, { name }) => database(vector, name, "Instance"),
    subnetGroup: (vector, { name }) => database(vector, name, "SubnetGroup"),
  },
});
