import { sstResource, takeover } from "../../takeover";
import { Cdn } from "../cdn";

// Nothing moved. The waiter was one of SST's own dynamic resources: the one
// in its place waits again once.
takeover(Cdn, {
  released: {
    waiter: (_, { name }) =>
      sstResource("aws.DistributionDeploymentWaiter", {
        name: `${name}Waiter`,
      }),
  },
});
