import { sstResource, takeover } from "../../takeover";
import { Postgres } from "../postgres";

takeover(Postgres, {
  moved: {
    // The 4.x `Postgres` calls the secret with the master user's credentials
    // the "proxy" secret, though it's created without a proxy too
    secret: "proxySecret",
    secretVersion: "proxySecretVersion",
    // The secret of an additional user was named after the username as it
    // was written
    proxySecret: (_, { name, id }) => ({ name: `${name}ProxySecret${id}` }),
    proxySecretVersion: (_, { name, id }) => ({
      name: `${name}ProxySecretVersion${id}`,
    }),
  },
  // What waits for the role RDS needs before the proxy is created was one of
  // SST's own dynamic resources: the one in its place finds the role
  released: {
    proxyRoleLookup: (_, { name }) =>
      sstResource("aws.RdsRoleLookup", { name: `${name}ProxyRoleLookup` }),
  },
});
