import { takeover } from "../../takeover";
import { Cron } from "../cron";

takeover(Cron, {
  moved: {
    // The 4.x `Cron` calls the function the job's handler
    function: "handler",
  },
});
