import { takeover } from "../../takeover";
import { Alb } from "../alb";

takeover(Alb, {
  moved: {
    // The 4.x `Alb` calls the certificate the SSL
    certificate: "ssl",
  },
});
