// Gets a batch of items from the Map state: `{ Items: [...], BatchInput: {...} }`
export async function handler(event: {
  Items: { id: number; value: number }[];
  BatchInput: { source: string };
}) {
  // Fail the batch with item 13, to show that the Map state tolerates some failures
  if (event.Items.some((item) => item.id === 13)) {
    throw new Error("Item 13 can't be processed");
  }

  return {
    source: event.BatchInput.source,
    count: event.Items.length,
    sum: event.Items.reduce((sum, item) => sum + item.value, 0),
  };
}
