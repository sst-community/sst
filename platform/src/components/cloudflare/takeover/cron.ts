import { takeover } from "../../takeover";
import { Cron } from "../v5/cron";

takeover(Cron, {
  moved: {
    // The 4.x `Cron` created its Worker at the top of the app. It keeps its
    // name, so its script's is still made from it.
    worker: (_, { name }) => ({ name: `${name}Handler`, parent: false }),
  },
});
