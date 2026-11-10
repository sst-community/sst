import { takeover } from "../../takeover";
import { CronV2 } from "../cron-v2";

takeover(CronV2, {
  moved: {
    // The 4.x `CronV2` calls the function the job's handler
    function: "handler",
  },
});
