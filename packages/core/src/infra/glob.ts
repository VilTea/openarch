import * as fs from "node:fs";

/**
 * Node 20 typings do not yet expose the runtime's globSync API. Keep that
 * compatibility cast at one infrastructure boundary instead of copying it
 * into every application command.
 */
type NodeGlobSync = (pattern: string, options?: Record<string, unknown>) => string[];

export const globSync = (pattern: string, options?: Record<string, unknown>): string[] =>
  (fs as unknown as { readonly globSync: NodeGlobSync }).globSync(pattern, options);
