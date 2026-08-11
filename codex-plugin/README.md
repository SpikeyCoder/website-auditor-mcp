# Website Auditor — Codex plugin

Packages the [website-auditor-mcp](https://github.com/SpikeyCoder/website-auditor-mcp)
server for Codex's plugin system: the MCP server (bundled via `npx`) plus four
skills that mirror the server's MCP prompts, which Codex does not otherwise
surface.

## Install

From the repo root (or a clone):

```
codex plugin marketplace add SpikeyCoder/website-auditor-mcp
codex plugin add website-auditor
```

No API key is needed to try it — ask for a *sample audit*. Auditing real
domains needs a Website Auditor subscription and an API key from
<https://api.website-auditor.io/admin_portal/?source=mcp>; see the main
[README](../README.md) for configuration.

## Layout

| Path | What it is |
|---|---|
| `.codex-plugin/plugin.json` | Manifest + directory listing metadata |
| `.mcp.json` | Bundled MCP server (`npx -y website-auditor-mcp`) |
| `skills/` | The four MCP prompts, ported to plugin skills |
| `assets/icon.png` | Listing icon (copy of the repo icon) |

The plugin versions independently of the npm package: bump
`.codex-plugin/plugin.json` only when the plugin itself changes. The bundled
server tracks npm `latest` on its own through `npx -y`.

Directory submission status and the full plan live in
[docs/CODEX-PLUGIN.md](../docs/CODEX-PLUGIN.md).
