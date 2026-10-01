import { takeover } from "../../takeover";
import { Function } from "../v5/function";

takeover(Function, {
  from: "sst:aws:Function",
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
});
