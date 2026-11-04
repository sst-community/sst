import { describe, expect, it } from "vitest";
import { serverWarmingInjection } from "../../src/components/aws/ssr-site";

// The injection runs at the top of the generated server wrapper, which is
// `async (event, responseStream, context)` when the server streams and
// `async (event, context)` when it doesn't. These tests run it the same way.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function streamingHandler() {
  return new AsyncFunction(
    "event",
    "responseStream",
    "context",
    `${serverWarmingInjection(true)}\nreturn "reached the app";`,
  );
}

function plainHandler() {
  return new AsyncFunction(
    "event",
    "context",
    `${serverWarmingInjection(false)}\nreturn "reached the app";`,
  );
}

describe("SsrSite warmer injection", () => {
  it("does not wait for the event loop on a streaming warmer ping", async () => {
    const written: string[] = [];
    let ended = false;
    const context: { callbackWaitsForEmptyEventLoop?: boolean } = {};
    const result = await streamingHandler()(
      { type: "warmer", delay: 0 },
      {
        write: (chunk: string) => written.push(chunk),
        end: () => {
          ended = true;
        },
      },
      context,
    );

    // A sandbox that still has sockets or timers open from earlier requests would
    // otherwise keep the ping running until the function times out.
    expect(context.callbackWaitsForEmptyEventLoop).toBe(false);
    expect(result).toBeUndefined();
    expect(ended).toBe(true);
    expect(JSON.parse(written.join(""))).toEqual({
      serverId: expect.stringMatching(/^server-/),
    });
  });

  it("does not wait for the event loop on a non-streaming warmer ping", async () => {
    const context: { callbackWaitsForEmptyEventLoop?: boolean } = {};
    const result = await plainHandler()({ type: "warmer", delay: 0 }, context);

    expect(context.callbackWaitsForEmptyEventLoop).toBe(false);
    expect(result).toEqual({ serverId: expect.stringMatching(/^server-/) });
  });

  it("leaves a request for the app alone", async () => {
    const streamingContext: { callbackWaitsForEmptyEventLoop?: boolean } = {};
    expect(
      await streamingHandler()({ rawPath: "/" }, {}, streamingContext),
    ).toBe("reached the app");
    expect(streamingContext.callbackWaitsForEmptyEventLoop).toBeUndefined();

    const plainContext: { callbackWaitsForEmptyEventLoop?: boolean } = {};
    expect(await plainHandler()({ rawPath: "/" }, plainContext)).toBe(
      "reached the app",
    );
    expect(plainContext.callbackWaitsForEmptyEventLoop).toBeUndefined();
  });
});
