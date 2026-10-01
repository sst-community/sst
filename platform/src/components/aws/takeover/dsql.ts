import { takeover } from "../../takeover";
import { DsqlV5 } from "../dsql-v5";

takeover(DsqlV5, {
  from: "sst:aws:Dsql",
  moved: {
    // `Dsql` numbers the two sides of the peering
    clusterPeering: "peering1",
    peerClusterPeering: "peering2",
    // What's in the peer region is named "peer" first, like the peer cluster
    peerBackupVault: "backupVaultPeer",
    // The security group's name didn't match its `transform` key
    endpointSecurityGroup: "dsqlEndpointSecurityGroup",
  },
});
