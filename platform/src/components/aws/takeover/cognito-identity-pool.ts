import { takeover } from "../../takeover";
import { CognitoIdentityPool } from "../cognito-identity-pool";

// Nothing moved. The map says the 4.x form has this 5.0 form, so a stage
// switches it with `sst migrate`, and a new stage refuses the 4.x one.
takeover(CognitoIdentityPool, {});
