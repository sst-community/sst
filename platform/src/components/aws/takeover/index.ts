/**
 * How each V5 component takes over from the 4.x component it replaces, so
 * that changing `Queue` to `QueueV5` keeps what's already deployed.
 *
 * The V5 components don't know about any of this. When the 4.x components are
 * removed, this folder goes with them.
 */
import "./apigatewayv2.js";
import "./app-sync.js";
import "./bucket.js";
import "./cognito-user-pool.js";
import "./cognito-user-pool-client.js";
import "./queue.js";
import "./redis.js";
import "./sns-topic.js";
