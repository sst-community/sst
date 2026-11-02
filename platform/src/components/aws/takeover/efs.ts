import { output } from "@pulumi/pulumi";
import { takeover } from "../../takeover";
import { Efs } from "../v5/efs";

takeover(Efs, {
  moved: {
    // The 4.x `Efs` named each mount target after its subnet's id, as it's
    // written: `MyEfsMountTargetsubnet-0a1b`. The V5 one keeps it by its AZ.
    mountTarget: (efs, { name, id }) => {
      const subnet = efs.subnetOf(id!);
      if (subnet === undefined) return undefined;
      return {
        name: output(subnet).apply((subnet) => `${name}MountTarget${subnet}`),
      };
    },
  },
});
