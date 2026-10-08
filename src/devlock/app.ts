import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DevEnvLocks } from '../devEnvLocks.js';
import type { Notify } from './notify.js';

/**
 * The GC_TEMPLATE value Claude Code's CLI sets for a real `chipmakers/worker` session.
 *
 * Verified live on 2026-10-08 by `gc sling chipmakers/worker ...` and reading
 * `/proc/<pid>/environ` of the spawned session: GC_TEMPLATE=chipmakers/worker.
 * (GC_AGENT itself resolves to the ephemeral wisp session id, e.g. `sc-wisp-zgzi`
 * — NOT a stable agent identifier — so it can't be used for this allowlist.)
 * The auto-generated pool agent spawned from `[providers.claude-worker]`
 * (`chipmakers/claude-worker`) resolves GC_TEMPLATE to `chipmakers/claude-worker`
 * instead, confirmed the same way, so this exact-match check excludes it.
 */
const REQUIRED_AGENT = 'chipmakers/worker';

type Identity = { repo: string; sessionId: string };

function identityFromHeaders(req: express.Request): Identity | { error: string } {
  const repo = req.header('x-repo');
  const sessionId = req.header('x-session-id');
  if (!repo || !sessionId) {
    return { error: 'Missing required X-Repo or X-Session-Id header' };
  }
  const agent = req.header('x-agent');
  if (agent !== REQUIRED_AGENT) {
    return { error: `Missing or invalid X-Agent header (expected "${REQUIRED_AGENT}")` };
  }
  return { repo, sessionId };
}

function buildServer(
  locks: DevEnvLocks,
  identity: Identity | { error: string },
  notify: Notify,
  res: express.Response,
): McpServer {
  const server = new McpServer({ name: 'devlock', version: '1.0.0' });

  server.registerTool(
    'claim_dev',
    {
      description:
        "Claim exclusive use of this repo's shared dev environment before you use it (dev server, migrations, seeds, deploying to dev, or tests that hit dev). Only one worker holds it at a time; if it's busy this blocks until it frees, then returns. Always call release_dev when done.",
      inputSchema: {},
    },
    async () => {
      if ('error' in identity) {
        return { isError: true, content: [{ type: 'text', text: identity.error }] };
      }
      const { repo, sessionId } = identity;
      const res_ = locks.claim(repo, sessionId, sessionId);
      if (res_.status === 'granted') {
        return { content: [{ type: 'text', text: `You now hold the ${repo} dev environment. Call release_dev when done.` }] };
      }
      if (res_.status === 'granted-broke-stale') {
        await notify(
          res_.prior.workerId,
          'dev-env',
          `Your hold on the ${repo} dev environment was released after being held past the limit. Another session has taken it.`,
        );
        return {
          content: [
            { type: 'text', text: `You now hold the ${repo} dev environment (a stale hold was broken to grant it). Call release_dev when done.` },
          ],
        };
      }
      const wr = await locks.waitFor(res_.ticket);
      if (wr.status === 'granted') {
        // The client may have given up waiting (its own request timeout elapsed) long before
        // the server's wait resolves here — the MCP SDK client's default timeout (60s) is far
        // shorter than DEV_CLAIM_WAIT_TIMEOUT_MS (15min default). We were just granted the
        // claim (DevEnvLocks already recorded us as holder), but if nobody is listening for
        // the response, release immediately rather than leave a phantom holder that will never
        // call release_dev and will sit for a full TTL before anyone can even attempt to break it.
        if (res.writableEnded || res.destroyed) {
          locks.release(repo, sessionId);
          return { content: [{ type: 'text', text: `The ${repo} dev environment was granted but the connection is gone; released.` }] };
        }
        if (wr.brokeStale) {
          await notify(
            wr.brokeStale.workerId,
            'dev-env',
            `Your hold on the ${repo} dev environment was released after being held past the limit.`,
          );
        }
        return { content: [{ type: 'text', text: `The ${repo} dev environment is now yours. Call release_dev when done.` }] };
      }
      return { content: [{ type: 'text', text: `The ${repo} dev environment is still busy; you do NOT hold it.` }] };
    },
  );

  server.registerTool(
    'release_dev',
    {
      description: "Release this repo's shared dev environment so another session can use it.",
      inputSchema: {},
    },
    async () => {
      if ('error' in identity) {
        return { isError: true, content: [{ type: 'text', text: identity.error }] };
      }
      const { repo, sessionId } = identity;
      const res_ = locks.release(repo, sessionId);
      if (!res_.released) {
        return { content: [{ type: 'text', text: `You don't currently hold the ${repo} dev environment.` }] };
      }
      return { content: [{ type: 'text', text: `Released the ${repo} dev environment${res_.promoted ? ' — handed off to a waiting session.' : '.'}` }] };
    },
  );

  return server;
}

export function createDevlockApp(locks: DevEnvLocks, notify: Notify): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const identity = identityFromHeaders(req);
    const server = buildServer(locks, identity, notify, res);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  });

  return app;
}
