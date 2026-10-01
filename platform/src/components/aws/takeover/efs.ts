import { takeover } from "../../takeover";
import { Efs } from "../v5/efs";

takeover(Efs, {
  moved: {
    // Named after the subnet's id as it's written: `MyEfsMountTargetsubnet-0a1b`
    mountTarget: (_, { name, id }) => ({ name: `${name}MountTarget${id}` }),
  },
});
