export interface ProjectTestExecution {
  readonly command: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** A project runner executes the configured test command; it never extracts framework syntax. */
export interface TestExecutionRunner {
  readonly id: string;
  readonly run: (cwd: string) => Promise<ProjectTestExecution>;
}
