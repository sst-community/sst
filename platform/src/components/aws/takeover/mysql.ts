import { takeover } from "../../takeover";
import { MysqlV5 } from "../mysql-v5";

takeover(MysqlV5, {
  from: "sst:aws:Mysql",
  moved: {
    // `Mysql` calls the secret with the master user's credentials the
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
