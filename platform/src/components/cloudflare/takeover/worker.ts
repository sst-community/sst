import { takeover } from "../../takeover";
import { Worker } from "../v5/worker";

// The 4.x `Worker` named each of the domain's aliases and redirects after its
// place in the list. The V5 one keeps each by its domain.
const place = (worker: Worker, part: "alias" | "redirect", id?: string) =>
  (worker as unknown as { hostnames: Record<typeof part, string[]> }).hostnames[
    part
  ].indexOf(id!);

takeover(Worker, {
  moved: {
    alias: (worker, { name, id }) => ({
      name: `${name}Alias${place(worker, "alias", id)}Domain`,
    }),
    redirectRecord: (worker, { name, id }) => ({
      name: `${name}Redirect${place(worker, "redirect", id)}Record`,
    }),
    redirectRule: (worker, { name, id }) => ({
      name: `${name}Redirect${place(worker, "redirect", id)}Rule`,
    }),
  },
});
