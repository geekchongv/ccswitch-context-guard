# CCProxy Agent v0.4.1

## Highlights

- Automatically moves to the next available listen port when the configured proxy port is busy.
- Discovers a reachable local ccswitch upstream when the configured upstream is unavailable.
- Adds a built-in dashboard at the active proxy URL.
- Shows proxy status, upstream routing, process metadata, and recent runtime logs.
- Opens the dashboard on startup by default.
- Adds a Stop button that shuts down the local proxy and restores patched Claude settings.

## Notes

- The proxy now patches Claude CLI and Claude Desktop only after the HTTP server is listening.
- The default topology still starts at `127.0.0.1:15722`, but the actual proxy port can become `15723`, `15724`, and so on when needed.
- Set `ui.openOnStart` to `false` to keep the dashboard available without opening a browser automatically.
