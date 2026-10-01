import { takeover } from "../../takeover.js";
import { RedisV5 } from "../redis-v5.js";

takeover(RedisV5, {
  from: "sst:aws:Redis",
  moved: {
    // `Redis` calls these "proxy" secrets, though there is no proxy
    secret: "proxySecret",
    secretVersion: "proxySecretVersion",
  },
});
