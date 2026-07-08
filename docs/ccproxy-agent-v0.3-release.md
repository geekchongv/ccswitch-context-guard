# CCProxy Agent v0.3 Release Notes

## Summary

v0.3 adds Claude Desktop 3P gateway support on top of the existing Claude CLI support.

When ccswitch configures Claude Desktop with a local 3P gateway such as:

```text
http://127.0.0.1:15721/claude-desktop
```

CCProxy Agent can temporarily rewrite the applied Claude Desktop config to:

```text
http://127.0.0.1:15722/claude-desktop
```

Requests still flow to ccswitch, but now pass through CCProxy Agent first:

```text
Claude Desktop -> CCProxy Agent :15722 -> ccswitch :15721 -> provider
```

## New Capabilities

- Detects Claude Desktop 3P local config library.
- Reads `_meta.json` and patches only the currently applied config.
- Preserves the existing ccswitch-generated models, API key, auth scheme, and gateway path.
- Restores the previous Desktop gateway URL on shutdown.
- Recovers stale Desktop patches left by a crashed previous process.
- Treats prefixed routes such as `/claude-desktop/v1/messages` as AI routes, so the v0.2 token guard still applies.

## Default Policy

```json
{
  "claudeConfigPatch": {
    "enabled": true
  },
  "claudeDesktopConfigPatch": {
    "enabled": true
  }
}
```

On Windows, the default Desktop config path is:

```text
%LOCALAPPDATA%/Claude-3p/configLibrary
```

## Important Notes

- Claude Desktop reads 3P config on launch. Fully quit and reopen Claude Desktop after the proxy starts.
- This feature does not edit MCP server definitions.
- This feature does not log the full Desktop config because that file may contain secrets.
- If a managed MDM policy overrides local Desktop config, local patching may not take effect.
