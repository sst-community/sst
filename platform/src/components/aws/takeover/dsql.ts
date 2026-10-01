import { takeover } from "../../takeover";
import { Dsql } from "../v5/dsql";

takeover(Dsql, {
  moved: {
    // The 4.x `Dsql` numbers the two sides of the peering
    clusterPeering: "peering1",
    peerClusterPeering: "peering2",
    // What's in the peer region is named "peer" first, like the peer cluster
    peerBackupVault: "backupVaultPeer",
  },
});
