import test from "node:test";
import assert from "node:assert/strict";

/**
 * LEV fork Phase 2: Unit tests for batch action and WebSocket capture
 * helpers in browserPool.ts.
 *
 * These tests cover the type shapes and the pure logic that does not
 * require a real browser. The browser-dependent paths
 * (startWebSocketCapture, executeBatchActions) are integration-tested
 * against live providers per LEV Hard Rule #7.
 */

import {
  type BatchAction,
  type BatchActionResult,
  type CapturedWebSocketFrame,
  type WebSocketCaptureSession,
} from "../../open-sse/services/browserPool.ts";

// ── BatchAction type shapes ────────────────────────────────────────────────

test("BatchAction click has selector and optional timeout", () => {
  const action: BatchAction = { type: "click", selector: "#submit", timeout: 3000 };
  assert.equal(action.type, "click");
  assert.equal(action.selector, "#submit");
  assert.equal(action.timeout, 3000);
});

test("BatchAction fill has selector and text", () => {
  const action: BatchAction = { type: "fill", selector: "#input", text: "hello" };
  assert.equal(action.type, "fill");
  assert.equal(action.text, "hello");
});

test("BatchAction type has selector, text, and optional delay", () => {
  const action: BatchAction = { type: "type", selector: "#input", text: "hello", delay: 10 };
  assert.equal(action.type, "type");
  assert.equal(action.delay, 10);
});

test("BatchAction evaluate has selector and fn string", () => {
  const action: BatchAction = { type: "evaluate", selector: "#input", fn: "el => el.value = 'x'" };
  assert.equal(action.type, "evaluate");
  assert.equal(typeof action.fn, "string");
});

test("BatchAction waitFor has selector, state, and timeout", () => {
  const action: BatchAction = {
    type: "waitFor",
    selector: "#input",
    state: "visible",
    timeout: 5000,
  };
  assert.equal(action.type, "waitFor");
  assert.equal(action.state, "visible");
});

test("BatchAction wait has ms", () => {
  const action: BatchAction = { type: "wait", ms: 1500 };
  assert.equal(action.type, "wait");
  assert.equal(action.ms, 1500);
});

test("BatchAction press has key", () => {
  const action: BatchAction = { type: "press", key: "Enter" };
  assert.equal(action.type, "press");
  assert.equal(action.key, "Enter");
});

// ── BatchActionResult type shape ───────────────────────────────────────────

test("BatchActionResult success has action and success=true", () => {
  const result: BatchActionResult = {
    action: { type: "click", selector: "#btn" },
    success: true,
  };
  assert.ok(result.success);
  assert.equal(result.error, undefined);
});

test("BatchActionResult failure has action, success=false, and error", () => {
  const result: BatchActionResult = {
    action: { type: "click", selector: "#btn" },
    success: false,
    error: "Timeout 5000ms exceeded",
  };
  assert.equal(result.success, false);
  assert.ok(result.error);
});

// ── CapturedWebSocketFrame type shape ──────────────────────────────────────

test("CapturedWebSocketFrame has direction, wsUrl, data, and timestamp", () => {
  const frame: CapturedWebSocketFrame = {
    direction: "received",
    wsUrl: "wss://example.com/ws",
    data: '{"type":"message"}',
    timestamp: Date.now(),
  };
  assert.equal(frame.direction, "received");
  assert.equal(frame.wsUrl, "wss://example.com/ws");
  assert.ok(frame.data.length > 0);
  assert.ok(frame.timestamp > 0);
});

test("CapturedWebSocketFrame can be 'sent' direction", () => {
  const frame: CapturedWebSocketFrame = {
    direction: "sent",
    wsUrl: "wss://example.com/ws",
    data: '{"type":"ping"}',
    timestamp: Date.now(),
  };
  assert.equal(frame.direction, "sent");
});

// ── WebSocketCaptureSession type shape ────────────────────────────────────

test("WebSocketCaptureSession has frames array and stop function", () => {
  const session: WebSocketCaptureSession = {
    frames: [],
    stop: async () => {},
  };
  assert.ok(Array.isArray(session.frames));
  assert.equal(typeof session.stop, "function");
});
