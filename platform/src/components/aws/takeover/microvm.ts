import { sstResource, takeover } from "../../takeover";
import { MicroVm } from "../microvm";

// Nothing moved. The map says the 4.x form has this 5.0 form, so a stage
// switches it with `sst migrate`, and a new stage refuses the 4.x one.
//
// Every part has the name and the place it had in 4.x. In `sst dev`, the 4.x
// one created a component for the pane `sst dev` shows, which the V5 one
// reports in place of it: a move drops it, and there's nothing in the cloud
// behind it.
//
// What prunes its image's old versions was one of SST's own dynamic
// resources: the one in its place prunes once.
takeover(MicroVm, {
  released: {
    imagePrune: (_, { name }) =>
      sstResource("aws.MicrovmImagePrune", { name: `${name}ImagePrune` }),
  },
});
