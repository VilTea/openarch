# OpenArch for Codex

Install the persistent CLI first. For a project-local Codex Skill, use the CLI from the project root:

```bash
npm install --save-dev @openarch/cli
npx openarch init --agent codex
```

This installs `.codex/skills/openarch/` using the project's `presentation.locale`. Do not manually copy a Skill directory or use the standalone plugin installer for a project.

For a user-scoped Skill shared across Codex projects:

```bash
npm install --global @openarch/plugin
openarch-agent-install --target codex --locale en
```

The plugin also exposes the static `openarch-zh` and `openarch-en` Skills for hosts that discover plugin skills directly. Use the locale that matches the session; project governance remains the CLI's responsibility.

After initialization, run `openarch context`, then use `scan`, `review`, `check`, `rules`, or `docs` according to the task. Install the code hook separately with `openarch init --install-hook`.
