import { takeover } from "../../takeover";
import { CronV2V5 } from "../cron-v2-v5";

takeover(CronV2V5, {
  from: "sst:aws:CronV2",
  moved: {
    // `CronV2` calls the function the job's handler
    function: "handler",
  },
});
