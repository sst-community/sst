import { sstResource, takeover } from "../../takeover";
import { Function } from "../function";

takeover(Function, {
  moved: {
    // The 4.x `Function` names the two permissions of a URL after who they're
    // for: everyone, or the distribution of the router the URL is behind.
    urlAccess: (_, { name }) => [
      { name: `${name}PublicFunctionUrlAccess` },
      { name: `${name}CloudFrontFunctionUrlAccess` },
    ],
    urlInvoke: (_, { name }) => [
      { name: `${name}InvokeFunction` },
      { name: `${name}PublicInvokeFunction` },
      { name: `${name}CloudFrontInvokeFunction` },
    ],
    // The 4.x `Function` creates the alias outside of the function, with no
    // parent
    urlAlias: (_, { name }) => ({ name: `${name}Durable`, parent: false }),
  },
  // Its route's entry in a router's key-value store, its route in the
  // router's list and what it added to its environment were SST's own
  // dynamic resources
  released: {
    routeKey: (_, { name }) =>
      sstResource("aws.KvKeys", { name: `${name}RouteKey` }),
    routesUpdate: (_, { name }) =>
      sstResource("aws.KvRoutesUpdate", { name: `${name}RoutesUpdate` }),
    environmentUpdate: (_, { name }) =>
      sstResource("aws.FunctionEnvironmentUpdate", {
        name: `${name}EnvironmentUpdate`,
      }),
  },
  // Each is an object keyed by what's in it, and is uploaded under a new key
  // whenever the function's code changes, as when it's renamed
  replaced: {
    code: "The function's code is uploaded again, under a new key.",
    sourcemap: "The function's source map is uploaded again, under a new key.",
  },
});
