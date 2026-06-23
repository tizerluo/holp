import { describe, it, expect } from "vitest";
import { ConnectionContext } from "../core/context.js";
import { Dispatcher } from "../core/dispatcher.js";
import { handleInitialize, SERVER_PROTOCOL_VERSION } from "./initialize.js";
import { HOLP_ERROR_CODES, JSONRPC_INVALID_REQUEST } from "../core/errors.js";
import type { JsonRpcErrorResponse, JsonRpcSuccessResponse } from "../runtime/jsonrpc.js";

function newDispatcher() {
  const ctx = new ConnectionContext();
  const d = new Dispatcher(ctx).register("initialize", handleInitialize);
  return { ctx, d };
}

function initReq(params: unknown) {
  return { jsonrpc: "2.0" as const, id: 1, method: "initialize", params };
}

describe("initialize: capability negotiation (spec §2)", () => {
  it("normal negotiation returns the correct intersection + persists state", async () => {
    const { ctx, d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "cmux", version: "0.64.16" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: {
          consensus: { supported: true },
          approval: { supported: true, kinds: ["merge_approval"] },
          unattended_loop: { supported: true, required: true },
          artifact_refs: { supported: true },
          gate_report: { supported: true },
          dynamic_workflow: { supported: true },
        },
      }),
    )) as JsonRpcSuccessResponse;

    const result = res.result as {
      server: { name: string };
      protocol_version: string;
      capabilities: Record<string, { supported: boolean; kinds?: string[] }>;
    };

    expect(result.server.name).toBe("holp-reference-daemon");
    expect(result.protocol_version).toBe(SERVER_PROTOCOL_VERSION);
    // effective = client.supported && server.supported
    expect(result.capabilities.consensus.supported).toBe(true);
    expect(result.capabilities.unattended_loop.supported).toBe(true);
    expect(result.capabilities.artifact_refs.supported).toBe(true);
    expect(result.capabilities.gate_report.supported).toBe(true);
    expect(result.capabilities.dynamic_workflow.supported).toBe(true);
    // approval.kinds intersection: client ["merge_approval"] ∩ server full set
    expect(result.capabilities.approval.supported).toBe(true);
    expect(result.capabilities.approval.kinds).toEqual(["merge_approval"]);
    // state persisted on the connection
    expect(ctx.initialized?.clientName).toBe("cmux");
    expect(ctx.initialized?.negotiated.consensus.supported).toBe(true);
    expect(ctx.initialized?.negotiated.gate_report.supported).toBe(true);
    expect(ctx.initialized?.negotiated.dynamic_workflow.supported).toBe(true);
  });

  it("absent client capability negotiates to supported:false (intersection)", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "minimal", version: "1.0" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: { consensus: { supported: true } },
      }),
    )) as JsonRpcSuccessResponse;
    const caps = (res.result as { capabilities: Record<string, { supported: boolean }> }).capabilities;
    expect(caps.consensus.supported).toBe(true);
    // approval/unattended_loop/artifact_refs/gate_report/dynamic_workflow absent on client → false
    expect(caps.approval.supported).toBe(false);
    expect(caps.unattended_loop.supported).toBe(false);
    expect(caps.artifact_refs.supported).toBe(false);
    expect(caps.gate_report.supported).toBe(false);
    expect(caps.dynamic_workflow.supported).toBe(false);
  });

  it("client requires a capability the server does not support → capability_required_but_unsupported", async () => {
    // The server self-report supports all four caps, so the cleanest end-to-end
    // way to drive the connection-level required-but-unsupported rejection is a
    // required approval whose kinds are disjoint from the server's set (empty
    // intersection while required:true). The symmetric server-required-vs-client
    // -unsupported branch is covered as a pure unit in capabilities.test.ts.
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: {
          approval: { supported: true, required: true, kinds: ["nonexistent_kind"] },
        },
      }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.capability_required_but_unsupported);
  });

  it("client marking a server-supported cap as required still succeeds (no false reject)", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: { consensus: { supported: true, required: true } },
      }),
    )) as JsonRpcSuccessResponse;
    expect(res.result).toBeDefined();
    expect((res as unknown as JsonRpcErrorResponse).error).toBeUndefined();
  });

  it("major protocol version mismatch → protocol_version_mismatch", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: "1.0.0", // major 1 vs server major 0
        capabilities: {},
      }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.protocol_version_mismatch);
  });

  it("same major.minor, different draft segment → accepted (compat = MAJOR.MINOR, §9)", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: "0.1.3", // same major.minor (0.1) as server
        capabilities: {},
      }),
    )) as JsonRpcSuccessResponse;
    expect(res.result).toBeDefined();
  });

  it("approval required by client with empty kinds intersection → reject", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: {
          // required approval, kinds disjoint from server's set → empty intersection
          approval: { supported: true, required: true, kinds: ["unknown_approval_kind"] },
        },
      }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.capability_required_but_unsupported);
  });

  it("approval NOT required with empty kinds intersection → does NOT reject connection", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: SERVER_PROTOCOL_VERSION,
        capabilities: {
          approval: { supported: true, kinds: ["unknown_approval_kind"] }, // not required
        },
      }),
    )) as JsonRpcSuccessResponse;
    const caps = (res.result as { capabilities: Record<string, { kinds?: string[] }> }).capabilities;
    expect(caps.approval.kinds).toEqual([]); // empty intersection, connection still up
  });
});

describe("initialize: malformed params → -32600 invalid_request (spec §10.1)", () => {
  it("params not an object → -32600", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(initReq("not-an-object"))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
    expect(res.error.code).not.toBe(HOLP_ERROR_CODES.internal_error);
  });

  it("empty params {} (missing client) → -32600", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(initReq({}))) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
  });

  it("missing protocol_version → -32600", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({ client: { name: "x", version: "1.0" } }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(JSONRPC_INVALID_REQUEST);
  });
});

describe("initialize: protocol version compat = MAJOR.MINOR (spec §9)", () => {
  it("same major.minor, different draft segment (0.1.9) → accepted", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: "0.1.9", // 0.1 == server 0.1
        capabilities: {},
      }),
    )) as JsonRpcSuccessResponse;
    expect(res.result).toBeDefined();
    expect((res as unknown as JsonRpcErrorResponse).error).toBeUndefined();
  });

  it("different minor (0.2.0) → protocol_version_mismatch", async () => {
    const { d } = newDispatcher();
    const res = (await d.dispatch(
      initReq({
        client: { name: "x", version: "1.0" },
        protocol_version: "0.2.0", // 0.2 != server 0.1
        capabilities: {},
      }),
    )) as JsonRpcErrorResponse;
    expect(res.error.code).toBe(HOLP_ERROR_CODES.protocol_version_mismatch);
  });
});
