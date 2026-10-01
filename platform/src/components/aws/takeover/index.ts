/**
 * How each V5 component takes over from the 4.x component it replaces, so
 * that changing `Queue` to `QueueV5` keeps what's already deployed.
 *
 * The V5 components don't know about any of this. When the 4.x components are
 * removed, this folder goes with them.
 */
import "./apigatewayv2";
import "./app-sync";
import "./aurora";
import "./bucket";
import "./cognito-user-pool";
import "./cognito-user-pool-client";
import "./cron-v2";
import "./dsql";
import "./dynamo";
import "./function";
import "./mysql";
import "./postgres";
import "./queue";
import "./redis";
import "./sns-topic";
