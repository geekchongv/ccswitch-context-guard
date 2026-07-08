# Security Policy

## Supported Versions

Only the latest release is actively maintained.

## Reporting A Vulnerability

Please open a private security advisory on GitHub if possible.

If that is not available, open an issue with minimal reproduction details and avoid sharing API keys, prompts, logs, or local configuration files.

## Privacy Notes

CCProxy Agent is a local proxy. It can observe request and response bodies that pass through it.

Do not publish:

- `config.json`
- `logs/`
- `runtime/`
- packaged personal builds
- Claude settings files
- provider tokens or API keys
