/**
 * How each of SST 5's Cloudflare components takes over from SST 4's form of
 * it, so that a stage SST 4 deployed moves with `sst migrate` and keeps what's
 * deployed.
 *
 * The components don't know about any of this.
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
import "./static-site";
import "./astro";
import "./react-router";
import "./tan-stack-start";
