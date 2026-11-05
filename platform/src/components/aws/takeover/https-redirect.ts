import { takeover } from "../../takeover";
import { HttpsRedirect } from "../https-redirect";

// 4.x created the redirect's CloudFront function at the top of the app, with
// no parent, so with the app's provider whatever the redirect's was. SST 5's
// keeps it inside, under the same name.
//
// A redirect with a provider of its own gives the function that provider.
// Pulumi asks the new provider whether that replaces it, and AWS's provider
// replaces nothing for a provider change, so the function is kept: its name
// is the old one, as the part ignores changes to it.
takeover(HttpsRedirect, {
  moved: {
    requestFunction: (_, { name }) => ({
      name: `${name}CloudfrontFunctionRequest`,
      parent: false,
    }),
  },
});
