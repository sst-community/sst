import { all, interpolate, Output, output } from "@pulumi/pulumi";
import type { DevReport } from "../../contract";
import type { Input } from "../../input";
import { VisibleError } from "../../error";

// What a database or a cache that runs on the user's machine in `sst dev`
// connects to, in place of the one SST deploys, and the pane that says how
// the local server has to be set up.

/**
 * One of the values in a component's `dev`, or `fallback` when it's left out,
 * or is an output that resolves to `undefined`.
 *
 * @param emptyIsUnset Whether an empty string falls back too, as SST 4 read a
 * local database's username.
 */
export function devValue<T>(
  value: Input<T | undefined> | undefined,
  fallback: Input<T>,
  emptyIsUnset = false,
): Output<T> {
  const unset = (value: unknown) =>
    value === undefined || value === null || (emptyIsUnset && value === "");
  // A plain one is read now, so the fallback, which may be a secret, isn't
  // made part of it
  if (!Output.isInstance(value) && !(value instanceof Promise))
    return output(unset(value) ? fallback : (value as Input<T>)) as Output<T>;
  return all([value, fallback]).apply(([value, fallback]) =>
    unset(value) ? fallback : value,
  ) as Output<T>;
}

/**
 * The password a component connects to its local server with: the one in
 * `dev`, then its own, then none.
 *
 * @param owner For a server that needs one, the component, as `the
 * "MyDatabase" Postgres database`: without either password it's refused.
 */
export function localPassword(
  dev: Input<string | undefined> | undefined,
  password: Input<string | undefined> | undefined,
  owner?: string,
): Output<string> {
  if (owner && dev === undefined && password === undefined) {
    const Owner = owner[0].toUpperCase() + owner.slice(1);
    throw new VisibleError(
      `${Owner} needs the password of your local server to connect to it in sst dev. Set "dev.password", or "password".`,
    );
  }
  return devValue(dev, devValue(password, ""));
}

/**
 * What `sst dev` runs for a server on the user's machine: a pane that stays
 * open and lists what the server has to be set up with, in the order given,
 * and where it's listening. A `password` is shown with `shownPassword()`. Its
 * title is the component's name.
 *
 * @param server What it's called, as in "your local Redis server".
 * @param listening A host and a port, or a URL.
 */
export function localServerPane(
  server: string,
  using: Record<string, Input<string>>,
  listening: Input<string>,
): DevReport {
  const lines = Object.entries(using).map(([key, value]) => {
    const shown = key === "password" ? shownPassword(value) : value;
    return interpolate`  ${key}: "${shown}"`;
  });
  return {
    command: "sst print-and-not-quit",
    environment: {
      SST_DEV_COMMAND_MESSAGE: interpolate`Make sure your local ${server} is using:

${all(lines).apply((lines) => lines.join("\n"))}

Listening on "${listening}"...`,
    },
  };
}

/**
 * A password as the pane shows it, with an empty one shown as
 * "[no password]", in grey.
 */
export function shownPassword(password: Input<string>) {
  return output(password).apply(
    (password) => password || "\x1b[38;5;8m[no password]\x1b[0m",
  );
}
