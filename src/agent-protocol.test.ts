import test from "node:test";
import assert from "node:assert/strict";
import { hasAgentToolProtocol } from "./agent-protocol.js";

test("detects declared tools and Anthropic tool message parts", () => {
  assert.equal(hasAgentToolProtocol({
    tools: [{ name: "Read" }],
    messages: [{ role: "user", content: "read a file" }],
  }), true);

  assert.equal(hasAgentToolProtocol({
    messages: [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }],
    }],
  }), true);
});

test("does not classify a stateless text request as an Agent tool session", () => {
  assert.equal(hasAgentToolProtocol({
    messages: [{ role: "user", content: "summarize this document" }],
  }), false);
});
