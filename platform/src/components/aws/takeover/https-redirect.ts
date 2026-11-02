import { takeover } from "../../takeover";
import { HttpsRedirect } from "../v5/https-redirect";

// 4.x created the redirect's CloudFront function at the top of the app, with
// no parent, so with the app's provider whatever the redirect's was. The V5
// redirect keeps it inside, under the same name.
//
// A redirect with a provider of its own gives the function that provider,
// which Pulumi carries out by replacing it, and the replacement keeps the
// function's name, which CloudFront refuses while the old one is there. So
// the map doesn't list that replace, and `sst migrate --check` refuses the
// move before anything changes.
takeover(HttpsRedirect, {
  moved: {
    requestFunction: (_, { name }) => ({
      name: `${name}CloudfrontFunctionRequest`,
      parent: false,
    }),
  },
});
