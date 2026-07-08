# CCProxy Agent v0.3.1 Release Notes

## Summary

v0.3.1 fixes a Claude Desktop gateway authentication regression introduced by v0.3.

## Fixed

Claude Desktop sends its gateway credential to CCProxy Agent, but v0.3 did not preserve request headers when a request entered the AI orchestration layer. As a result, ccswitch could reject the request and Claude Desktop could show:

```text
Couldn't sign in to Gateway
The provider rejected your credentials.
```

v0.3.1 forwards the original non-hop request headers through all AI paths:

- normal request forwarding
- `max_tokens` reduction
- context-limit retry
- chunk execution
- synthesis request

## Validation

Added a regression test that requires:

```text
Authorization: Bearer desktop-token
```

The test now verifies that the header reaches the mock upstream after orchestration.

Commands verified:

```bash
npm run check
npm test
```
