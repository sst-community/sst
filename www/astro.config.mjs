import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import config from "./config";
import forkLinks from "./src/fork-links.mjs";
import { rehypeHeadingIds } from "@astrojs/markdown-remark";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

const sidebar = [
  { label: "Intro", slug: "docs" },
  { label: "Basics", slug: "docs/basics" },
  { label: "Examples", slug: "docs/examples" },
  { label: "Changelog", slug: "docs/changelog" },
  {
    label: "Get Started",
    collapsed: true,
    items: [
      { label: "Bun", slug: "docs/start/aws/bun" },
      { label: "Nuxt", slug: "docs/start/aws/nuxt" },
      { label: "Solid", slug: "docs/start/aws/solid" },
      { label: "Auth", slug: "docs/start/aws/auth" },
      { label: "Deno", slug: "docs/start/aws/deno" },
      { label: "tRPC", slug: "docs/start/aws/trpc" },
      { label: "Hono", slug: "docs/start/aws/hono" },
      { label: "Astro", slug: "docs/start/aws/astro" },
      { label: "Email", slug: "docs/start/aws/email" },
      { label: "React", slug: "docs/start/aws/react" },
      { label: "Remix", slug: "docs/start/aws/remix" },
      { label: "Svelte", slug: "docs/start/aws/svelte" },
      { label: "Drizzle", slug: "docs/start/aws/drizzle" },
      { label: "Prisma", slug: "docs/start/aws/prisma" },
      { label: "Next.js", slug: "docs/start/aws/nextjs" },
      { label: "Analog", slug: "docs/start/aws/analog" },
      { label: "NestJS", slug: "docs/start/aws/nestjs" },
      { label: "Angular", slug: "docs/start/aws/angular" },
      { label: "Express", slug: "docs/start/aws/express" },
      { label: "Realtime", slug: "docs/start/aws/realtime" },
      { label: "TanStack", slug: "docs/start/aws/tanstack" },
      {
        label: "Cloudflare",
        items: [
          { label: "tRPC", slug: "docs/start/cloudflare/trpc" },
          { label: "Hono", slug: "docs/start/cloudflare/hono" },
          { label: "Worker", slug: "docs/start/cloudflare/worker" },
        ],
      },
    ],
  },
  {
    label: "Concepts",
    items: [
      "docs/live",
      "docs/state",
      "docs/linking",
      "docs/console",
      "docs/providers",
      "docs/components",
    ],
  },
  {
    label: "How to",
    collapsed: true,
    items: [
      { label: "Cloudflare", slug: "docs/cloudflare" },
      { label: "PlanetScale", slug: "docs/planetscale" },
      { label: "Policy Packs", slug: "docs/policy-packs" },
      { label: "AWS Accounts", slug: "docs/aws-accounts" },
      { label: "IAM Credentials", slug: "docs/iam-credentials" },
      { label: "Migrate From v2", slug: "docs/migrate-from-v2" },
      { label: "Migrate From v3", slug: "docs/migrate-from-v3" },
      { label: "Custom Domains", slug: "docs/custom-domains" },
      { label: "Import Resources", slug: "docs/import-resources" },
      { label: "Set up a Monorepo", slug: "docs/set-up-a-monorepo" },
      { label: "Configure a Router", slug: "docs/configure-a-router" },
      { label: "Share Across Stages", slug: "docs/share-across-stages" },
      { label: "Reference Resources", slug: "docs/reference-resources" },
      { label: "Environment Variables", slug: "docs/environment-variables" },
      { label: "Upgrade AWS Databases", slug: "docs/upgrade-aws-databases" },
    ],
  },
  {
    label: "Components",
    items: [
      {
        label: "AWS",
        collapsed: true,
        items: [
          "docs/component/aws/efs",
          "docs/component/aws/bus",
          "docs/component/aws/vpc",
          "docs/component/aws/task",
          {
            label: "Cron",
            slug: "docs/component/aws/cron-v2",
          },
          "docs/component/aws/auth",
          "docs/component/aws/nuxt",
          "docs/component/aws/dsql",
          "docs/component/aws/astro",
          "docs/component/aws/redis",
          "docs/component/aws/email",
          "docs/component/aws/react",
          "docs/component/aws/mysql",
          "docs/component/aws/remix",
          "docs/component/aws/queue",
          "docs/component/aws/nextjs",
          "docs/component/aws/aurora",
          "docs/component/aws/router",
          "docs/component/aws/analog",
          "docs/component/aws/bucket",
          "docs/component/aws/cluster",
          "docs/component/aws/service",
          "docs/component/aws/dynamo",
          "docs/component/aws/workflow",
          "docs/component/aws/realtime",
          "docs/component/aws/sns-topic",
          "docs/component/aws/function",
          "docs/component/aws/postgres",
          "docs/component/aws/app-sync",
          "docs/component/aws/svelte-kit",
          "docs/component/aws/static-site",
          "docs/component/aws/solid-start",
          "docs/component/aws/open-search",
          "docs/component/aws/tan-stack-start",
          "docs/component/aws/kinesis-stream",
          "docs/component/aws/apigatewayv1",
          "docs/component/aws/apigatewayv2",
          "docs/component/aws/step-functions",
          "docs/component/aws/cognito-user-pool",
          "docs/component/aws/cognito-identity-pool",
          "docs/component/aws/apigateway-websocket",
          {
            label: "Internal",
            collapsed: true,
            items: [
              "docs/component/aws/alb",
              "docs/component/aws/cdn",
              "docs/component/aws/app-sync-resolver",
              "docs/component/aws/app-sync-function",
              "docs/component/aws/bucket-notification",
              "docs/component/aws/app-sync-data-source",
              "docs/component/aws/apigatewayv1-api-key",
              "docs/component/aws/bus-queue-subscriber",
              "docs/component/aws/cognito-user-pool-client",
              "docs/component/aws/bus-lambda-subscriber",
              "docs/component/aws/apigatewayv2-url-route",
              "docs/component/aws/apigatewayv1-authorizer",
              "docs/component/aws/apigatewayv1-usage-plan",
              "docs/component/aws/apigatewayv2-authorizer",
              "docs/component/aws/queue-lambda-subscriber",
              "docs/component/aws/sns-topic-queue-subscriber",
              "docs/component/aws/dynamo-lambda-subscriber",
              "docs/component/aws/realtime-lambda-subscriber",
              "docs/component/aws/sns-topic-lambda-subscriber",
              "docs/component/aws/apigatewayv1-lambda-route",
              "docs/component/aws/apigatewayv2-lambda-route",
              "docs/component/aws/apigateway-websocket-route",
              "docs/component/aws/providers/function-environment-update",
              "docs/component/aws/apigatewayv1-integration-route",
              "docs/component/aws/kinesis-stream-lambda-subscriber",
              {
                label: "StepFunctions",
                collapsed: true,
                items: [
                  {
                    label: "Fail",
                    slug: "docs/component/aws/step-functions/fail",
                  },
                  {
                    label: "Map",
                    slug: "docs/component/aws/step-functions/map",
                  },
                  {
                    label: "Wait",
                    slug: "docs/component/aws/step-functions/wait",
                  },
                  {
                    label: "Task",
                    slug: "docs/component/aws/step-functions/task",
                  },
                  {
                    label: "Pass",
                    slug: "docs/component/aws/step-functions/pass",
                  },
                  {
                    label: "State",
                    slug: "docs/component/aws/step-functions/state",
                  },
                  {
                    label: "Choice",
                    slug: "docs/component/aws/step-functions/choice",
                  },
                  {
                    label: "Parallel",
                    slug: "docs/component/aws/step-functions/parallel",
                  },
                  {
                    label: "Succeed",
                    slug: "docs/component/aws/step-functions/succeed",
                  },
                ],
              },
            ],
          },
          {
            label: "Deprecated",
            collapsed: true,
            items: [
              { label: "Cron", slug: "docs/component/aws/cron" },
              { label: "OpenControl", slug: "docs/component/aws/opencontrol" },
              { label: "Vpc.v1", slug: "docs/component/aws/vpc-v1" },
              { label: "Redis.v1", slug: "docs/component/aws/redis-v1" },
              { label: "Service.v1", slug: "docs/component/aws/service-v1" },
              { label: "Cluster.v1", slug: "docs/component/aws/cluster-v1" },
              { label: "Postgres.v1", slug: "docs/component/aws/postgres-v1" },
              { label: "Vector", slug: "docs/component/aws/vector" },
            ],
          },
        ],
      },
      {
        label: "Cloudflare",
        collapsed: true,
        items: [
          "docs/component/cloudflare/ai",
          "docs/component/cloudflare/d1",
          "docs/component/cloudflare/kv",
          "docs/component/cloudflare/cron",
          "docs/component/cloudflare/astro",
          "docs/component/cloudflare/queue",
          "docs/component/cloudflare/worker",
          "docs/component/cloudflare/bucket",
          "docs/component/cloudflare/workflow",
          "docs/component/cloudflare/rate-limit",
          { label: "StaticSite", slug: "docs/component/cloudflare/static-site-v2" },
          "docs/component/cloudflare/hyperdrive",
          "docs/component/cloudflare/react-router",
          "docs/component/cloudflare/tan-stack-start",
          {
            label: "Internal",
            collapsed: true,
            items: ["docs/component/cloudflare/queue-worker-subscriber"],
          },
          {
            label: "Deprecated",
            collapsed: true,
            items: [
              { label: "StaticSite", slug: "docs/component/cloudflare/static-site" },
            ],
          },
        ],
      },
      {
        label: "Internal",
        collapsed: true,
        items: [
          {
            label: "Dns",
            items: [
              { label: "AWS", slug: "docs/component/aws/dns" },
              { label: "Vercel", slug: "docs/component/vercel/dns" },
              { label: "Cloudflare", slug: "docs/component/cloudflare/dns" },
            ],
          },
          {
            label: "Linkable",
            items: [
              { label: "binding", slug: "docs/component/cloudflare/binding" },
              { label: "permission", slug: "docs/component/aws/permission" },
            ],
          },
        ],
      },
      "docs/all-providers",
    ],
  },
  {
    label: "Reference",
    collapsed: true,
    items: [
      "docs/reference/cli",
      "docs/reference/sdk",
      "docs/reference/global",
      "docs/reference/config",
      "docs/component/secret",
      "docs/component/linkable",
      "docs/component/experimental/dev-command",
    ],
  },
];

if (import.meta.env.DEV) {
  sidebar.push({
    label: "Dummy",
    items: [{ slug: "dummy/tsdoc" }, { slug: "dummy/markdown" }],
  });
}

// The sst-community docs are a static site on GitHub Pages, under this path.
const base = "/sst";

// https://astro.build/config
export default defineConfig({
  site: "https://sst-community.github.io",
  base,
  server: {
    host: "0.0.0.0",
  },
  prefetch: import.meta.env.DEV ? false : true,
  devToolbar: {
    enabled: false,
  },
  redirects: {
    "/install": "https://raw.githubusercontent.com/sst-community/sst/main/install",
    "/guide": "https://guide.sst.dev",
    "/docs/workflow": `${base}/docs/basics`,
    "/docs/start/aws/container": `${base}/docs/start/aws/express`,
    "/docs/common-errors": `${base}/docs/component/aws/svelte-kit/#assets`,
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes("/dummy/"),
    }),
    starlight({
      title: "sst-community",
      // Dates come from git. CI leaves them out to build faster, except the
      // build that publishes the site (docs.yml sets DOCS_LAST_UPDATED).
      lastUpdated: !process.env.CI || process.env.DOCS_LAST_UPDATED === "true",
      favicon: "/fork-favicon.svg",
      pagination: false,
      markdown: {
        // Use custom heading links
        headingLinks: false,
      },
      customCss: [
        "@fontsource-variable/rubik",
        "@fontsource-variable/roboto-mono",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/400-italic.css",
        "@fontsource/ibm-plex-mono/500.css",
        "@fontsource/ibm-plex-mono/600.css",
        "@fontsource/ibm-plex-mono/700.css",
        "./src/custom.css",
        "./src/styles/splash.css",
        "./src/styles/lander.css",
        "./src/styles/markdown.css",
        "./src/styles/tsdoc.css",
        "./src/styles/heading.css",
      ],
      social: [
        { icon: "github", label: "GitHub", href: config.fork },
        { icon: "discord", label: "Discord", href: config.forkDiscord },
      ],
      editLink: {
        baseUrl: "https://github.com/sst-community/sst/edit/main/www",
      },
      components: {
        Hero: "./src/components/Hero.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
        PageSidebar: "./src/components/PageSidebar.astro",
        MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
      },
      head: [
        // Add light/dark mode favicon
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: `${base}/fork-favicon.svg`,
            media: "(prefers-color-scheme: light)",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: `${base}/fork-favicon.svg`,
            media: "(prefers-color-scheme: dark)",
          },
        },
      ],
      sidebar,
    }),
  ],
  markdown: {
    rehypePlugins: [
      rehypeHeadingIds,
      [
        rehypeAutolinkHeadings,
        {
          behavior: "wrap",
        },
      ],
      [forkLinks, { base }],
    ],
  },
});
