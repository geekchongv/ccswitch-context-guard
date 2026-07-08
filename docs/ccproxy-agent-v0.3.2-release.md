# CCProxy Agent v0.3.2 Release Notes

## Summary

v0.3.2 fixes Claude Desktop gateway probe failures where Desktop reported:

```text
Gateway returned HTTP 500
responseBody: {"error":"ccproxy-agent internal error"}
```

## Fixed

v0.3.1 preserved authentication headers correctly, but still forwarded hop-by-hop HTTP headers such as:

- `connection`
- `keep-alive`
- `transfer-encoding`
- `upgrade`
- `te`
- `trailer`

Those headers belong to a single client/proxy connection and should not be forwarded into the new upstream fetch call. In some Desktop probe requests, this could make the underlying fetch fail before ccswitch received the request.

v0.3.2 filters these headers while preserving useful headers such as:

- `Authorization`
- `x-api-key`
- `anthropic-version`
- `content-type`

## Validation

Commands verified:

```bash
npm run check
npm test
```

Regression coverage:

- Desktop gateway authorization headers are preserved.
- Desktop-style requests carrying connection headers no longer produce an internal proxy failure.
