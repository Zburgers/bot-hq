import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { db } from './db.js';
import { env } from './env.js';

const exec = promisify(execFile);
const pending = new Map<string, Promise<Runtime>>();

export interface Runtime {
  botId: string;
  containerName: string;
  home: string;
  filesRoot: string;
  desktopUrl: string;
  gatewayUrl: string;
  screenId: string;
  apiPort: number;
  desktopPort: number;
}

export function runtimeForBot(botId: string): Runtime {
  if (!/^(bot|sub)_[\w-]+$/.test(botId)) throw new Error('Invalid bot runtime id');
  const bot = db.prepare('SELECT engine_port FROM bots WHERE id=?').get(botId) as { engine_port: number } | undefined;
  const apiPort = bot?.engine_port;
  if (!apiPort || !Number.isInteger(apiPort) || apiPort < env.enginePortBase || apiPort > 65535) {
    throw new Error(`Bot ${botId} has no valid runtime port`);
  }
  const desktopPort = env.desktopPortBase + apiPort - env.enginePortBase;
  if (!Number.isInteger(desktopPort) || desktopPort < 1 || desktopPort > 65535) throw new Error('Invalid desktop runtime port');
  return {
    botId, apiPort, desktopPort, containerName: `bot-hq-${botId}`,
    home: path.resolve(env.enginesDir, botId), filesRoot: path.resolve(env.runtimeDir, botId),
    desktopUrl: `http://127.0.0.1:${desktopPort}`, gatewayUrl: `http://127.0.0.1:${apiPort}`,
    screenId: `screen-${apiPort}`,
  };
}

export function runtimeForScreen(screenId?: string | null): Runtime {
  const port = /^screen-(\d+)$/.exec(screenId ?? '')?.[1];
  const bot = port ? db.prepare('SELECT id FROM bots WHERE engine_port=?').get(Number(port)) as { id: string } | undefined : undefined;
  if (!bot) throw new Error(`Unknown bot runtime screen: ${screenId ?? '(missing)'}`);
  return runtimeForBot(bot.id);
}

function envFile(runtime: Runtime): string {
  return path.join(path.dirname(env.runtimeDir), 'runtime-secrets', `${runtime.botId}.env`);
}

export function desktopToken(runtime: Runtime): string {
  const token = /^DESKTOP_TOKEN=([a-f0-9]+)$/m.exec(fs.readFileSync(envFile(runtime), 'utf8'))?.[1];
  if (!token) throw new Error(`Desktop credentials are missing for ${runtime.botId}`);
  return token;
}

/** No credentials in arguments and no host home, Docker socket, or credential file mounted. */
export function runtimeArgs(runtime: Runtime, privateEnvFile: string): string[] {
  return [
    'run', '-d', '--name', runtime.containerName,
    '--label', 'bot-hq.managed=true', '--label', `bot-hq.bot-id=${runtime.botId}`,
    '--restart', 'unless-stopped', '--network', env.runtimeNetwork,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--shm-size', '1g', '--memory', '3g', '--cpus', '2', '--pids-limit', '768',
    '--publish', `127.0.0.1:${runtime.desktopPort}:8090`,
    '--publish', `127.0.0.1:${runtime.apiPort}:${runtime.apiPort}`,
    '--mount', `type=bind,src=${runtime.home},dst=${runtime.home}`,
    '--mount', `type=bind,src=${runtime.filesRoot},dst=${env.boxHome}`,
    '--env-file', privateEnvFile, env.runtimeImage,
  ];
}

type Container = { Config?: { Labels?: Record<string, string> }; State?: { Running?: boolean } };

export function assertRuntimeOwner(container: Container, runtime: Runtime): void {
  const labels = container.Config?.Labels;
  if (labels?.['bot-hq.managed'] !== 'true' || labels?.['bot-hq.bot-id'] !== runtime.botId) {
    throw new Error(`Container ${runtime.containerName} is not owned by this Bot HQ bot`);
  }
}

async function docker(args: string[]): Promise<string> {
  try {
    return (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch (error: any) {
    // Only stderr is reported: inspect output may contain private configuration.
    throw new Error(`Docker ${args[0]} failed: ${String(error.stderr || error.message).trim().slice(0, 500)}`);
  }
}

async function inspect(runtime: Runtime): Promise<Container | null> {
  try {
    const format = '{"Config":{"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}}}}';
    return JSON.parse(await docker(['inspect', '--format', format, runtime.containerName]));
  } catch (error: any) {
    if (/No such (object|container)/i.test(error.message)) return null;
    throw error;
  }
}

function prepareRuntime(runtime: Runtime): void {
  for (const dir of [runtime.home, runtime.filesRoot, path.dirname(envFile(runtime))]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  if (fs.existsSync(envFile(runtime))) { desktopToken(runtime); return; }
  const vars = {
    HERMES_HOME: runtime.home, BH_HOME: path.join(runtime.home, 'browser-harness'),
    HERMES_GATEWAY_LOCK_DIR: path.join(runtime.home, 'locks'),
    API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: String(runtime.apiPort),
    DESKTOP_TOKEN: crypto.randomBytes(32).toString('hex'), DISPLAY: ':99', HQ_BOX_HOME: env.boxHome,
  };
  if (Object.values(vars).some((value) => /[\r\n]/.test(value))) throw new Error('Runtime environment values cannot contain newlines');
  fs.writeFileSync(envFile(runtime), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
}

export function ensureRuntime(botId: string): Promise<Runtime> {
  const existing = pending.get(botId);
  if (existing) return existing;
  const work = startRuntime(botId).finally(() => pending.delete(botId));
  pending.set(botId, work);
  return work;
}

async function startRuntime(botId: string): Promise<Runtime> {
  const runtime = runtimeForBot(botId);
  const container = await inspect(runtime);
  if (container) {
    assertRuntimeOwner(container, runtime);
    desktopToken(runtime);
    if (!container.State?.Running) {
      fs.rmSync(path.join(runtime.home, '.hq-ready'), { force: true });
      await docker(['start', runtime.containerName]);
    }
  } else {
    prepareRuntime(runtime);
    fs.rmSync(path.join(runtime.home, '.hq-ready'), { force: true });
    await docker(runtimeArgs(runtime, envFile(runtime)));
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await desktopCall(runtime, 'GET', '/computer', undefined, 1500); return runtime; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Desktop for ${botId} did not become ready`);
}

/** Removal is deliberately limited to a container with both ownership labels. Bot data stays. */
export async function stopRuntime(botId: string): Promise<void> {
  await pending.get(botId)?.catch(() => {});
  const runtime = runtimeForBot(botId);
  const container = await inspect(runtime);
  if (!container) return;
  assertRuntimeOwner(container, runtime);
  await docker(['rm', '-f', runtime.containerName]);
}

export async function desktopCall<T = any>(runtime: Runtime, method: string, endpoint: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  const response = await fetch(`${runtime.desktopUrl}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${desktopToken(runtime)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(`Desktop ${method} ${endpoint.split('?')[0]} failed (${response.status}): ${data?.error ?? response.statusText}`);
  return data as T;
}
