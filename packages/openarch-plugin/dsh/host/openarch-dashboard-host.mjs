/**
 * Host-safe default entry for the `@openarch/plugin` package.
 *
 * In the DSH bundle patch, the `openarch-dashboard` row names the package root
 * (`@openarch/plugin`). On the host plane that row has no host-side behavior:
 * the dashboard is a browser client module. This file makes that no-op explicit
 * instead of reusing the client source as the package default entry, which
 * previously made host imports "happen not to crash" for the wrong reason.
 */

export const name = "openarch-dashboard";

export const inject = [];

export function apply() {
  // Client-only plugin: host plane intentionally does nothing.
}
