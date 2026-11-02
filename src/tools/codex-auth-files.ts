import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Same-directory replacement, fsync before visibility, directory fsync before acknowledging. */
export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.next`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}

/** Durable O_EXCL fence. A crash deliberately leaves it behind for founder recovery. */
export async function claimRefresh(path: string): Promise<boolean> {
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try { await lock.writeFile('refresh attempt claimed\n'); await lock.sync(); }
  finally { await lock.close(); }
  const dir = await open(dirname(path), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return true;
}
