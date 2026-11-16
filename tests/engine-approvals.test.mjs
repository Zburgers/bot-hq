import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after, mock } from 'node:test';
import YAML from 'yaml';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-engine-approval-'));
const seed = path.join(root, 'seed');
const home = path.join(root, 'engines', 'bot_test');
const bin = path.join(root, 'bin');
fs.mkdirSync(seed);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(seed, 'config.yaml'), YAML.stringify({ model: { default: 'fixture-model' }, approvals: { mode: 'manual' } }));
const container = path.join(root, 'container.json');
fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(container)};
if (args[0] === 'inspect') {
  if (!fs.existsSync(file)) { process.stderr.write('No such object'); process.exit(1); }
  process.stdout.write(fs.readFileSync(file));
} else if (args[0] === 'run') {
  fs.writeFileSync(file, JSON.stringify({Config:{Labels:{'bot-hq.managed':'true','bot-hq.bot-id':'bot_test'}},State:{Running:true}}));
} else if (args[0] === 'rm') fs.unlinkSync(file);
`, { mode: 0o700 });
Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`, COMPUTER_PROVIDER: 'docker',
  DB_PATH: path.join(root, 'test.db'), ENGINES_DIR: path.dirname(home), HERMES_HOME_PRIMARY: seed,
  RUNTIME_DIR: path.join(root, 'computers'), ENGINE_PORT_BASE: '8660',
  COMPOSIO_API_KEY: 'fixture', SESSION_SECRET: 'fixture',
});
const { db } = await import('../server/src/db.ts');
db.prepare("INSERT INTO users(id,email,name,created_at) VALUES ('u','u@test.invalid','Owner',0)").run();
db.prepare("INSERT INTO bots(id,user_id,name,engine,engine_port,created_at,updated_at) VALUES ('bot_test','u','Test','managed',8660,0,0)").run();
const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
  const endpoint = new URL(String(url)).pathname;
  const ready = fs.existsSync(container) && fs.existsSync(path.join(home, '.hq-ready'));
  if (endpoint === '/health' || endpoint === '/v1/models') return new Response('{}', { status: ready ? 200 : 503 });
  if (endpoint === '/computer') return Response.json({ status: 'running', width: 1280, height: 800 });
  if (endpoint === '/screens') return Response.json({ screens: [{ id: 'default', width: 1280, height: 800 }] });
  if (endpoint === '/bash') return Response.json({ output: '', exit_code: 0 });
  throw new Error(`Unexpected request: ${endpoint}`);
});
const { engineFor, restartEngine } = await import('../server/src/engine.ts');

test('local desktop actions stay authorized across provisioning and restarts', async () => {
  await engineFor('bot_test');
  const file = path.join(home, 'config.yaml');
  const cfg = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.approvals?.mode, 'off', 'local Docker desktop must not wait on an invisible Hermes approval');
  assert.equal(cfg.model.default, 'fixture-model');
  assert.match(cfg.mcp_servers.hq.url, /\/mcp\/bot_test$/);
  cfg.approvals = { mode: 'smart', timeout: 45 };
  fs.writeFileSync(file, YAML.stringify(cfg));
  await restartEngine('bot_test');
  await engineFor('bot_test');
  const restarted = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(restarted.approvals.mode, 'off');
  assert.equal(restarted.approvals.timeout, 45);
  assert.equal(YAML.parse(fs.readFileSync(path.join(seed, 'config.yaml'), 'utf8')).approvals.mode, 'manual', 'unrelated primary home must remain unchanged');
});

after(() => { fetchMock.mock.restore(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
