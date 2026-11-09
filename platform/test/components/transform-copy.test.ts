import { describe, expect, it } from "vitest";
import { output } from "@pulumi/pulumi";
import { transformPart } from "../../src/components/transform";

// A transform function is given copies of what's in the args, as SST 4's
// components gave copies made by `output()`: what it changes doesn't reach
// the app's config, or a default another part shares.
describe("transformPart", () => {
  it("gives a function copies of the arrays and plain objects inside the args", () => {
    const config = { allowedOrigins: ["https://a.example"] };
    const shared = ["s3:ObjectCreated:*"];
    const out = output("x");
    const args = { corsRules: [config], events: shared, value: out };

    const [, transformed] = transformPart(
      (args: any) => {
        args.corsRules[0].allowedOrigins.push("https://b.example");
        args.events.push("s3:ObjectRemoved:*");
      },
      "Cors",
      args,
      {},
    );

    expect((transformed as any).corsRules[0].allowedOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(config.allowedOrigins).toEqual(["https://a.example"]);
    expect(shared).toEqual(["s3:ObjectCreated:*"]);
    // What isn't an array or a plain object is handed over as it is
    expect((transformed as any).value).toBe(out);
    // The args themselves are the component's, changed in place, so it can
    // read what the function made of them
    expect(transformed).toBe(args);
  });

  it("copies an object that refers to itself once", () => {
    const node: any = { name: "a" };
    node.self = node;
    const [, transformed] = transformPart<any>(
      () => undefined,
      "N",
      { node },
      {},
    );
    expect((transformed as any).node.self).toBe((transformed as any).node);
    expect((transformed as any).node).not.toBe(node);
  });
});
