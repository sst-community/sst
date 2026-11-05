// What only SST 4's components used of the base they share with SST 5's: a
// component's version, which SST 4 kept as a resource of its own in the state
// and checked against the one in the code. SST 5 keeps the versions in its
// marker and record instead. The SST 4 components frozen in these fixtures that
// have a version extend this, and read the version of what's deployed with
// `$cli.state.version?.[name]`: SST 5's core doesn't give it, as SST 4's did.
import {
  ComponentResource,
  type ComponentResourceOptions,
} from "@pulumi/pulumi";
import { Component as Base } from "../../../../src/components/component";
import { VisibleError } from "../../../../src/components/error";

export * from "../../../../src/components/component";

export abstract class Component extends Base {
  protected registerVersion(input: {
    new: number;
    old?: number;
    message?: string;
    forceUpgrade?: `v${number}`;
  }) {
    const oldVersion = input.old;
    const newVersion = input.new ?? 1;
    if (oldVersion) {
      const className = this.componentType.replaceAll(":", ".");
      if (input.forceUpgrade && input.forceUpgrade !== `v${newVersion}`) {
        throw new VisibleError(
          [
            `The value of "forceUpgrade" does not match the version of "${className}" component.`,
            `Set "forceUpgrade" to "v${newVersion}" to upgrade to the new version.`,
          ].join("\n"),
        );
      }
      if (oldVersion < newVersion && !input.forceUpgrade) {
        throw new VisibleError(input.message ?? "");
      }
      if (oldVersion > newVersion) {
        throw new VisibleError(
          [
            `It seems you are trying to use an older version of "${className}".`,
            `You need to recreate this component to rollback - https://sst-community.github.io/sst/docs/components/#versioning`,
          ].join("\n"),
        );
      }
    }
    if (newVersion > 1) {
      new Version(this.componentName, newVersion, { parent: this });
    }
  }
}

export class Version extends ComponentResource {
  constructor(target: string, version: number, opts: ComponentResourceOptions) {
    super("sst:sst:Version", target + "Version", {}, opts);
    this.registerOutputs({ target, version });
  }
}

export type ComponentVersion = { major: number; minor: number };
export function parseComponentVersion(version: string): ComponentVersion {
  const [major, minor] = version.split(".");
  return { major: parseInt(major), minor: parseInt(minor) };
}
