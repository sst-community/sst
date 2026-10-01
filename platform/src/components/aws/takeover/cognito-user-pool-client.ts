import { takeover } from "../../takeover";
import { CognitoUserPoolClient } from "../v5/cognito-user-pool-client";

// A client is laid out the way it was: a component named after the client,
// holding the client.
takeover(CognitoUserPoolClient, { from: "sst:aws:CognitoUserPoolClient" });
