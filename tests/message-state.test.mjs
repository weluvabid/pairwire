import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionMessage,
  isTerminalStatus,
  transitionMessage,
  InvalidMessageTransitionError,
} from "../dist/core/message-state.js";

test("normal delivery transitions are accepted", () => {
  assert.equal(transitionMessage("pending", "sending"), "sending");
  assert.equal(transitionMessage("sending", "sent"), "sent");
  assert.equal(transitionMessage("sent", "delivered"), "delivered");
});

test("ambiguous attempts can be retried without changing message identity", () => {
  assert.equal(transitionMessage("sending", "pending"), "pending");
  assert.equal(transitionMessage("sent", "pending"), "pending");
  assert.equal(transitionMessage("failed", "pending"), "pending");
});

test("delivery is terminal and cannot be downgraded", () => {
  assert.equal(isTerminalStatus("delivered"), true);
  for (const target of ["pending", "sending", "sent", "failed"]) {
    assert.equal(canTransitionMessage("delivered", target), false);
    assert.throws(() => transitionMessage("delivered", target), InvalidMessageTransitionError);
  }
});

test("state transitions reject skipped stages but permit retries", () => {
  assert.equal(canTransitionMessage("pending", "sent"), false);
  assert.equal(canTransitionMessage("sending", "pending"), true);
  assert.equal(canTransitionMessage("failed", "sending"), true);
});
