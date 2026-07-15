# CCProxy Agent v0.4.97

This release adds macOS distribution, user-managed multimodal credentials, and adaptive protection against local-gateway HTTP 429 responses.

## Highlights

- Downloadable macOS DMG and ZIP packages for Apple Silicon (`arm64`) and Intel (`x64`).
- Vision Base URL, path, model list, limits, prompt, and API key are configurable from the desktop UI.
- Vision API keys are encrypted with the operating system's credential service and are never included in renderer state, logs, source control, or release packages.
- Local gateway 429 responses trigger a shared cooldown, respect `Retry-After`, lower future traffic to one concurrent request, and perform one serialized retry inside the proxy.
- Rate-limit cooldown and recovery appear in the protection-event timeline.

## macOS installation

Choose `arm64` for Apple Silicon or `x64` for Intel Macs. This initial macOS release is unsigned; if Gatekeeper blocks the first launch, Control-click CCProxy Agent and choose **Open**. Configuration and encrypted secrets live in the macOS user-data directory rather than inside the application bundle.

## Security

Release automation scans Windows and macOS output directories for private `config.json` files and configured secret sentinels. A combined `SHA256SUMS.txt` covers all published binaries.
