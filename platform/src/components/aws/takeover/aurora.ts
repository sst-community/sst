import { takeover } from "../../takeover";
import { Aurora } from "../v5/aurora";

takeover(Aurora, {
  moved: {
    // The 4.x `Aurora` calls the secret with the master user's credentials the
    // "proxy" secret, though it's created without a proxy too
    secret: "proxySecret",
    secretVersion: "proxySecretVersion",
    // The instances' parameter group was the only one named plainly
    instanceParameterGroup: "parameterGroup",
    // The secret of an additional user was named after the username as it
    // was written
    proxySecret: (_, { name, id }) => ({ name: `${name}ProxySecret${id}` }),
    proxySecretVersion: (_, { name, id }) => ({
      name: `${name}ProxySecretVersion${id}`,
    }),
  },
});
