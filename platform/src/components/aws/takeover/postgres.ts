import { takeover } from "../../takeover";
import { PostgresV5 } from "../postgres-v5";

takeover(PostgresV5, {
  from: "sst:aws:Postgres",
  moved: {
    // `Postgres` calls the secret with the master user's credentials the
    // "proxy" secret, though it's created without a proxy too
    secret: "proxySecret",
    secretVersion: "proxySecretVersion",
    // The secret of an additional user was named after the username as it
    // was written
    proxySecret: (_, { name, id }) => ({ name: `${name}ProxySecret${id}` }),
    proxySecretVersion: (_, { name, id }) => ({
      name: `${name}ProxySecretVersion${id}`,
    }),
  },
});
