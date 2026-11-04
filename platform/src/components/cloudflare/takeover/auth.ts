import { takeover } from "../../takeover";
import { Auth } from "../v5/auth";

// The 4.x `Auth` created its key pair and its Worker at the top of the app.
// The V5 one keeps them inside, with the names they had.
takeover(Auth, {
  moved: {
    key: (_, { name }) => ({ name: `${name}Keypair`, parent: false }),
    authenticator: (_, { name }) => ({
      name: `${name}Authenticator`,
      parent: false,
    }),
  },
});
