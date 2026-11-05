import { takeover } from "../../takeover";
import { Vpc } from "../vpc";

takeover(Vpc, {
  moved: {
    // Older 4.x releases created it at the top of the app, and later ones
    // moved it into the `Vpc` with an alias
    natInstanceEipAssociation: (_, { name, id }) => ({
      name: `${name}NatInstanceEipAssociation${id}`,
      parent: false,
    }),
  },
  replaced: {
    bastionInstance:
      "The bastion is replaced once if it doesn't run the newest Amazon Linux 2023 image with Amazon's default kernel. Start `sst tunnel` again after the deploy.",
  },
});
