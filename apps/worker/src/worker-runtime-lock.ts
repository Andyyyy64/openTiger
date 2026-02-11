import { open, readFile, rm, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

interface TaskRuntimeLock {
  path: string;
  handle: FileHandle;
}

function resolveTaskLockDir(): string {
  return process.env.OPENTIGER_TASK_LOCK_DIR ?? "/tmp/openTiger-task-locks";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

export async function acquireTaskRuntimeLock(taskId: string): Promise<TaskRuntimeLock | null> {
  const lockDir = resolveTaskLockDir();
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${taskId}.lock`);

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify(
        {
          taskId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    return { path: lockPath, handle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const raw = await readFile(lockPath, "utf-8");
        const parsed = JSON.parse(raw) as { pid?: number };
        if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
          await rm(lockPath, { force: true });
          return acquireTaskRuntimeLock(taskId);
        }
      } catch {
        // Avoid double-start even if lock info corrupted
      }
      return null;
    }
    throw error;
  }
}

export async function releaseTaskRuntimeLock(lock: TaskRuntimeLock | null): Promise<void> {
  if (!lock) {
    return;
  }
  try {
    await lock.handle.close();
  } finally {
    await rm(lock.path, { force: true }).catch(() => undefined);
  }
}
