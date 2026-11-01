export async function handler(event: {
  body?: string;
  requestContext?: { routeKey?: string; connectionId?: string };
}) {
  const context = event.requestContext;
  if (context?.connectionId) {
    console.log(
      JSON.stringify({
        route: context.routeKey,
        connection: context.connectionId,
      }),
    );
    if (context.routeKey === "$default")
      return { statusCode: 200, body: event.body ?? "" };
  }
  return { statusCode: 200, body: "shared handler" };
}
