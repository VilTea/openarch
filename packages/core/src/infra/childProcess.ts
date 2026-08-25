// Central child-process wrapper. Windows console windows are hidden for every
// child process by default, so callers cannot forget `windowsHide: true` and
// reintroduce terminal flicker.
import {
  execFileSync,
  execSync,
  spawnSync,
  type ExecFileSyncOptions,
  type ExecSyncOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

export function execFileHidden(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions & { encoding: "buffer" },
): Buffer;
export function execFileHidden(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions & { encoding: BufferEncoding },
): string;
export function execFileHidden(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer;
export function execFileHidden(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  return execFileSync(file, args, { ...options, windowsHide: true });
}

export function execHidden(
  command: string,
  options: ExecSyncOptions & { encoding: "buffer" },
): Buffer;
export function execHidden(
  command: string,
  options: ExecSyncOptions & { encoding: BufferEncoding },
): string;
export function execHidden(command: string, options?: ExecSyncOptions): string | Buffer;
export function execHidden(command: string, options: ExecSyncOptions = {}): string | Buffer {
  return execSync(command, { ...options, windowsHide: true });
}

export function spawnSyncHidden(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return spawnSync(command, args, { ...options, windowsHide: true });
}
