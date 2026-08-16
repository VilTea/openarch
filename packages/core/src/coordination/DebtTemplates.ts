// packages/core/src/coordination/DebtTemplates.ts
// Debt documents are Agent-owned deferred decisions in the shared docs-repo.
// This module only generates and validates the local templates:
//   debts/<repositoryId>/<serviceId>/<debtId>.json
// The coordination service validates the same schema when listing them.
import { validateScopeIdentity } from "./ScopeTemplates";

const DEBT_SCHEMA_VERSION = "1";
const DEBT_STATUSES = ["deferred", "accepted", "resolved", "superseded"] as const;
export type DebtStatus = (typeof DEBT_STATUSES)[number];

export interface DebtDocument {
  readonly schemaVersion: typeof DEBT_SCHEMA_VERSION;
  readonly debt: {
    readonly repositoryId: string;
    readonly serviceId: string;
    readonly debtId: string;
  };
  readonly title: string;
  readonly reason: string;
  readonly reconsiderCondition: string;
  readonly acceptanceCriteria?: string;
  readonly status: DebtStatus;
}

const requireText = (kind: string, value: string, min: number, max: number): void => {
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error(`${kind} must be ${min}..${max} characters`);
};

export const debtDocument = (input: {
  readonly repositoryId: string;
  readonly serviceId: string;
  readonly debtId: string;
  readonly title: string;
  readonly reason: string;
  readonly reconsiderCondition: string;
  readonly acceptanceCriteria?: string;
  readonly status?: DebtStatus;
}): DebtDocument => {
  const repositoryError = validateScopeIdentity(input.repositoryId);
  if (repositoryError) throw new Error(`repositoryId: ${repositoryError}`);
  const serviceError = validateScopeIdentity(input.serviceId);
  if (serviceError) throw new Error(`serviceId: ${serviceError}`);
  const debtError = validateScopeIdentity(input.debtId);
  if (debtError) throw new Error(`debtId: ${debtError}`);
  requireText("title", input.title, 1, 240);
  requireText("reason", input.reason, 1, 2000);
  requireText("reconsiderCondition", input.reconsiderCondition, 1, 500);
  const status = input.status ?? "deferred";
  if (!DEBT_STATUSES.includes(status)) throw new Error(`status must be one of: ${DEBT_STATUSES.join(", ")}`);
  return {
    schemaVersion: DEBT_SCHEMA_VERSION,
    debt: { repositoryId: input.repositoryId, serviceId: input.serviceId, debtId: input.debtId },
    title: input.title.trim(),
    reason: input.reason.trim(),
    reconsiderCondition: input.reconsiderCondition.trim(),
    ...(input.acceptanceCriteria?.trim() ? { acceptanceCriteria: input.acceptanceCriteria.trim() } : {}),
    status,
  };
};

export const debtDocumentPath = (document: DebtDocument): string =>
  `debts/${document.debt.repositoryId}/${document.debt.serviceId}/${document.debt.debtId}.json`;
