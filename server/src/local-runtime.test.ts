import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-runtime-test-'));
Object.assign(process.env, {
  XAI_API_KEY: 'test', COMPOSIO_API_KEY: 'test', ORGO_API_KEY: 'test', SESSION_SECRET: 'test',
  DB_PATH: path.join(root, 'hq.db'), COMPUTER_PROVIDER: 'docker', ENGINES_DIR: path.join(root, 'engines'),
  RUNTIME_DIR: path.join(root, 'computers'), ENGINE_PORT_BASE: '8660', DESKTOP_PORT_BASE: '18091',
});
const { db } = await import('./db.js');
const { env } = await import('./env.js');
Object.assign(env, {
  computerProvider: 'docker', boxHome: '/home/agent/grokbot', runtimeImage: 'bot-hq-desktop:local',
  runtimeNetwork: 'grokbot-desktop-net', runtimeDir: path.join(root, 'computers'), desktopPortBase: 18091,
});
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('test-user', 'test@example.invalid', 'Test', 1);
for (const [id, port] of [['bot_first', 8660], ['bot_second', 8661], ['sub_helper', 8662]] as const) {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'test-user', id, 'managed', port, 1, 1);
}
after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('bots get separate container, file, desktop and gateway routes', async () => {
  const { runtimeForBot, runtimeForScreen } = await import('./local-runtime.js');
  const first = runtimeForBot('bot_first');
  const second = runtimeForBot('bot_second');
  assert.equal(first.containerName, 'bot-hq-bot_first');
  assert.equal(first.screenId, 'screen-8660');
  assert.equal(first.desktopUrl, 'http://127.0.0.1:18091');
  assert.equal(second.desktopUrl, 'http://127.0.0.1:18092');
  assert.equal(first.gatewayUrl, 'http://127.0.0.1:8660');
  assert.equal(first.home, path.join(root, 'engines', 'bot_first'));
  assert.equal(first.filesRoot, path.join(root, 'computers', 'bot_first'));
  assert.deepEqual(runtimeForScreen('screen-8661'), second);
  assert.throws(() => runtimeForScreen('screen-99'), /screen|runtime/i);
  assert.throws(() => runtimeForBot('../goofy'), /bot/i);
});

test('container arguments only expose the assigned loopback ports and two bot directories', async () => {
  const { runtimeForBot, runtimeArgs } = await import('./local-runtime.js');
  const runtime = runtimeForBot('bot_first');
  const privateEnv = path.join(root, 'runtime-secrets', 'bot_first.env');
  const args = runtimeArgs(runtime, privateEnv);
  assert.ok(args.includes('127.0.0.1:18091:8090'));
  assert.ok(args.includes('127.0.0.1:8660:8660'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('unless-stopped'));
  assert.ok(args.includes('grokbot-desktop-net'));
  assert.ok(args.includes(privateEnv));
  const mounts = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []);
  assert.deepEqual(mounts, [
    `type=bind,src=${runtime.home},dst=${runtime.home}`,
    `type=bind,src=${runtime.filesRoot},dst=/home/agent/grokbot`,
  ]);
  assert.ok(!mounts.some((mount) => mount.includes('runtime-secrets') || mount.includes('docker.sock')));
  assert.ok(!args.join(' ').includes('DESKTOP_TOKEN='));
});

test('only containers labeled for this application and bot may be adopted or stopped', async () => {
  const { runtimeForBot, assertRuntimeOwner } = await import('./local-runtime.js');
  const runtime = runtimeForBot('bot_first');
  assert.throws(() => assertRuntimeOwner({}, runtime), /owned|label/i);
  assert.throws(() => assertRuntimeOwner({ Config: { Labels: { 'bot-hq.managed': 'true', 'bot-hq.bot-id': 'bot_second' } } }, runtime), /owned|label/i);
  assert.doesNotThrow(() => assertRuntimeOwner({ Config: { Labels: { 'bot-hq.managed': 'true', 'bot-hq.bot-id': 'bot_first' } } }, runtime));
});

test('logical screen identities always use display 99 and browser port 9299 in their container', async () => {
  const { displayFor } = await import('./box.js');
  const { cdpPortFor } = await import('./desk.js');
  assert.equal(displayFor('screen-8660'), ':99');
  assert.equal(cdpPortFor('screen-8661'), 9299);
  env.computerProvider = 'orgo';
  try {
    assert.equal(displayFor('default'), ':99');
    assert.equal(displayFor('screen-100'), ':100');
    assert.equal(cdpPortFor('screen-100'), 9300);
  } finally { env.computerProvider = 'docker'; }
});

test('hidden helper agents get the same isolated runtime mapping', async () => {
  const { runtimeForBot } = await import('./local-runtime.js');
  assert.equal(runtimeForBot('sub_helper').screenId, 'screen-8662');
});

test('runtime creation keeps tokens private and shell commands inside the authenticated desktop API', async () => {
  const { ensureRuntime, stopRuntime } = await import('./local-runtime.js');
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  const callsFile = path.join(root, 'docker-calls.jsonl');
  const stateFile = path.join(root, 'fake-container.json');
  fs.writeFileSync(path.join(fakeBin, 'docker'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
const state = ${JSON.stringify(stateFile)};
if (args[0] === 'inspect') {
  if (!fs.existsSync(state)) { process.stderr.write('No such object'); process.exit(1); }
  process.stdout.write(fs.readFileSync(state));
} else if (args[0] === 'run') {
  fs.writeFileSync(state, JSON.stringify({Config:{Labels:{'bot-hq.managed':'true','bot-hq.bot-id':'bot_first'}},State:{Running:true}}));
} else if (args[0] === 'rm') { fs.unlinkSync(state); }
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath}`;
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(String(input).endsWith('/bash') ? { output: 'inside container', exit_code: 0 } : { id: 'local', status: 'running' }), { status: 200 });
  });
  try {
    const marker = path.join(root, 'engines', 'bot_first', '.hq-ready');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'old configuration');
    await Promise.all([ensureRuntime('bot_first'), ensureRuntime('bot_first')]);
    assert.ok(!fs.existsSync(marker), 'a new container must wait for current configuration');
    fs.writeFileSync(marker, 'current configuration');
    await ensureRuntime('bot_first');
    assert.ok(fs.existsSync(marker), 'adopting a running container must preserve its ready marker');
    fs.writeFileSync(stateFile, JSON.stringify({ Config: { Labels: { 'bot-hq.managed': 'true', 'bot-hq.bot-id': 'bot_first' } }, State: { Running: false } }));
    await ensureRuntime('bot_first');
    assert.ok(!fs.existsSync(marker), 'restarting a stopped container must wait for current configuration');
    const privateEnv = path.join(root, 'runtime-secrets', 'bot_first.env');
    assert.equal(fs.statSync(privateEnv).mode & 0o777, 0o600);
    const token = /^DESKTOP_TOKEN=(.+)$/m.exec(fs.readFileSync(privateEnv, 'utf8'))![1];
    assert.ok(token.length >= 32);
    assert.equal((requests[0].init!.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    const { box } = await import('./box.js');
    assert.deepEqual(await box.bash('echo inside', 10, 'screen-8660'), { output: 'inside container', exit_code: 0 });
    assert.deepEqual(JSON.parse(String(requests.at(-1)!.init!.body)), { command: 'echo inside', timeout: 10 });
    await assert.rejects(box.bash('touch /tmp/must-not-run-on-host'), /runtime screen/i);
    fs.writeFileSync(stateFile, JSON.stringify({ Config: { Labels: { 'bot-hq.managed': 'true', 'bot-hq.bot-id': 'someone_else' } } }));
    await assert.rejects(stopRuntime('bot_first'), /not owned/);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.filter((args) => args[0] === 'run').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'rm').length, 0);
    assert.ok(!fs.readFileSync(callsFile, 'utf8').includes(token));
    fs.writeFileSync(stateFile, JSON.stringify({ Config: { Labels: { 'bot-hq.managed': 'true', 'bot-hq.bot-id': 'bot_first' } } }));
    await stopRuntime('bot_first');
    assert.ok(fs.existsSync(path.join(root, 'engines', 'bot_first')));
    assert.ok(fs.existsSync(path.join(root, 'computers', 'bot_first')));
    assert.ok(fs.existsSync(privateEnv));
  } finally {
    process.env.PATH = oldPath;
    fetchMock.mock.restore();
  }
});
