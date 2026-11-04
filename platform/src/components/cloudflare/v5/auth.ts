import {
  type ComponentResourceOptions,
  type ResourceTransformation,
  all,
  secret,
} from "@pulumi/pulumi";
import { PrivateKey } from "@pulumi/tls";
import { type ComponentArgs, component, named } from "../../parts-component";
import { notAnExistingPart, plain } from "../../args";
import { VisibleError } from "../../error";
import { Worker, type WorkerArgs } from "./worker";

const parts = () => ({
  /**
   * The RSA key pair the authenticator signs and verifies tokens with.
   */
  key: named(PrivateKey, "Keypair"),
  /**
   * The Worker that runs the authenticator, reached through its URL.
   */
  authenticator: Worker,
});

export interface AuthArgs extends ComponentArgs<typeof parts> {
  /**
   * The worker that runs the authenticator: the path to its handler, or the
   * Worker's args. It's given a URL, and the key pair as the `AUTH_PRIVATE_KEY`
   * and `AUTH_PUBLIC_KEY` environment variables.
   *
   * It decides how the Worker is created, so it's a plain value, not an
   * output. What's in the Worker's args can be an output.
   *
   * @example
   * ```js
   * {
   *   authenticator: "src/auth.ts"
   * }
   * ```
   *
   * You can pass in the full worker props.
   *
   * ```js
   * {
   *   authenticator: {
   *     handler: "src/auth.ts",
   *     link: [users]
   *   }
   * }
   * ```
   */
  authenticator: string | WorkerArgs;
}

/**
 * The `Auth` component lets you add an authenticator to your app, running on
 * Cloudflare Workers. It creates an RSA key pair, and a worker that's given
 * it, with a URL.
 *
 * The worker gets the private key as `AUTH_PRIVATE_KEY`, to sign tokens with,
 * and the public key as `AUTH_PUBLIC_KEY`. Whatever's linked to the
 * component gets its URL and the public key, to verify the tokens with.
 *
 * @example
 *
 * ```ts title="sst.config.ts"
 * const auth = new sst.cloudflare.v5.Auth("MyAuth", {
 *   authenticator: "src/auth.ts"
 * });
 *
 * new sst.cloudflare.v5.Worker("Api", {
 *   handler: "src/api.ts",
 *   link: [auth]
 * });
 * ```
 *
 * #### Switch from `sst.cloudflare.Auth`
 *
 * Change `sst.cloudflare.Auth` to `sst.cloudflare.v5.Auth` and keep the name.
 * The key pair and the authenticator's Worker are kept.
 *
 * - The private key is given to the Worker as a secret, where SST 4 gave it
 *   as a plain text variable, which Cloudflare shows in its dashboard. The
 *   Worker reads it the same way, `env.AUTH_PRIVATE_KEY`, and is updated in
 *   place.
 * - `authenticator` can be the path to the handler too, and is a plain value,
 *   not an output. Inside the Worker's args, `link` and `domain` are plain
 *   values too, as [`sst.cloudflare.v5.Worker`](/docs/component/cloudflare/v5/worker)
 *   takes them.
 * - The key pair and the Worker are inside the component, where SST 4
 *   created them at the top of your app, and keep their names. The key pair
 *   is `nodes.key`, and the Worker is
 *   [`sst.cloudflare.v5.Worker`](/docs/component/cloudflare/v5/worker),
 *   `nodes.authenticator`. You can change them in `transform` now: `key`
 *   and `authenticator`. `transform.bucketPolicy`, which SST 4 took and did
 *   nothing with, is refused.
 * - `authenticator` is the Worker, where it was an output of it.
 * - The Worker is created with the provider the component has. SST 4
 *   created it with your app's provider, so if your `Auth` has a `provider`,
 *   or takes one from a parent component or from `providers`, its Worker is
 *   replaced on switch, which `sst migrate --check` refuses. The key pair
 *   isn't: it's made on your machine.
 */
export class Auth extends component("sst:cloudflare:Auth", parts) {
  constructor(name: string, args: AuthArgs, opts?: ComponentResourceOptions) {
    super(name, args, opts);

    const owner = `the "${name}" auth server`;
    notAnExistingPart(
      args.existing,
      "authenticator",
      owner,
      `Pass the handler or the Worker's args in "authenticator": the auth server creates its Worker and gives it the key pair.`,
    );

    const given = plain(
      args.authenticator,
      `The "authenticator" of ${owner}`,
      "Whether it's a handler or the Worker's args decides how the Worker is created.",
    );
    const worker = typeof given === "string" ? { handler: given } : given;
    if (!worker?.handler)
      throw new VisibleError(
        `The "${name}" auth server needs an "authenticator": the path to the Worker's handler, or the Worker's args with one.`,
      );

    const key = this.part("key", { algorithm: "RSA" });
    this.part(
      "authenticator",
      {
        ...worker,
        url: true,
        // Kept secret, as SST 4 kept it. The private key is added as a
        // secret binding, below.
        environment: all([worker.environment, secret(key.publicKeyPem)]).apply(
          ([environment, publicKey]) => {
            const { AUTH_PRIVATE_KEY: _, ...rest } = environment ?? {};
            return { ...rest, AUTH_PUBLIC_KEY: publicKey };
          },
        ),
      },
      { transformations: [privateKeyBinding(key)] },
    );
  }

  /**
   * The key pair.
   */
  public get key() {
    return this.nodes.key;
  }

  /**
   * The Worker that runs the authenticator.
   */
  public get authenticator() {
    return this.nodes.authenticator;
  }

  /**
   * The URL of the authenticator.
   */
  public get url() {
    return this.nodes.authenticator.url;
  }

  /**
   * The public key of the key pair, in PEM format, which verifies the tokens
   * the authenticator issues.
   */
  public get publicKey() {
    return secret(this.key.publicKeyPem);
  }

  /**
   * Linking the auth gives its URL and its public key.
   *
   * @internal
   */
  public link() {
    return {
      properties: {
        url: this.url,
        publicKey: this.publicKey,
      },
    };
  }
}

// The authenticator's Worker is given the private key as a secret, which
// Cloudflare doesn't show. Its `environment` would make it plain text. A
// transformation runs after the user's `transform`, so it can't be undone.
function privateKeyBinding(key: PrivateKey): ResourceTransformation {
  return ({ type, props, opts }) => {
    if (type !== "cloudflare:index/workersScript:WorkersScript") return;
    return {
      props: {
        ...props,
        bindings: all([props.bindings, secret(key.privateKeyPemPkcs8)]).apply(
          ([bindings, privateKey]) => [
            ...((bindings ?? []) as { name: string }[]).filter(
              (binding) => binding.name !== "AUTH_PRIVATE_KEY",
            ),
            { type: "secret_text", name: "AUTH_PRIVATE_KEY", text: privateKey },
          ],
        ),
      },
      opts,
    };
  };
}
