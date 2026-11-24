// Send a test event, with your own AWS credentials:
//
//   npx sst shell -- bun scripts/send.ts cart/item.added '{"cartId":"c1","email":"ada@example.com","timeout":"1m"}'
//
// Then look at the run with `npx sst eventflow runs --function cart-abandonment`.
import { flow } from "../src/client";

const [name, data = "{}", tenant] = process.argv.slice(2);
if (!name) throw new Error("Usage: bun scripts/send.ts <event name> [data as JSON] [tenant]");
console.log(await flow.send({ name, data: JSON.parse(data), ...(tenant ? { tenant } : {}) }));
