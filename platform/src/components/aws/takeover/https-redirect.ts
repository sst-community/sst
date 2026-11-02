import { takeover } from "../../takeover";
import { HttpsRedirect } from "../v5/https-redirect";

// 4.x created the redirect's CloudFront function at the top of the app, with
// no parent, so with the app's provider whatever the redirect's was. The V5
// redirect keeps it inside, under the same name, with the redirect's
// provider: one that has a provider of its own creates it again.
takeover(HttpsRedirect, {
  moved: {
    requestFunction: (_, { name }) => ({
      name: `${name}CloudfrontFunctionRequest`,
      parent: false,
    }),
  },
  replaced: {
    requestFunction:
      "A redirect with a provider of its own creates its CloudFront function again, with that provider.",
  },
});
