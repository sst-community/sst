/// <reference path="./.sst/platform/config.d.ts" />

/**
 * ## AWS static site without edge routing
 *
 * Serve a static site straight from its bucket, without a CloudFront Function or
 * KeyValueStore. Useful for a single-page app, or when a policy on your account, like a
 * service control policy that limits regions, denies the KeyValueStore API.
 *
 * ```ts title="sst.config.ts" {4}
 * new sst.aws.StaticSite("MySite", {
 *   path: "site",
 *   errorPage: "404.html",
 *   edgeRouting: false,
 * });
 * ```
 *
 * `/` serves `index.html`, other paths serve the file at that exact path, like
 * `/about.html`, and missing files serve the `errorPage`. Unlike the default, `/about`
 * doesn't serve `about.html`.
 */
export default $config({
  app(input) {
    return {
      name: "aws-static-site-no-edge-routing",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    new sst.aws.StaticSite("MySite", {
      path: "site",
      errorPage: "404.html",
      edgeRouting: false,
    });
  },
});
