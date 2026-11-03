import { takeover } from "../../takeover";
import { Cron } from "../v5/cron";

takeover(Cron, {
  moved: {
    // The 4.x `CronV2` calls the function the job's handler
    function: "handler",
  },
});
