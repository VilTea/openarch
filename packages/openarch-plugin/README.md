# OpenArch Agent Plugin

Install `@openarch/cli` for project governance. This package has two roles:

- It exposes `openarch-zh` and `openarch-en` as static host-discoverable Skills.
- Its `openarch-agent-install` command installs a user-scoped Skill only.

For a governed project, always install or refresh the project Skill through the CLI:

```bash
npm install --save-dev @openarch/cli
npx openarch init --agent codex
```

The CLI uses `.openarch/config.yml: presentation.locale` to choose `zh` or `en`. It is the only supported project-scope installation path. A temporary CLI `--lang` option changes output only and cannot replace the project Skill language.

For an optional user-scoped Skill:

```bash
npm install --global @openarch/plugin
openarch-agent-install --target codex --locale en
```

`--locale` is optional and defaults from the host locale. Supported targets are `codex`, `cursor`, `opencode`, `claude`, and `dsh` (DeepSeek Harness). For `dsh` the installer writes to `${DSH_HOME:-~/.dsh}/skills/openarch`. The standalone installer deliberately has no project scope; use `openarch init --agent <target>` for each project (`--agent dsh` writes `.dsh/skills/openarch`).

**DSH integration uses the bundle / dashboard plugin** (static package): install `@openarch/plugin` as a DSH profile bundle to enable the dashboard and the governance-state data channel. This path requires the packaged client bundle (`lib/client.js`), which is built by `pnpm --dir packages/openarch-plugin build:client` or automatically by `prepack` before `pnpm pack`. The DSH agent preset (`--preset`) has been removed because it was not stable. See [`dsh/README.md`](./dsh/README.md) for details.

For source or offline use, create local tarballs, install the CLI tarball into the governed project, then run the same CLI initialization:

```bash
pnpm release:local
npm install --save-dev /absolute/path/to/openarch-cli-<version>.tgz
npx openarch init --agent codex
```

Install the optional code hook after initialization with `openarch init --install-hook`. Use `openarch context` to expose read-only project facts, `openarch check --worktree --report` during implementation, and `openarch check --staged --report` after staging.
