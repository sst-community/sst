import { describe, expect, it } from "vitest";
import { getProject, getStack } from "@pulumi/pulumi";
import { mock } from "../../src/testing";
import { Component } from "../../src/components/component";
import { releasedAddresses } from "../../src/components/takeover";

const app = await mock({ app: "acme", stage: "dev" });
const dynamic = "pulumi-nodejs:dynamic:Resource";
const at = `urn:pulumi:${getStack()}::${getProject()}::`;

describe("where a released resource can be", () => {
  it("is in the component, under its name and each it answers to", async () => {
    // A function a subscriber component of 4.x created, named after it with
    // "Function" added, which a queue's map now gives a name of its own
    const queue = new Component("acme:index:Queue", "Orders");
    const subscriber = `${at}acme:index:Queue$acme:index:Subscriber::OrdersSubscriber`;
    const fn = new Component(
      "acme:index:Function",
      "OrdersSubscriber",
      {},
      {
        parent: queue,
        aliases: [{ name: "OrdersSubscriberFunction", parent: subscriber }],
      },
    );

    const addresses = await app.resolve(
      releasedAddresses(
        { type: dynamic, name: "OrdersSubscriberRouteKey.sst.aws.KvKeys" },
        fn,
        "OrdersSubscriber",
      ),
    );
    expect(addresses).toEqual(
      expect.arrayContaining([
        `${at}acme:index:Queue$acme:index:Function$${dynamic}::OrdersSubscriberRouteKey.sst.aws.KvKeys`,
        `${at}acme:index:Queue$acme:index:Subscriber$acme:index:Function$${dynamic}::OrdersSubscriberFunctionRouteKey.sst.aws.KvKeys`,
      ]),
    );
  });

  it("is where the map says, with a parent", async () => {
    const fn = new Component("acme:index:Function", "Api");
    expect(
      await app.resolve(
        releasedAddresses(
          { type: dynamic, name: "ApiDurable", parent: false },
          fn,
          "Api",
        ),
      ),
    ).toEqual([`${at}${dynamic}::ApiDurable`]);
  });
});
