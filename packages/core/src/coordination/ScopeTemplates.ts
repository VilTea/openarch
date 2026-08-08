// packages/core/src/coordination/ScopeTemplates.ts
// Scope registration documents are Agent-owned; this module only generates and
// validates the local templates. The document shape and path layout mirror the
// coordination service contract (services/coordination/internal/collaboration):
//   repositories/<repositoryId>/scope.json
//   services/<repositoryId>/<serviceId>/scope.json
//   products/<productId>/scope.json

const MAX_ID_LENGTH = 128;
const SCOPE_SCHEMA_VERSION = "1";

export const validateScopeIdentity = (value: string): string | undefined => {
  if (value.length === 0 || value.length > MAX_ID_LENGTH || !/^[A-Za-z0-9]/.test(value)) {
    return "identifier must start with an ASCII letter or digit and be at most 128 bytes";
  }
  if (!/^[A-Za-z0-9._:@-]+$/.test(value)) return "identifier contains an unsupported character";
  return undefined;
};

const requireIdentity = (kind: string, value: string): void => {
  const error = validateScopeIdentity(value);
  if (error) throw new Error(`${kind}: ${error}`);
};

export interface ScopeDocument {
  readonly schemaVersion: typeof SCOPE_SCHEMA_VERSION;
  readonly repository?: { readonly repositoryId: string };
  readonly service?: { readonly repositoryId: string; readonly serviceId: string };
  readonly product?: { readonly productId: string; readonly services: readonly { readonly repositoryId: string; readonly serviceId: string }[] };
}

export const repositoryDocument = (repositoryId: string): ScopeDocument => {
  requireIdentity("repositoryId", repositoryId);
  return { schemaVersion: SCOPE_SCHEMA_VERSION, repository: { repositoryId } };
};

export const serviceDocument = (repositoryId: string, serviceId: string): ScopeDocument => {
  requireIdentity("repositoryId", repositoryId);
  requireIdentity("serviceId", serviceId);
  return { schemaVersion: SCOPE_SCHEMA_VERSION, service: { repositoryId, serviceId } };
};

export const productDocument = (productId: string, serviceRefs: readonly string[]): ScopeDocument => {
  requireIdentity("productId", productId);
  if (serviceRefs.length === 0) throw new Error("product must reference at least one service");
  const seen = new Set<string>();
  const services = serviceRefs.map((ref) => {
    const [repositoryId, serviceId] = ref.split("/");
    if (!repositoryId || !serviceId || validateScopeIdentity(repositoryId) || validateScopeIdentity(serviceId)) {
      throw new Error(`service reference must be <repositoryId>/<serviceId>: ${ref}`);
    }
    const key = `${repositoryId}\u0000${serviceId}`;
    if (seen.has(key)) throw new Error(`product references service more than once: ${ref}`);
    seen.add(key);
    return { repositoryId, serviceId };
  });
  return { schemaVersion: SCOPE_SCHEMA_VERSION, product: { productId, services } };
};

/** The scope document path inside the docs-repo, mirroring the service contract. */
export const scopeDocumentPath = (document: ScopeDocument): string => {
  if (document.repository) return `repositories/${document.repository.repositoryId}/scope.json`;
  if (document.service) return `services/${document.service.repositoryId}/${document.service.serviceId}/scope.json`;
  if (document.product) return `products/${document.product.productId}/scope.json`;
  throw new Error("scope document must declare exactly one of repository/service/product");
};
