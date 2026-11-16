import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Pin an opened file to an expected home, including when an agent can change symlinks. */
function checkFd(fd: number, root: string) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('A profile home cannot be a symlink');
  const canonical = fs.realpathSync(root);
  const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
  if (!opened.startsWith(canonical + path.sep) || !fs.fstatSync(fd).isFile()) throw new Error('File is outside its profile');
}

/** Read a private profile file without following a leaf or intermediate symlink outside its home. */
export function readPrivate(file: string, root = path.dirname(file)): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    checkFd(fd, root);
    if (fs.fstatSync(fd).size > 4 * 1024 * 1024) throw new Error('Profile file is too large');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

/** Replace a file atomically; never follow an agent-created destination symlink. */
export function writePrivate(file: string, content: string, root = path.dirname(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.hq-${crypto.randomBytes(12).toString('hex')}`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    checkFd(fd, root);
    fs.writeFileSync(fd, content);
    fs.renameSync(temp, file);
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
}
