import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { AppSync } from "../v5/app-sync";
import { childOf } from "./helpers";

// The 4.x `AppSync` keeps each data source, AppSync function and resolver in a
// component of its own, next to the API. The V5 one keeps their resources
// inside the API, under the data source's or function's name, or the resolver's
// operation.
const DATA_SOURCE = "sst:aws:AppSyncDataSource";
const dataSource = (api: string, id = "") =>
  `${api}DataSource${logicalName(id)}`;

const FUNCTION = "sst:aws:AppSyncFunction";
const fn = (api: string, id = "") => `${api}Function${logicalName(id)}`;

// A resolver's component was named after the operation's type and field:
// `QueryUser` for "Query user".
const RESOLVER = "sst:aws:AppSyncResolver";
const resolver = (api: string, id = "") =>
  `${api}Resolver${id.split(" ").map(logicalName).join("")}`;

// Two things the 4.x `AppSync` created with no parent at all, beside the API
// rather than inside anything: the function of a Lambda data source given as a
// handler, and the association between a custom domain and the API.
takeover(AppSync, {
  from: "sst:aws:AppSync",
  moved: {
    certificate: "ssl",
    domainAssociation: (_, { name }) => ({
      name: `${name}DomainAssociation`,
      parent: false,
    }),
    dataSourceFunction: (_, { name, id }) => ({
      name: `${dataSource(name, id)}Function`,
      parent: false,
    }),
    dataSource: (_, { name, id }) =>
      childOf(DATA_SOURCE, dataSource(name, id), "DataSource"),
    serviceRole: (_, { name, id }) =>
      childOf(DATA_SOURCE, dataSource(name, id), "ServiceRole"),
    function: (_, { name, id }) => childOf(FUNCTION, fn(name, id), "Function"),
    resolver: (_, { name, id }) =>
      childOf(RESOLVER, resolver(name, id), "Resolver"),
  },
});
