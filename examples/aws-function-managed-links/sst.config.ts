/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aws-function-managed-links",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const uploads = new sst.aws.Bucket("Uploads");
    const files = new sst.aws.Bucket("Files");
    const jobs = new sst.aws.Queue("Jobs");

    const fn = new sst.aws.Function("MyFunction", {
      handler: "index.handler",
      link: [uploads, files, jobs],
      linkPermissions: {
        managed: { Storage: [uploads, files], Jobs: [jobs] },
      },
      url: true,
    });

    return { url: fn.url };
  },
});
