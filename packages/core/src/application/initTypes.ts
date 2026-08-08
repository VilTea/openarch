export interface InitInput {
  readonly cwd: string;
  readonly docsRepo?: string;
  readonly documentStore?: "project";
  readonly documentScope?: string;
  readonly unlink?: boolean;
  readonly installHook?: boolean;
  /** Install or refresh the packaged Skill in this repository for a known agent. */
  readonly agentSkillTarget?: import("./agentSkill").AgentSkillTarget;
  /** Project-relative custom parent directory for the packaged Skill. */
  readonly skillDir?: string;
  /** Convenience migration that writes governance.persistence: local|tracked. */
  readonly persistence?: import("./governancePersistence").GovernancePersistence;
  readonly defaultScripts?: readonly string[];
  /** --replace-script: explicit migration for selected shipped assets only. */
  readonly replaceDefaultScripts?: boolean;
  /** Create (without overwriting) a user or checkout-local external toolchain configuration. */
  readonly toolchainConfigScope?: import("../toolchain/config").ToolchainConfigScope;
  /** Optional, local coordinator endpoint; separate from --docs-repo. */
  readonly coordinationUrl?: string;
  /** Explicitly remove the local coordinator endpoint selection. */
  readonly clearCoordination?: boolean;
}

export interface InitOutput {
  readonly code: number;
  readonly messages: string[];
}
