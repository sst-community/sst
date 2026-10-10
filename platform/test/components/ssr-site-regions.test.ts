import { describe, it, expect } from "vitest";
import { Region } from "@pulumi/aws";
import {
  regionsWithoutFunctionUrls,
  supportedRegions,
} from "../../src/components/aws/ssr-site";

describe("SsrSite regions", () => {
  it("only rejects regions the provider knows", () => {
    // A region that isn't in the provider's list is reported as invalid. One that is should
    // be reported as lacking function URLs instead.
    const known = Object.values(Region) as string[];
    for (const region of regionsWithoutFunctionUrls)
      expect(known, region).toContain(region);
  });

  it("has coordinates for every rejected region", () => {
    // So that taking a region off the list later doesn't crash the router's server list.
    for (const region of regionsWithoutFunctionUrls)
      expect(Object.keys(supportedRegions), region).toContain(region);
  });

  it("lists each region once, in order", () => {
    expect(regionsWithoutFunctionUrls).toEqual(
      [...new Set(regionsWithoutFunctionUrls)].sort(),
    );
  });

  it("rejects the regions found to have no function URLs, and not the ones that have them", () => {
    for (const region of [
      "ap-southeast-6",
      "ap-southeast-7",
      "ap-east-2",
      "mx-central-1",
    ])
      expect(regionsWithoutFunctionUrls).toContain(region);
    // Function URLs work in Spain; this list used to include it.
    expect(regionsWithoutFunctionUrls).not.toContain("eu-south-2");
  });
});
