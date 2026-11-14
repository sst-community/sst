export async function handler(event: { routeKey: string }) {
  return { statusCode: 200, body: event.routeKey };
}
