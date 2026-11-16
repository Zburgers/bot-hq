import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { orgo } from './orgo.js';
import { desktopCall, desktopToken, runtimeForScreen } from './local-runtime.js';

/**
 * Docker commands and files go through that bot's authenticated desktop daemon. Orgo retains
 * its remote API and HQ_LOCAL shell modes; Docker never runs bot commands on the host.
 */

export interface BashResult { output: string; exit_code: number }

/** Docker has one :99 display per container. Orgo screen-N uses display :N. */
export const displayFor = (screenId?: string | null) => env.computerProvider === 'docker' || !screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`;

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: displayFor(screenId),
  };
}

function localBash(command: string, timeoutSec: number, screenId?: string | null): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

/** A path safe to put inside single quotes in a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const box = {
  local: env.localBox && env.computerProvider !== 'docker',

  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  async bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    if (env.computerProvider === 'docker') {
      return desktopCall(runtimeForScreen(screenId), 'POST', '/bash', { command, timeout: timeoutSec }, (timeoutSec + 40) * 1000);
    }
    if (env.localBox) return localBash(command, timeoutSec, screenId);
    if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set');
    const cmd = `export DISPLAY=${displayFor(screenId)}; ${command}`;
    const r = await orgo.bash(env.orgoComputerId, screenId ?? undefined, cmd, timeoutSec);
    return { output: r.output ?? '', exit_code: r.exit_code ?? (r.success ? 0 : 1) };
  },

  async writeFile(file: string, content: string | Buffer, mode = '0644', screenId?: string | null): Promise<void> {
    if (!/^[0-7]{3,4}$/.test(mode)) throw new Error('Invalid file mode');
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (env.localBox && env.computerProvider !== 'docker') {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      await fs.chmod(file, parseInt(mode, 8));
      return;
    }
    // Orgo drops very long commands, so the file goes over in base64 pieces.
    const b64 = buf.toString('base64');
    const tmp = `${file}.b64`;
    const first = await box.bash(`mkdir -p ${q(path.dirname(file))} && : > ${q(tmp)} && echo ok`, 30, screenId);
    if (!first.output.includes('ok')) throw new Error(`could not write ${file}: ${first.output.slice(0, 200)}`);
    for (let i = 0; i < b64.length; i += 60000) {
      const part = await box.bash(`printf '%s' '${b64.slice(i, i + 60000)}' >> ${q(tmp)}`, 30, screenId);
      if (part.exit_code !== 0) throw new Error(`could not write ${file}`);
    }
    const done = await box.bash(`base64 -d ${q(tmp)} > ${q(file)} && rm -f ${q(tmp)} && chmod ${mode} ${q(file)} && echo ok`, 30, screenId);
    if (!done.output.includes('ok')) throw new Error(`could not write ${file}: ${done.output.slice(0, 200)}`);
  },

  /** Read a file from the box, or null if it isn't there. Meant for small files (under ~4 MB). */
  async readFile(file: string, screenId?: string | null): Promise<Buffer | null> {
    if (env.computerProvider === 'docker') {
      const runtime = runtimeForScreen(screenId);
      const response = await fetch(`${runtime.desktopUrl}/files?path=${encodeURIComponent(file)}`, {
        headers: { Authorization: `Bearer ${desktopToken(runtime)}` }, signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Could not read desktop file (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    }
    if (env.localBox) {
      try { return await fs.readFile(file); } catch { return null; }
    }
    const r = await box.bash(`[ -f ${q(file)} ] && base64 -w0 ${q(file)} || echo __missing__`, 60, screenId);
    const out = r.output.trim();
    if (!out || out.endsWith('__missing__')) return null;
    return Buffer.from(out, 'base64');
  },

  quote: q,
};
