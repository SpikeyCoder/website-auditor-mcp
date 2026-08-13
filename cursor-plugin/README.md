# Website Auditor — Cursor plugin

Packages the [website-auditor-mcp](https://github.com/SpikeyCoder/website-auditor-mcp)
server for Cursor's plugin system: the MCP server (bundled via `npx`) plus the
same four skills the Codex plugin ships, mirroring the server's MCP prompts.

## Install

Once listed on the [Cursor Marketplace](https://cursor.com/marketplace),
install from Cursor's Customize page. Until then:

- **One-click MCP install** (server only, no plugin machinery):
  [Install in Cursor](https://cursor.com/install-mcp?name=website-auditor&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIndlYnNpdGUtYXVkaXRvci1tY3AiXSwiZW52Ijp7IldBX0FQSV9LRVkiOiIifX0%3D)
- **Local plugin** (development/testing):

  ```
  ln -s /path/to/website-auditor-mcp/cursor-plugin ~/.cursor/plugins/local/website-auditor
  ```

  then reload Cursor (`Developer: Reload Window`). Remove the symlink to
  uninstall.

No API key is needed to try it — ask for a *sample audit*. Auditing real
domains needs a Website Auditor subscription and an API key from
<https://api.website-auditor.io/admin_portal/?source=mcp>: set the plugin's
`WA_API_KEY` variable (or the `env` entry in `~/.cursor/mcp.json` for the
plain MCP install). Configuration details live in the main
[README](../README.md).

## Layout

| Path | What it is |
|---|---|
| `.cursor-plugin/plugin.json` | Manifest + listing metadata; `variables` declares `WA_API_KEY` |
| `mcp.json` | Bundled MCP server (`npx -y website-auditor-mcp`) |
| `skills/` | The four MCP prompts as skills — byte-identical with `codex-plugin/skills/` |
| `assets/icon.png` | Listing icon (copy of the repo icon) |

The skills are the same product surface as the server's MCP prompts and the
Codex plugin's skills; `tests/cursorPlugin.test.ts` pins all three together,
so changing one without the others fails the suite.

The plugin versions independently of the npm package: bump
`.cursor-plugin/plugin.json` only when the plugin itself changes. The bundled
server tracks npm `latest` on its own through `npx -y`, so npm releases reach
plugin users without a marketplace re-review.

Marketplace submission status and steps live in
[docs/CURSOR-PLUGIN.md](../docs/CURSOR-PLUGIN.md).
