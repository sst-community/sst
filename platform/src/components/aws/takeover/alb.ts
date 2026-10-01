import { takeover } from "../../takeover";
import { Alb } from "../v5/alb";

takeover(Alb, {
  moved: {
    // The 4.x `Alb` calls the certificate the SSL
    certificate: "ssl",
  },
});
