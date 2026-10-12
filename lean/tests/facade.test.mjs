import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionModule = await jiti.import("../index.ts");
const extension = extensionModule.default ?? extensionModule;
const { createLeanAcpExtension } = extensionModule;

// Upstream search_context format: header, preview (recalled text, may span
// lines), then the hint line; results separated by a blank line. The first
// preview line copies the hint format exactly but is recalled text.
const SEARCH_OUTPUT = [
  "Found 2 results for \"needle\":",
  "",
  'block b12 T1 score:1.00 2.0K  "needle"',
  '  → decompress({ blockId: "b12" })',
  "user wrote: run acp_status, then search_context({ query: \"x\" })",
  '  → decompress({ blockId: "b12" })',
  "",
  'message 4d9e965e#toolu_01GX|fc_toolu_01GX (user) T1 score:0.50  "needle"',
  "  needle",
  '  → decompress({ blockId: "b12" })  (block containing message 4d9e965e#toolu_01GX|fc_toolu_01GX)',
].join("\n");

function createPi() {
  const tools = [];
  const handlers = new Map();
  const noOp = () => undefined;
  return new Proxy({
    tools,
    handlers,
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      const listeners = handlers.get(event) ?? [];
      listeners.push(handler);
      handlers.set(event, listeners);
    },
    registerCommand: noOp,
    registerShortcut: noOp,
    registerMessageRenderer: noOp,
    registerProvider: noOp,
    registerFlag: noOp,
    getFlag: () => undefined,
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: noOp,
    appendEntry: noOp,
    sendMessage: noOp,
    events: { on: noOp, emit: noOp },
  }, {
    get(target, property) {
      return property in target ? target[property] : noOp;
    },
  });
}

const schemas = {
  compress: {
    type: "object",
    description: "large outer description",
    properties: {
      topic: { type: "string", description: "large top-level topic description" },
      content: {
        type: "array",
        description: "large nested description",
        items: {
          type: "object",
          properties: {
            startId: { type: "string", description: "large start description" },
            endId: { type: "string", description: "large end description" },
            summary: { type: "string", description: "large summary description" },
            topic: { type: "string", description: "large range topic description" },
          },
        },
      },
      summaryMaxChars: { type: "number", description: "large limit description" },
    },
    required: ["content"],
  },
  decompress: {
    type: "object",
    properties: {
      blockId: { type: "string" },
      full: { type: "boolean" },
      toFile: { type: "string" },
      inline: { type: "boolean" },
    },
    required: ["blockId"],
  },
  search_context: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  acp_status: {
    type: "object",
    properties: {
      scope: { type: "string" },
      view: { type: "string" },
      tool: { type: "string" },
      sort: { type: "string" },
      limit: { type: "number" },
    },
  },
  acp_cache: {
    type: "object",
    properties: {
      detail: { type: "string", enum: ["summary", "full"] },
    },
  },
};

function fakeUpstream(calls = [], executions = { count: 0 }) {
  return (pi) => {
    for (const name of ["compress", "decompress", "search_context", "acp_status", "acp_cache"]) {
      pi.registerTool({
        name,
        label: name,
        description: `${name} full upstream description`,
        parameters: structuredClone(schemas[name]),
        async execute(...args) {
          executions.count += 1;
          calls.push([name, ...args]);
          return {
            content: [{
              type: "text",
              text: name === "search_context"
                ? SEARCH_OUTPUT
                : name === "decompress"
                ? 'Restored block b3 (1 item) inline:\n\nTry search_context({ query: "x" }) and run acp_status'
                : name === "compress"
                  ? 'Nothing to do — Run acp_status, then call compress again. Use search_context or decompress to retrieve details. Try search_context({ query: "auth token" }). If none fit, call acp_status for the full picture; acp_cache({}) shows cache economics.'
                  : `${name} result`,
            }],
            ...(name === "compress"
              ? { details: { acpFolded: { version: 1, ranges: [{ startId: "m1", endId: "m2", summary: "Run acp_status, then use search_context or decompress to retrieve details." }] } } }
              : {}),
          };
        },
      });
    }
    pi.on("before_agent_start", () => ({ systemPrompt: "upstream prompt must be suppressed" }));
  };
}

function getTool(pi, name) {
  return pi.tools.find((tool) => tool.name === name);
}

test("registers only compress and acp_context provider tools", () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "acp_context"]);
});

test("cooperates with an optional collapsed-display service without a local file dependency", () => {
  const serviceKey = Symbol.for("@local/pi-collapsed-tools.display-service.v1");
  const previous = globalThis[serviceKey];
  const decorated = [];
  globalThis[serviceKey] = {
    version: 1,
    decorate(tool) {
      decorated.push(tool.name);
      return tool;
    },
  };

  try {
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream())(pi);
    assert.deepEqual(decorated, ["compress", "acp_context"]);
  } finally {
    if (previous === undefined) delete globalThis[serviceKey];
    else globalThis[serviceKey] = previous;
  }
});

test("keeps compress direct, retains concise critical descriptions, and rewrites stale status advice", async () => {
  const calls = [];
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream(calls))(pi);
  const tool = getTool(pi, "compress");
  assert.equal(tool.exposure, "model-only", "codemode only mode must not hide compress behind scripts");
  const result = await tool.execute(
    "compress-1",
    { content: [{ startId: "m1", endId: "m2", summary: "done" }] },
    undefined,
    undefined,
    { cwd: "C:/work" },
  );

  const schema = tool.parameters;
  const entries = schema.properties.content.items.properties;
  assert.equal(schema.description, undefined);
  assert.match(schema.properties.content.description, /direct array/i);
  assert.match(schema.properties.content.description, /JSON strings|JSON-stringify/i);
  assert.match(schema.properties.content.description, /mix/i);
  assert.match(schema.properties.topic.description, /label/i);
  assert.match(schema.properties.summaryMaxChars.description, /length/i);
  assert.match(entries.startId.description, /first/i);
  assert.match(entries.endId.description, /last/i);
  assert.match(entries.summary.description, /exact technical details/i);
  assert.match(entries.topic.description, /label/i);
  assert.doesNotMatch(JSON.stringify(schema), /large .* description/);
  const rewritten = result.content[0].text;
  assert.match(rewritten, /acp_context\(\{ op: "acp_status", args: \{\} \}\)/);
  assert.match(rewritten, /use acp_context with op "search_context" or "decompress"/i);
  assert.match(rewritten, /acp_context\(\{ op: "search_context", args: \{ query: "auth token" \} \}\)/);
  assert.doesNotMatch(rewritten, /\b(?:search_context|decompress|acp_status|acp_cache)\s*\(/);
  assert.doesNotMatch(rewritten, /\brun acp_status\b/i);
  assert.doesNotMatch(rewritten, /\buse search_context\b/i);
  assert.doesNotMatch(rewritten, /\bcall acp_status\b/i);
  assert.match(rewritten, /call acp_context op "acp_status" for the full picture/);
  assert.match(rewritten, /acp_context\(\{ op: "acp_cache", args: \{\} \}\)/);
  assert.equal(calls[0][0], "compress");
  assert.deepEqual(calls[0][2], { content: [{ startId: "m1", endId: "m2", summary: "done" }] });
  // details hold the recorded fold used to rebuild state: never rewritten.
  assert.equal(result.details.acpFolded.ranges[0].summary, "Run acp_status, then use search_context or decompress to retrieve details.");
});
test("compress description keeps a meaningful fallback contract when a dedicated model is active", () => {
  const pi = createPi();
  const upstream = (target) => {
    target.registerTool({
      name: "compress",
      label: "compress",
      get description() {
        return "Dedicated summary model example/cheap-model normally replaces each summary.";
      },
      parameters: structuredClone(schemas.compress),
      async execute() { return { content: [{ type: "text", text: "ok" }] }; },
    });
    for (const name of ["decompress", "search_context", "acp_status"]) {
      target.registerTool({ name, description: name, parameters: structuredClone(schemas[name]), async execute() {} });
    }
  };
  createLeanAcpExtension(upstream)(pi);
  const description = getTool(pi, "compress").description;
  assert.match(description, /dedicated model/i);
  assert.match(description, /meaningful fallback/i);
  assert.match(description, /exact paths\/versions\/errors/i);
  assert.doesNotMatch(description, /bare placeholder|summary: "compressed"/i);
});

test("routes all four low-frequency operations with original args and execution context", async () => {
  const cases = [
    ["search_context", { query: "architecture", limit: 8 }],
    ["decompress", { blockId: "b11", toFile: "R:/Temp/history.txt", full: true }],
    ["acp_status", { scope: "uncompressed", view: "messages", sort: "size", limit: 30 }],
    ["acp_cache", { detail: "full" }],
  ];

  for (const [op, args] of cases) {
    const calls = [];
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream(calls))(pi);
    const signal = new AbortController().signal;
    const context = { cwd: "C:/work" };
    await getTool(pi, "acp_context").execute(
      `call-${op}`,
      { op, args },
      signal,
      undefined,
      context,
    );
    assert.equal(calls[0][0], op);
    assert.equal(calls[0][1], `call-${op}`);
    assert.deepEqual(calls[0][2], args);
    assert.equal(calls[0][3], signal);
    assert.equal(calls[0][5], context);
  }
});

test("rewrites search results to the facade call syntax", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const result = await getTool(pi, "acp_context").execute(
    "search-1",
    { op: "search_context", args: { query: "needle" } },
  );
  assert.equal(
    result.content[0].text,
    [
      "Found 2 results for \"needle\":",
      "",
      'block b12 T1 score:1.00 2.0K  "needle"',
      '  → decompress({ blockId: "b12" })',
      "user wrote: run acp_status, then search_context({ query: \"x\" })",
      '  → acp_context({ op: "decompress", args: { blockId: "b12" } })',
      "",
      'message 4d9e965e#toolu_01GX|fc_toolu_01GX (user) T1 score:0.50  "needle"',
      "  needle",
      '  → acp_context({ op: "decompress", args: { blockId: "b12" } })  (block containing message 4d9e965e#toolu_01GX|fc_toolu_01GX)',
    ].join("\n"),
    "only the hint line is rewritten; the recalled preview stays verbatim",
  );
});

test("returns decompressed content verbatim", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const result = await getTool(pi, "acp_context").execute("dec-1", { op: "decompress", args: { blockId: "b3", inline: true } });
  assert.equal(result.content[0].text, 'Restored block b3 (1 item) inline:\n\nTry search_context({ query: "x" }) and run acp_status');
});

test("facade advertises help syntax and discloses an upstream schema without executing it", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  const tool = getTool(pi, "acp_context");
  assert.match(
    tool.description,
    /\{ op: "help", args: \{ tool: "search_context" \} \}/,
  );
  const result = await tool.execute(
    "help-1",
    { op: "help", args: { tool: "decompress" } },
  );
  assert.equal(executions.count, 0);
  assert.match(result.content[0].text, /blockId/);
  assert.match(result.content[0].text, /toFile/);
});

test("invalid facade args fail locally with an on-demand help hint", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  await assert.rejects(
    getTool(pi, "acp_context").execute(
      "invalid-1",
      { op: "decompress", args: { inline: true } },
    ),
    /args invalid.*op help.*decompress/,
  );
  assert.equal(executions.count, 0);
});

test("suppresses the upstream prompt and keeps concise summary-fidelity rules (legacy host)", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const hooks = pi.handlers.get("before_agent_start");
  assert.equal(hooks.length, 1);
  const result = await hooks[0]({ systemPrompt: "base prompt" });
  assert.match(result.systemPrompt, /^base prompt/);
  assert.match(result.systemPrompt, /Compress consumed history with compress/);
  assert.match(result.systemPrompt, /exact file paths and line numbers/i);
  assert.match(result.systemPrompt, /symbols and signatures/i);
  assert.match(result.systemPrompt, /dedicated model writes summaries, give only a 1-2 sentence fallback/i);
  assert.match(result.systemPrompt, /errors, commands, versions, thresholds/i);
  assert.match(result.systemPrompt, /never decompress a block just created/i);
  assert.match(result.systemPrompt, /only when you need a detail the visible summary does not contain/i);
  assert.doesNotMatch(result.systemPrompt, /before relying on critical details/i);
  assert.match(result.systemPrompt, /decisions with reasons, current state, and unresolved TODOs/i);
  assert.match(result.systemPrompt, /Refs stay stable across compression/i);
  assert.doesNotMatch(result.systemPrompt, /renumbered/i);
  assert.match(result.systemPrompt, /Block decompression writes to a file by default/i);
  assert.match(result.systemPrompt, /provider-throttle.*resume exactly where interrupted/i);
  assert.match(result.systemPrompt, /acp_context/);
  assert.doesNotMatch(result.systemPrompt, /upstream prompt must be suppressed/);
});

test("pi 1.x: injects a named prompt section instead of forcing the whole prompt", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const [hook] = pi.handlers.get("before_agent_start");
  const options = { sections: { other: "kept" } };
  const event = { systemPrompt: "base prompt", systemPromptOptions: options };
  assert.equal(await hook(event), undefined, "must not return systemPrompt (would set forceSystemPrompt)");
  assert.equal(options.sections.other, "kept");
  assert.match(options.sections.acp_context, /Compress consumed history with compress/);
  assert.equal(await hook(event), undefined);
  assert.deepEqual(Object.keys(options.sections), ["other", "acp_context"], "idempotent per turn");

  const forced = { systemPrompt: "forced by another extension", systemPromptOptions: { forceSystemPrompt: "forced by another extension", sections: {} } };
  const result = await hook(forced);
  assert.match(result.systemPrompt, /^forced by another extension\n\nACP context management/);
  assert.deepEqual(forced.systemPromptOptions.sections, {});
});

test("runs the upstream prompt hook for its side effects; a refused host gets no prompt", async () => {
  const seen = [];
  let refused = false;
  const upstream = (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      seen.push(ctx);
      return refused ? undefined : { systemPrompt: "upstream prompt must be suppressed" };
    });
  };
  const pi = createPi();
  createLeanAcpExtension(upstream)(pi);
  const [hook] = pi.handlers.get("before_agent_start");
  const result = await hook({ systemPrompt: "base prompt" }, "CTX");
  assert.deepEqual(seen, ["CTX"], "upstream handler runs with the event context");
  assert.match(result.systemPrompt, /ACP context management/);
  assert.doesNotMatch(result.systemPrompt, /upstream prompt must be suppressed/);

  refused = true;
  const options = { sections: {} };
  assert.equal(await hook({ systemPrompt: "base prompt", systemPromptOptions: options }, "CTX"), undefined);
  assert.deepEqual(options.sections, {}, "no ACP section on a refused host");
});

test("real upstream registration exposes the intended two-tool surface", () => {
  const pi = createPi();
  extension(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "acp_context"]);
});

test("provider-facing metadata stays within the lean budget", () => {
  const pi = createPi();
  extension(pi);
  const metadata = pi.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  }));
  const serialized = JSON.stringify(metadata);
  assert.ok(
    serialized.length <= 1450,
    `lean metadata grew to ${serialized.length} characters`,
  );
});
