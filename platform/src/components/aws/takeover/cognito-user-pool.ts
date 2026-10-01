import { takeover } from "../../takeover";
import { CognitoUserPool } from "../v5/cognito-user-pool";
import { childOf } from "./helpers";

// The 4.x `CognitoUserPool` keeps each identity provider in a component of its
// own. That component isn't inside the user pool or named after it: it's next
// to it, under the name the provider was added with. The V5 one keeps them
// inside the user pool, under that name.
const IDENTITY_PROVIDER = "sst:aws:CognitoIdentityProvider";

takeover(CognitoUserPool, {
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
