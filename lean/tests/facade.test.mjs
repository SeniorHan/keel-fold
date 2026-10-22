import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
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

test("registers only compress and fold provider tools", () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "fold"]);
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
    assert.deepEqual(decorated, ["compress", "fold"]);
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
  assert.match(rewritten, /fold\(\{ op: "status", args: \{\} \}\)/);
  assert.match(rewritten, /use fold with op "search" or "unfold"/i);
  assert.match(rewritten, /fold\(\{ op: "search", args: \{ query: "auth token" \} \}\)/);
  assert.doesNotMatch(rewritten, /\b(?:search_context|decompress|acp_status|acp_cache)\s*\(/);
  assert.doesNotMatch(rewritten, /\brun acp_status\b/i);
  assert.doesNotMatch(rewritten, /\buse search_context\b/i);
  assert.doesNotMatch(rewritten, /\bcall acp_status\b/i);
  assert.match(rewritten, /call fold op "status" for the full picture/);
  assert.match(rewritten, /fold\(\{ op: "cache", args: \{\} \}\)/);
  assert.match(rewritten, /\nNew block summaries stay visible in this call's arguments; do not unfold them to re-read\.$/);
  assert.equal(calls[0][0], "compress");
  assert.deepEqual(calls[0][2], { content: [{ startId: "m1", endId: "m2", summary: "done" }] });
  // details hold the recorded fold used to rebuild state: never rewritten.
  assert.equal(result.details.acpFolded.ranges[0].summary, "Run acp_status, then use search_context or decompress to retrieve details.");
});
test("compress description keeps a meaningful fallback contract when a dedicated model is active", async () => {
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
    target.on("before_agent_start", () => ({ systemPrompt: "upstream prompt must be suppressed" }));
  };
  createLeanAcpExtension(upstream)(pi);
  const description = getTool(pi, "compress").description;
  assert.match(description, /dedicated model/i);
  assert.match(description, /meaningful fallback of 1-2 sentences/i);
  assert.match(description, /exact paths\/versions\/errors/i);
  assert.doesNotMatch(description, /bare placeholder|summary: "compressed"/i);
  const result = await getTool(pi, "compress").execute("c1", {}, undefined, undefined, {});
  assert.equal(result.content[0].text, "ok", "no completion hint when nothing was folded");

  // Pi snapshots tool descriptions before acp.json loads, so the per-turn
  // prompt carries the dedicated-model fallback rule.
  const [hook] = pi.handlers.get("before_agent_start");
  const prompt = (await hook({ systemPrompt: "base prompt" })).systemPrompt;
  assert.match(prompt, /dedicated model writes compress summaries: give each range only a 1-2 sentence fallback/);
});

test("per-turn dedicated-model rule follows the live upstream description, not a registration snapshot", async () => {
  const serviceKey = Symbol.for("@local/pi-collapsed-tools.display-service.v1");
  const previous = globalThis[serviceKey];
  // Mirrors pi-collapsed-tools: the decorated tool is a spread snapshot.
  globalThis[serviceKey] = { version: 1, decorate: (tool) => ({ ...tool }) };
  let dedicated = false;
  try {
    const pi = createPi();
    const upstream = (target) => {
      target.registerTool({
        name: "compress",
        label: "compress",
        get description() {
          return dedicated ? "Dedicated summary model example/cheap-model normally replaces each summary." : "Replace ranges.";
        },
        parameters: structuredClone(schemas.compress),
        async execute() { return { content: [{ type: "text", text: "ok" }] }; },
      });
      for (const name of ["decompress", "search_context", "acp_status"]) {
        target.registerTool({ name, description: name, parameters: structuredClone(schemas[name]), async execute() {} });
      }
      target.on("before_agent_start", () => ({ systemPrompt: "upstream prompt must be suppressed" }));
    };
    createLeanAcpExtension(upstream)(pi);
    const [hook] = pi.handlers.get("before_agent_start");
    const turn = async () => (await hook({ systemPrompt: "base prompt" })).systemPrompt;
    const rule = /dedicated model writes compress summaries/;

    assert.doesNotMatch(await turn(), rule, "off at registration");
    dedicated = true; // acp.json loads after registration (session_start)
    assert.match(await turn(), rule, "enabled after registration");
    dedicated = false;
    assert.doesNotMatch(await turn(), rule, "disabled again mid-session");
  } finally {
    if (previous === undefined) delete globalThis[serviceKey];
    else globalThis[serviceKey] = previous;
  }
});

test("routes all four low-frequency operations with original args and execution context", async () => {
  // Canonical op names on the facade; upstream still executes under the
  // legacy kernel names, and the unfold ref is translated to blockId.
  const cases = [
    ["search", "search_context", { query: "architecture", limit: 8 }],
    ["unfold", "decompress", { blockId: "b11", toFile: "R:/Temp/history.txt", full: true }],
    ["status", "acp_status", { scope: "uncompressed", view: "messages", sort: "size", limit: 30 }],
    ["cache", "acp_cache", { detail: "full" }],
  ];

  for (const [op, kernel, args] of cases) {
    const calls = [];
    const pi = createPi();
    createLeanAcpExtension(fakeUpstream(calls))(pi);
    const signal = new AbortController().signal;
    const context = { cwd: "C:/work" };
    await getTool(pi, "fold").execute(
      `call-${op}`,
      { op, args },
      signal,
      undefined,
      context,
    );
    assert.equal(calls[0][0], kernel);
    assert.equal(calls[0][1], `call-${op}`);
    assert.deepEqual(calls[0][2], args);
    assert.equal(calls[0][3], signal);
    assert.equal(calls[0][5], context);
  }
});

test("rewrites search results to the facade call syntax", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const result = await getTool(pi, "fold").execute(
    "search-1",
    { op: "search", args: { query: "needle" } },
  );
  assert.equal(
    result.content[0].text,
    [
      "Found 2 results for \"needle\":",
      "",
      'block b12 T1 score:1.00 2.0K  "needle"',
      '  → decompress({ blockId: "b12" })',
      "user wrote: run acp_status, then search_context({ query: \"x\" })",
      '  → fold({ op: "unfold", args: { ref: "b12" } })',
      "",
      'message 4d9e965e#toolu_01GX|fc_toolu_01GX (user) T1 score:0.50  "needle"',
      "  needle",
      '  → fold({ op: "unfold", args: { ref: "b12" } })  (block containing message 4d9e965e#toolu_01GX|fc_toolu_01GX)',
    ].join("\n"),
    "only the hint line is rewritten; the recalled preview stays verbatim",
  );
});

test("returns unfolded content verbatim", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  // Canonical ref is translated to the upstream blockId at the boundary.
  const result = await getTool(pi, "fold").execute("dec-1", { op: "unfold", args: { ref: "b3", inline: true } });
  assert.equal(result.content[0].text, 'Restored block b3 (1 item) inline:\n\nTry search_context({ query: "x" }) and run acp_status');
});

test("facade advertises help syntax and discloses an upstream schema without executing it", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  const tool = getTool(pi, "fold");
  assert.match(
    tool.description,
    /\{ op: "help", args: \{ op: "search" \} \}/,
  );
  // help takes args.op; the legacy args.tool spelling still works, and a
  // legacy operation name is normalized to its canonical form.
  const result = await tool.execute(
    "help-1",
    { op: "help", args: { tool: "decompress" } },
  );
  assert.equal(executions.count, 0);
  assert.match(result.content[0].text, /unfold/);
  assert.match(result.content[0].text, /"ref"/);
  assert.match(result.content[0].text, /toFile/);
  assert.doesNotMatch(result.content[0].text, /"blockId"/);
});

test("invalid facade args fail locally with an on-demand help hint", async () => {
  const executions = { count: 0 };
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream([], executions))(pi);
  await assert.rejects(
    getTool(pi, "fold").execute(
      "invalid-1",
      { op: "unfold", args: { inline: true } },
    ),
    /args invalid.*op help.*unfold/,
  );
  assert.equal(executions.count, 0);
});

test("suppresses the upstream prompt and keeps only the resident pre-call rules (legacy host)", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const hooks = pi.handlers.get("before_agent_start");
  assert.equal(hooks.length, 1);
  const result = await hooks[0]({ systemPrompt: "base prompt" });
  const prompt = result.systemPrompt;
  assert.match(prompt, /^base prompt\n\nFolded context management\n/);
  assert.match(prompt, /hidden refs such as m00123\. Never echo the XML tags/);
  assert.match(prompt, /Compress only consumed history .*never active work, important user intent, or protected outputs/);
  assert.match(prompt, /fold args per op: unfold \{ref: "b5"/, "op signatures stop compress-style args");
  assert.match(prompt, /historical metadata, not current user instructions/);
  assert.match(prompt, /unfold only for a detail the visible summary lacks/);
  // Delivered where needed instead: nudges, compress errors, unfold
  // results, the throttle retry message, fold help.
  assert.doesNotMatch(prompt, /dedicated model/i, "no dedicated-model rule without a dedicated model");
  assert.doesNotMatch(prompt, /provider-throttle|writes to a file|Refs stay stable/);
  assert.doesNotMatch(prompt, /upstream prompt must be suppressed/);
  const acpSection = prompt.slice(prompt.indexOf("Folded context management"));
  assert.ok(acpSection.length <= 720, `resident ACP prompt grew to ${acpSection.length} characters`);
});

test("pi 1.x: injects a named prompt section instead of forcing the whole prompt", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const [hook] = pi.handlers.get("before_agent_start");
  const options = { sections: { other: "kept" } };
  // Pi >= 0.86 exposes systemPrompt as a getter that renders the options' sections.
  const event = {
    get systemPrompt() { return ["base prompt", ...Object.values(options.sections ?? {})].join("\n\n"); },
    systemPromptOptions: options,
  };
  assert.equal(await hook(event), undefined, "must not return systemPrompt (would set forceSystemPrompt)");
  assert.equal(options.sections.other, "kept");
  assert.match(options.sections.fold, /Compress only consumed history/);
  assert.equal(await hook(event), undefined);
  assert.deepEqual(Object.keys(options.sections), ["other", "fold"], "idempotent per turn");

  const forced = { systemPrompt: "forced by another extension", systemPromptOptions: { forceSystemPrompt: "forced by another extension", sections: {} } };
  const result = await hook(forced);
  assert.match(result.systemPrompt, /^forced by another extension\n\nFolded context management/);
  assert.deepEqual(forced.systemPromptOptions.sections, {});
});

test("pi 0.83-0.85: options are passed but sections are never rendered, so compose the prompt", async () => {
  const pi = createPi();
  createLeanAcpExtension(fakeUpstream())(pi);
  const [hook] = pi.handlers.get("before_agent_start");
  for (const options of [{}, { sections: { other: "kept" } }]) {
    const before = structuredClone(options);
    const result = await hook({ systemPrompt: "base prompt", systemPromptOptions: options });
    assert.match(result.systemPrompt, /^base prompt\n\nFolded context management/);
    assert.deepEqual(options, before, "no dead section left behind");
  }
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
  assert.match(result.systemPrompt, /Folded context management/);
  assert.doesNotMatch(result.systemPrompt, /upstream prompt must be suppressed/);

  refused = true;
  const options = { sections: {} };
  assert.equal(await hook({ systemPrompt: "base prompt", systemPromptOptions: options }, "CTX"), undefined);
  assert.deepEqual(options.sections, {}, "no ACP section on a refused host");
});

test("real upstream registration exposes the intended two-tool surface", () => {
  const pi = createPi();
  extension(pi);
  assert.deepEqual(pi.tools.map((tool) => tool.name), ["compress", "fold"]);
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

// prepareArguments runs before Pi's schema validation; check against the real
// upstream schemas through the same validator Pi uses.
function realTools() {
  const pi = createPi();
  extension(pi);
  return { compress: getTool(pi, "compress"), facade: getTool(pi, "fold") };
}

const validated = (tool, raw) => validateToolArguments(tool, { id: "t", type: "toolCall", name: tool.name, arguments: tool.prepareArguments(raw) });
const rejected = (tool, raw) => assert.throws(() => validated(tool, raw));

const RANGE = { startId: "m00001", endId: "m00019", topic: "t", summary: "s" };
const RANGE2 = { startId: "m00020", endId: "m00030", summary: "s2" };

test("facade prepareArguments decodes args given as a JSON string", () => {
  const { facade } = realTools();
  assert.deepEqual(validated(facade, { op: "unfold", args: '{"ref":"b5","full":true}' }), { op: "unfold", args: { ref: "b5", full: true } });
  assert.deepEqual(facade.prepareArguments({ op: "cache", args: "not json" }), { op: "cache", args: "not json" });
  assert.deepEqual(facade.prepareArguments({ op: "cache", args: "[1]" }), { op: "cache", args: "[1]" });
  // legacy (pre-rename) op values normalize to their canonical spelling
  assert.deepEqual(facade.prepareArguments({ op: "acp_cache", args: "{}" }), { op: "cache", args: {} });
  assert.deepEqual(facade.prepareArguments({ op: "decompress", args: '{"blockId":"b5"}' }), { op: "unfold", args: { blockId: "b5" } });
});

test("facade prepareArguments moves top-level op fields into args without overriding", () => {
  const { facade } = realTools();
  assert.deepEqual(validated(facade, { op: "unfold", ref: "b5" }), { op: "unfold", args: { ref: "b5" } });
  assert.deepEqual(validated(facade, { op: "search", query: "x", args: { limit: 3 } }), { op: "search", args: { limit: 3, query: "x" } });
  assert.deepEqual(validated(facade, { op: "status", args: '{"scope":"compressed"}', limit: 5 }), { op: "status", args: { scope: "compressed", limit: 5 } });
  assert.deepEqual(facade.prepareArguments({ op: "help", tool: "decompress" }), { op: "help", args: { tool: "decompress" } });
  assert.deepEqual(facade.prepareArguments({ op: "unfold", ref: "b5", args: { ref: "b5" } }), { op: "unfold", args: { ref: "b5" } });
  // conflicting value: args wins, the top-level one stays put and is not applied
  assert.deepEqual(facade.prepareArguments({ op: "unfold", ref: "b9", args: { ref: "b5" } }), { op: "unfold", ref: "b9", args: { ref: "b5" } });
  // fields the operation does not accept stay where they are
  assert.deepEqual(facade.prepareArguments({ op: "unfold", ref: "b5", query: "x" }), { op: "unfold", query: "x", args: { ref: "b5" } });
  // legacy spellings: op alias plus the old blockId handle
  assert.deepEqual(facade.prepareArguments({ op: "decompress", blockId: "b5" }), { op: "unfold", args: { blockId: "b5" } });
});

test("facade prepareArguments infers an omitted op only from unambiguous fields", () => {
  const { facade } = realTools();
  const infer = (raw) => facade.prepareArguments(raw).op;
  assert.equal(infer({ ref: "b5" }), "unfold");
  assert.equal(infer({ args: { ref: "b5", inline: true } }), "unfold");
  assert.equal(infer({ blockId: "b5" }), "unfold", "legacy handle still infers");
  assert.equal(infer({ args: '{"query":"x"}' }), "search");
  assert.equal(infer({ query: "x", limit: 3 }), "search");
  assert.equal(infer({ scope: "compressed" }), "status");
  assert.equal(infer({ view: "messages", limit: 3 }), "status");
  assert.equal(infer({ sort: "size" }), "status");
  assert.equal(infer({ detail: "full" }), "cache");
  assert.deepEqual(validated(facade, { ref: "b5" }), { op: "unfold", args: { ref: "b5" } });
  assert.deepEqual(validated(facade, { query: "x", limit: 3 }), { op: "search", args: { query: "x", limit: 3 } });
  // shared (limit, tool), mixed, unknown and empty inputs are not guessed
  for (const raw of [{ limit: 3 }, { tool: "bash" }, { ref: "b5", query: "x" }, { ref: "b5", limit: 3 }, { foo: 1 }, {}]) {
    assert.deepEqual(facade.prepareArguments(raw), raw);
    rejected(facade, raw);
  }
});

test("facade prepareArguments keeps explicit and invalid ops and never throws or mutates", () => {
  const { facade } = realTools();
  const explicit = { op: "search", ref: "b5" };
  assert.deepEqual(facade.prepareArguments(explicit), { op: "search", ref: "b5" }, "explicit op is not re-inferred");
  const invalid = { op: "buildStatusReport", ref: "b5", args: '{"x":1}' };
  assert.deepEqual(facade.prepareArguments(invalid), invalid, "invalid op is not guessed");
  rejected(facade, invalid);
  assert.equal(facade.prepareArguments({ op: "help" }).args, undefined, "help is never inferred and gets no args");
  for (const raw of [undefined, null, "x", 5, ["a"]]) assert.equal(facade.prepareArguments(raw), raw);
  const input = { ref: "b5", args: '{"full":true}' };
  const snapshot = structuredClone(input);
  const once = facade.prepareArguments(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(facade.prepareArguments(once), once, "idempotent");
  // legacy aliases stay accepted end to end
  assert.deepEqual(facade.prepareArguments({ op: "search_context" }), { op: "search" });
  assert.deepEqual(facade.prepareArguments({ op: "acp_status" }), { op: "status" });
});

test("compress prepareArguments parses a stringified content array", () => {
  const { compress } = realTools();
  const content = JSON.stringify([RANGE, RANGE2]);
  assert.deepEqual(validated(compress, { topic: "top", content, summaryMaxChars: 100 }), { topic: "top", content: [RANGE, RANGE2], summaryMaxChars: 100 });
  assert.deepEqual(validated(compress, { content: JSON.stringify(JSON.stringify([RANGE])) }), { content: [RANGE] }, "double-encoded");
  assert.deepEqual(validated(compress, { content: JSON.stringify(RANGE) }), { content: [RANGE] }, "single encoded object");
});

test("compress prepareArguments parses stringified entries inside the content array", () => {
  const { compress } = realTools();
  assert.deepEqual(validated(compress, { content: [RANGE, JSON.stringify(RANGE2)] }), { content: [RANGE, RANGE2] });
  assert.deepEqual(validated(compress, { content: [JSON.stringify([RANGE, RANGE2])] }), { content: [RANGE, RANGE2] });
  // an element that is not a range stays, so validation still reports it
  const bad = { content: [RANGE, "not json"] };
  assert.deepEqual(compress.prepareArguments(bad), bad);
  rejected(compress, bad);
});

test("compress prepareArguments moves a range array from summary into content", () => {
  const { compress } = realTools();
  assert.deepEqual(validated(compress, { topic: "top", summary: [RANGE, RANGE2] }), { topic: "top", content: [RANGE, RANGE2] });
  assert.deepEqual(validated(compress, { summary: JSON.stringify([RANGE]) }), { content: [RANGE] });
  assert.deepEqual(validated(compress, { summary: [RANGE, JSON.stringify(RANGE2)], summaryMaxChars: 9 }), { content: [RANGE, RANGE2], summaryMaxChars: 9 });
});

test("compress prepareArguments leaves legal and non-range inputs untouched", () => {
  const { compress } = realTools();
  const same = [
    { content: [RANGE] },
    { topic: "top", content: [RANGE, RANGE2], summaryMaxChars: 5 },
    { content: "m00001-m00019 topic\nline form summary" },
    { content: "[not json" },
    { content: "[]" },
    { content: [] },
    { content: '[{"startId":"m1"}]' },
    { summary: "plain text" },
    { summary: [{ startId: "m1" }] },
    { summary: "[]" },
    { content: [RANGE], summary: [RANGE2] },
    { topic: "only" },
    {},
  ];
  for (const raw of same) assert.deepEqual(compress.prepareArguments(raw), raw);
  for (const raw of [undefined, null, "x", 5, [RANGE]]) assert.equal(compress.prepareArguments(raw), raw);
  const input = { summary: [RANGE] };
  const snapshot = structuredClone(input);
  const once = compress.prepareArguments(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(compress.prepareArguments(once), once, "idempotent");
});

test("compress prepareArguments chains an upstream prepareArguments first", () => {
  const pi = createPi();
  const upstream = (target) => {
    target.registerTool({
      name: "compress",
      label: "compress",
      description: "compress",
      parameters: structuredClone(schemas.compress),
      prepareArguments: (args) => ({ ...args, content: args.legacyContent }),
      async execute() { return { content: [] }; },
    });
  };
  createLeanAcpExtension(upstream)(pi);
  const prepared = getTool(pi, "compress").prepareArguments({ legacyContent: JSON.stringify([RANGE]) });
  assert.deepEqual(prepared.content, [RANGE]);
});
