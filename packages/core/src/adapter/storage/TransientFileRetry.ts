// Windows directory rename can remain unavailable longer than a single file
// replacement while indexers or antivirus release child handles. Keep the
// retry bounded, but give complete baseline generation a realistic window.
export const TRANSIENT_FILE_RETRY_DELAYS_MS = [50, 100, 250, 500, 1_000, 2_000] as const;

type Pause = (milliseconds: number) => Promise<void>;
type FileOperation<Result> = () => Promise<Result>;

const pause: Pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isTransientFileLockError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && (error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES");

/** Retries the same Windows file-lock boundary for atomic writes and generation renames. */
export const retryTransientFileOperation = async <Result>(
  operation: FileOperation<Result>,
  wait: Pause = pause,
): Promise<Result> => {
  for (const delay of TRANSIENT_FILE_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileLockError(error)) throw error;
      await wait(delay);
    }
  }
  return operation();
};
