// Send a test event, with your own AWS credentials:
//
//   npx sst shell -- bun scripts/send.ts 25
import { flow, orderPlaced } from "../src/client";

const amount = Number(process.argv[2] ?? 25);
const orderId = crypto.randomUUID();
const { ids } = await flow.send(
  orderPlaced.create({ orderId, amount, email: "alice@example.com" }, { id: `order-${orderId}` }),
);
console.log({ orderId, eventId: ids[0] });
