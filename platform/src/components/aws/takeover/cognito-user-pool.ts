import { takeover } from "../../takeover.js";
import { CognitoUserPoolV5 } from "../cognito-user-pool-v5.js";
import { childOf } from "./helpers.js";

// `CognitoUserPool` keeps each identity provider in a component of its own.
// That component isn't inside the user pool or named after it: it's next to
// it, under the name the provider was added with. `CognitoUserPoolV5` keeps
// them inside the user pool, under that name.
const IDENTITY_PROVIDER = "sst:aws:CognitoIdentityProvider";

takeover(CognitoUserPoolV5, {
  from: "sst:aws:CognitoUserPool",
  moved: {
    certificate: "ssl",
    // A trigger's function and permission were named after the trigger the
    // way it's written, "preSignUp", without a capital.
    trigger: (_, { name, id }) => ({ name: `${name}Trigger${id}` }),
    permission: (_, { name, id }) => ({ name: `${name}Permission${id}` }),
    identityProvider: (_, { id }) =>
      childOf(IDENTITY_PROVIDER, id!, "IdentityProvider"),
  },
});
