/**
 * How each V5 Cloudflare component takes over from the 4.x component it
 * replaces, so that changing `sst.cloudflare.Worker` to
 * `sst.cloudflare.v5.Worker` keeps what's already deployed.
 *
 * The V5 components don't know about any of this. When the 4.x components are
 * removed, this folder goes with them.
 */
import "./worker";
import "./kv";
import "./d1";
import "./bucket";
import "./hyperdrive";
import "./ai";
import "./rate-limit";
import "./queue";
import "./cron";
import "./workflow";
import "./durable-object";
import "./auth";
import "./static-site";
import "./astro";
import "./react-router";
import "./tan-stack-start";
