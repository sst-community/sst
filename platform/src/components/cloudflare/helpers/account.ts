import * as cloudflare from "@pulumi/cloudflare";
import {
  output,
  type Input,
  type Output,
  type ProviderResource,
  type Resource,
} from "@pulumi/pulumi";
import { underCore } from "../../context";
import { VisibleError } from "../../error";
import { perRun } from "../../../util/lazy";

// The account looked up in this run for each Cloudflare provider, the
// stack's default one under undefined
const lookups = perRun(
  () => new Map<ProviderResource | undefined, Output<string>>(),
);

/**
 * The account a Cloudflare component uses when it's given none.
 *
 * Under SST's CLI it's `CLOUDFLARE_DEFAULT_ACCOUNT_ID`, which the CLI sets to
 * the account it picked: the variable when it's set, and otherwise the first
 * account the credentials list (pkg/project/provider/cloudflare.go). A program
 * Pulumi runs on its own picks it the same way, with the Cloudflare provider
 * of the component, so it gets the same account either way. Pulumi's
 * Cloudflare provider has no account setting of its own.
 */
export function defaultAccountId(parent: Resource | undefined): Input<string> {
  const given = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID;
  if (given || underCore()) return given!;
  const provider = parent?.getProvider("cloudflare::");
  const found = lookups();
  let account = found.get(provider);
  if (!account) {
    account = output(
      cloudflare
        .getAccounts({}, provider ? { provider } : {})
        .then(
          (accounts) => accounts.results?.[0]?.id,
          (error) => {
            throw new VisibleError(
              `SST's Cloudflare components use the first account Cloudflare's provider lists when they're given none, and listing them failed: ${
                error?.message ?? error
              }. Set CLOUDFLARE_DEFAULT_ACCOUNT_ID, or give the component its "accountId".`,
            );
          },
        )
        .then((id) => {
          if (!id)
            throw new VisibleError(
              `SST's Cloudflare components use the first account Cloudflare's provider lists when they're given none, and it lists none. Set CLOUDFLARE_DEFAULT_ACCOUNT_ID, or give the component its "accountId".`,
            );
          return id;
        }),
    );
    found.set(provider, account);
  }
  return account;
}
