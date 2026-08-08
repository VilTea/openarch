// packages/core/src/port/LockService.ts
import { Context, Effect } from "effect";

/** 锁句柄（adapter 内部使用，对外不透明） */
export interface LockHandle {
  readonly name: string;
  readonly agentId: string;
  readonly acquiredAt: number;
  /** One acquisition instance; release must never delete a successor's lock. */
  readonly lockId: string;
}

/** Port：advisory file lock（design v5.2 §5.6.3） */
export interface LockService {
  /** 非阻塞获取锁；持有期间每 5 秒刷新心跳。 */
  readonly acquire: (name: string, agentId: string) => Effect.Effect<LockHandle, LockError>;
  /** 释放锁 */
  readonly release: (handle: LockHandle) => Effect.Effect<void>;
}

export const LockService = Context.GenericTag<"LockService", LockService>("LockService");

export class LockError {
  readonly _tag = "LockError";
  constructor(
    readonly lockName: string,
    readonly reason: string,
  ) {}
}
