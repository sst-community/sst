import { takeover } from "../../takeover.js";
import { CognitoUserPoolClientV5 } from "../cognito-user-pool-client-v5.js";

// A client is laid out the way it was: a component named after the client,
// holding the client.
takeover(CognitoUserPoolClientV5, { from: "sst:aws:CognitoUserPoolClient" });
