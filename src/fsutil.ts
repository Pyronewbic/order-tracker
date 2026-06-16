import { writeFile, rename, chmod } from "node:fs/promises";

/**
 * Write a file atomically (temp file + rename) and restrict it to owner-only
 * (`0600`). The temp+rename pattern avoids torn writes if the process dies
 * mid-write; the explicit {@link chmod} after the rename is necessary because
 * `writeFile`'s `mode` only applies when it *creates* the file, and the rename
 * carries over the temp file's mode rather than re-applying it to the target.
 *
 * Used for everything that may hold a secret or a watermark: `accounts.json`,
 * `state.json`. `chmod` is best-effort — platforms without POSIX permissions
 * (e.g. some Windows setups) simply skip it.
 */
export async function writeFileAtomic(
  file: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents, { mode });
  await rename(tmp, file);
  await chmod(file, mode).catch(() => {
    /* best-effort: not all filesystems support chmod */
  });
}

/** Best-effort `chmod 0600` on an existing file; ignores a missing file. */
export async function hardenFile(file: string, mode = 0o600): Promise<void> {
  await chmod(file, mode).catch(() => {
    /* file may not exist yet, or fs has no chmod — both are fine */
  });
}
