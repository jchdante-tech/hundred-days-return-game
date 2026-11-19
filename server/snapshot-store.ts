import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';

/** Publish only a fully written, synced snapshot; readers keep seeing the old file until then. */
export async function writeSnapshot(destination: string, serialized: string): Promise<void> {
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(temporary, 'wx', 0o600);
    await descriptor.writeFile(serialized, 'utf8');
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (descriptor) await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
