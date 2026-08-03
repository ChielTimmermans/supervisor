import 'dotenv/config';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { MattermostGateway } from './mattermost.js';
import { Bridge } from './bridge.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const cfg = loadConfig(process.env, process.env.REPOS_JSON ?? '{}');
  await mkdir(path.dirname(cfg.dbPath), { recursive: true });
  const db = new Db(cfg.dbPath);
  const gateway = new MattermostGateway(cfg.mattermost);
  const bridge = new Bridge({ queryFn: query, gateway, db, cfg });
  await bridge.start();
  console.log('Supervisor bridge online.');

  const shutdown = () => { gateway.close(); db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((err) => { console.error(err); process.exit(1); });
