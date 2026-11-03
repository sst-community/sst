import { takeover } from "../../takeover";
import { OpenControl } from "../v5/opencontrol";

// Every part has the name and the place it had in 4.x
takeover(OpenControl, {});
