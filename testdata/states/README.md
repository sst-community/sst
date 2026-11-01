# Recorded states

States that SST's CLIs wrote for real apps, deployed in a lab account, so the
core and the components can be tested against them with no AWS. Step 1 of the
5.0 rewrite records them ([the plan](../../docs/plans/v5-rewrite/plan.md)).

Each folder is the version that deployed them. Each file is one stage's state
as the home stored it (Pulumi's checkpoint), scrubbed before it was committed:

- the account id is `123456789012`;
- the domain is `lab.example.com`, and in resource names `labexamplecom`;
- the hosted zone's id is `Z00000000000000EXAMPLE`;
- the app's folder is `/home/user/v5-lab`, and other paths on the deploying
  machine start at `/home/user` or `/tmp`;
- every secret's ciphertext is `v1:scrubbed`, so a state can be read but not
  decrypted.

`pkg/project/provider/recorded_state_test.go` reads each one through the homes
and fails if a file holds anything that looks private.

| File | What it holds |
| --- | --- |
| `v4.23.1/serverless-sites.json` | The lab app's serverless group and sites: `Function`, `Bucket`, `Queue`, `SnsTopic`, `Dynamo`, `CognitoUserPool`, `ApiGatewayV2`, `AppSync`, `CronV2`, `Bus`, `Email`, `Router`, `Nextjs`, `Astro`, `SvelteKit`, `StaticSite` (behind the router and with its own CDN). 323 resources. |
| `v4.23.1/vpc-containers-databases.json` | The lab app's VPC groups: a `Vpc` with managed NAT and a bastion, `Cluster`, `Service` (with a domain and with a shared `Alb`), `Alb`, `Task`, `CronV2`, `Efs`, a `Function` in the VPC, `Postgres` with a proxy, `Mysql`, `Redis`, `Aurora`, `Dsql`. 178 resources. |
| `v4.23.1/serverless-dev.json` | The serverless group as `sst dev` deploys it: every function a dev stub. 163 resources. |
