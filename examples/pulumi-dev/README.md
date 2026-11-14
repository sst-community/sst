# A Pulumi program with SST's dev loop

A plain Pulumi program in TypeScript that `sst pulumi dev` runs: Pulumi does everything else. How it works is in [Use with Pulumi](https://github.com/sst-community/sst/blob/v5/www/src/content/docs/docs/use-with-pulumi.mdx).

| In `sst pulumi dev` | Otherwise |
| --- | --- |
| `Api` runs on this machine from `functions/api.ts`, with its role's credentials | `Api` runs `dist/api`, which `npm run build` bundles |
| Postgres in a container, from the `Postgres` dev command | An RDS instance |
| The frontend's dev server, from the `Web` dev command, with the API's URL | The frontend's files in a bucket |
| The `Report` dev command, as the `Reporter` role | Nothing |

SST adds one line to the program: `import { dev } from "sst/pulumi"`, first. What `sst pulumi dev` runs is in [`sst.dev.yaml`](sst.dev.yaml): the `Api` function on this machine, and the three dev commands, which take the stack's outputs. Without the file, `sst pulumi dev` offers to write one from a preview of the stack: move it aside to see what it writes.

The API's routes show what runs where: `/version` (change `VERSION` while `sst pulumi dev` runs), `/whoami` (the role its code runs as), `/reports` (a bucket its role may read), `/archive` (one it may not) and `/visits` (a count in Postgres).

## Run it

```bash
npm install
npm run build
pulumi stack init dev
pulumi config set aws:region us-west-2
pulumi config set --secret greeting hello
pulumi config set sst:dev true
npx sst pulumi dev
```

Then call the `apiUrl` it prints, and open the `Web` pane's URL.

A stack without `sst:dev` deploys the rest of the table with plain `pulumi up`. It needs a `dbPassword` secret for its database.
