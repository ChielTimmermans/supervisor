import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DevEnvLocks } from '../devEnvLocks.js';
import type { Notify } from './notify.js';

function identityFromHeaders(req: express.Request): { repo: string; sessionId: string } | undefined {
  const repo = req.header('x-repo');
  const sessionId = req.header('x-session-id');
  if (!repo || !sessionId) return undefined;
  return { repo, sessionId };
}

function buildServer(
  locks: DevEnvLocks,
  identity: { repo: string; sessionId: string } | undefined,
  notify: Notify,
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
      if (!identity) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required X-Repo or X-Session-Id header' }] };
      }
      const { repo, sessionId } = identity;
      const res = locks.claim(repo, sessionId, sessionId);
      if (res.status === 'granted') {
        return { content: [{ type: 'text', text: `You now hold the ${repo} dev environment. Call release_dev when done.` }] };
      }
      if (res.status === 'granted-broke-stale') {
        await notify(
          res.prior.workerId,
          'dev-env',
          `Your hold on the ${repo} dev environment was released after being held past the limit. Another session has taken it.`,
        );
        return {
          content: [
            { type: 'text', text: `You now hold the ${repo} dev environment (a stale hold was broken to grant it). Call release_dev when done.` },
          ],
        };
      }
      const wr = await locks.waitFor(res.ticket);
      if (wr.status === 'granted') {
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
      if (!identity) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required X-Repo or X-Session-Id header' }] };
      }
      const { repo, sessionId } = identity;
      const res = locks.release(repo, sessionId);
      if (!res.released) {
        return { content: [{ type: 'text', text: `You don't currently hold the ${repo} dev environment.` }] };
      }
      return { content: [{ type: 'text', text: `Released the ${repo} dev environment${res.promoted ? ' — handed off to a waiting session.' : '.'}` }] };
    },
  );

  return server;
}

export function createDevlockApp(locks: DevEnvLocks, notify: Notify): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const identity = identityFromHeaders(req);
    const server = buildServer(locks, identity, notify);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  });

  return app;
}
