import { takeover } from "../../takeover";
import { logicalName } from "../../naming";
import { Email } from "../v5/email";

// The 4.x `Email` named each event's destination after the event's name as it
// was given. The V5 one names it the way it names any part with an id, which
// comes out the same for a name like "OnBounce".
takeover(Email, {
  moved: {
    event: (_, { name, id }) =>
      id === undefined || /^[A-Z][A-Za-z0-9]*$/.test(id)
        ? undefined
        : { name: `${name}Event${id}` },
  },
  // 4.x named a DKIM record after its name in DNS, made from a token SES gives
  // once the identity is created. The V5 one names it after its place, which a
  // preview knows. Its old name comes from the identity, which a move keeps.
  // The other records keep their names: those are known up front.
  delegated: (email, { name, componentName }) => {
    const prefix = `${componentName}CNAMERecord`;
    for (const record of email._dkimRecords) {
      if (name !== `${prefix}${logicalName(record.key)}`) continue;
      return {
        name: record.name.apply(
          (dnsName) => `${prefix}${logicalName(dnsName)}`,
        ),
      };
    }
  },
});
