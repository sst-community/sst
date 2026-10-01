import { takeover } from "../../takeover";
import { FunctionV5 } from "../function-v5";

takeover(FunctionV5, {
  from: "sst:aws:Function",
  moved: {
    // `Function` names the two permissions of a URL after who they're for:
    // everyone, or the distribution of the router the URL is behind.
    urlAccess: (_, { name }) => [
      { name: `${name}PublicFunctionUrlAccess` },
      { name: `${name}CloudFrontFunctionUrlAccess` },
    ],
    urlInvoke: (_, { name }) => [
      { name: `${name}InvokeFunction` },
      { name: `${name}PublicInvokeFunction` },
      { name: `${name}CloudFrontInvokeFunction` },
    ],
    // `Function` creates the alias outside of the function, with no parent
    urlAlias: (_, { name }) => ({ name: `${name}Durable`, parent: false }),
  },
});
