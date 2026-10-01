import { takeover } from "../../takeover";
import { Redis } from "../v5/redis";

takeover(Redis, {
  from: "sst:aws:Redis",
  moved: {
    // The 4.x `Redis` calls these "proxy" secrets, though there is no proxy
    secret: "proxySecret",
    secretVersion: "proxySecretVersion",
  },
});
