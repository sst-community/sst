# Shared Lambda handler

Each route that invokes a function adds a statement to the function's resource policy, which is limited to 20 KB. With many routes on one function, the policy fills and the deploy fails.

`addHandler` gives the routes one shared invoke permission instead:

```ts
const backend = api.addHandler("Backend", fn);
api.route("GET /items", backend);
api.route("POST /items", backend);
```

Deploy, then call a route and check the function's resource policy. It has one API Gateway statement for all four routes.

```sh
npx sst deploy
curl <url>/items
aws lambda get-policy --function-name <function>
```

`ApiGatewayV1` and `ApiGatewayWebSocket` have the same `addHandler`.

To switch existing routes over, pass them the handler and deploy. To switch back, pass them the function again, remove the `addHandler` call and deploy.
