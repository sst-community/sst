import { EventFlow } from "sst/aws/eventflow";

export const flow = new EventFlow({ id: "use-cases" });

// Stand-ins for the services a real app calls. Each logs what it would do.
export const services = {
  email: async (to: string, subject: string) => log("email", { to, subject }),
  crm: async (userId: string) => log("crm", { userId }),
  billing: async (action: string, customerId: string) => log("billing", { action, customerId }),
  slack: async (text: string) => log("slack", { text }),
  model: async (task: string, input: string) => {
    log("model", { task });
    return `${task}(${input.slice(0, 40)})`;
  },
  page: async (cursor: number) => ({
    items: Array.from({ length: 3 }, (_, i) => `item-${cursor * 3 + i}`),
    next: cursor < 3 ? cursor + 1 : undefined,
  }),
};

function log(service: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ service, ...fields }));
  return { ok: true };
}
