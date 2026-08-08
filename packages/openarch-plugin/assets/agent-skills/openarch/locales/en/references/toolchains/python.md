# Python Toolchain Configuration

Python symbol use needs the external `pyright` language server. Run `openarch toolchains` first; a Python interpreter or project `.venv` does not establish availability.

Use the user configuration path reported by that command:

```yaml
version: 1
tools:
  pyright:
    executable: "<absolute path to pyright-langserver>"
```

Run `openarch toolchains` again and require `AVAILABLE [user-config]`, then run `openarch check --worktree --semantic --report` for unstaged work and confirm that it reports `python-pyright-symbol-use` with coverage. Executables under the project `.venv` or `node_modules` remain rejected; dynamic imports and import hooks remain `PARTIAL` or `UNAVAILABLE`. Use `openarch check --staged --report` without `--semantic` before committing.
