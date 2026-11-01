import { takeover } from "../../takeover";
import { Function } from "../v5/function";

takeover(Function, {
  moved: {
    // The 4.x `Function` names the two permissions of a URL after who they're
    // for: everyone, or the distribution of the router the URL is behind.
    urlAccess: (_, { name }) => [
      { name: `${name}PublicFunctionUrlAccess` },
      { name: `${name}CloudFrontFunctionUrlAccess` },
    ],
    urlInvoke: (_, { name }) => [
      { name: `${name}InvokeFunction` },
      { name: `${name}PublicInvokeFunction` },
      { name: `${name}CloudFrontInvokeFunction` },
    ],
    // The 4.x `Function` creates the alias outside of the function, with no
    // parent
    urlAlias: (_, { name }) => ({ name: `${name}Durable`, parent: false }),
  },
  // Each is an object keyed by what's in it, and is uploaded under a new key
  // whenever the function's code changes, as when it's renamed
  replaced: {
    code: "The function's code is uploaded again, under a new key.",
    sourcemap: "The function's source map is uploaded again, under a new key.",
  },
});
