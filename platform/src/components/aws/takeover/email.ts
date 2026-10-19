import { takeover } from "../../takeover";
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
});
