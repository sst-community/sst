import { takeover } from "../../takeover";
import { CronV2 } from "../v5/cron-v2";

takeover(CronV2, {
  from: "sst:aws:CronV2",
  moved: {
    // The 4.x `CronV2` calls the function the job's handler
    function: "handler",
  },
});
