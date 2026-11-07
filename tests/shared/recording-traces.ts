import assert from "node:assert/strict";

import { Effect, Option, Schema } from "effect";

import { BUN, DIST, PROJECT, readFirstLine } from "../../scripts/shared/codex-and-claude.ts";
import { machineTest, NO_SESSIONS, NUDGE, UUID } from "./machine-commands.ts";
import type { makeMachine } from "./machine-commands.ts";
import {
  ALL_TRACES,
  attributeOf,
  decodeTraceLine,
  spansIn,
  TODAYS_TRACES,
  TRACES,
} from "./read-traces.ts";

const OTLP_PORT = 4318;

const CONCURRENT_NUDGES = 8;

const exportToAReceiver = (file: string) => `${BUN} --cwd ${PROJECT} -e '
import { appendFileSync } from "node:fs";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { openTodaysTraceFile, otlpTracerLayer } from "./src/shared/trace-file.ts";
const [file, nudge] = process.argv.slice(1);
const server = Bun.serve({
  port: ${OTLP_PORT},
  async fetch(request) {
    const body = await request.text();
    appendFileSync(file, JSON.stringify({ path: new URL(request.url).pathname, body }) + "\\n");
    return new Response(null, { status: 200 });
  },
});
const list = Bun.spawn([nudge, "list"], {
  env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:${OTLP_PORT}" },
  stdout: "ignore",
  stderr: "inherit",
});
const code = await list.exited;
await Effect.runPromise(Effect.scoped(openTodaysTraceFile()).pipe(
  Effect.provide(otlpTracerLayer({
    url: "http://127.0.0.1:${OTLP_PORT}/v1/traces",
    httpClient: FetchHttpClient.layer,
  })),
  Effect.provide(BunServices.layer),
));
server.stop(true);
process.exit(code);' ${file} ${NUDGE}`;

const OtlpExport = Schema.fromJsonString(
  Schema.Struct({ path: Schema.String, body: Schema.String }),
);

const CODEX_BRIDGE = "~/.local/state/nudge/codex";

const SILENT_HELPER_READY = "listening";

class SilentHelperNotListening extends Schema.TaggedError<SilentHelperNotListening>()(
  "SilentHelperNotListening",
  { printed: Schema.NullOr(Schema.String) },
) {
  public override get message() {
    return `the silent stand-in for the Codex helper printed ${this.printed === null ? "nothing" : `"${this.printed}"`} instead of "${SILENT_HELPER_READY}"`;
  }
}

const withASilentCodexHelper = <Success, Failure, Services>(
  machine: Effect.Success<typeof makeMachine>,
  effect: Effect.Effect<Success, Failure, Services>,
) =>
  Effect.acquireUseRelease(
    machine.shell(`mv ${CODEX_BRIDGE}/codex.sock ${CODEX_BRIDGE}/codex.sock.real`),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const silentHelper = yield* machine.startInThisScope(
            `exec ${BUN} -e 'require("node:net").createServer(() => {}).listen(process.argv[1], () => console.log("${SILENT_HELPER_READY}"))' ${CODEX_BRIDGE}/codex.sock`,
          );
          const printed = Option.getOrNull(yield* readFirstLine(silentHelper));
          if (printed !== SILENT_HELPER_READY) {
            return yield* new SilentHelperNotListening({ printed });
          }
          return yield* effect;
        }),
      ),
    () =>
      machine.shell(
        `rm -f ${CODEX_BRIDGE}/codex.sock\nmv ${CODEX_BRIDGE}/codex.sock.real ${CODEX_BRIDGE}/codex.sock`,
      ),
  );

const MESSAGES_SENT_BY_THE_TESTS = [
  "hello from nudge",
  "ping codex",
  "from a file",
  "flag first",
  "piped to Codex",
  "to nobody",
  "piped in",
  "heredoc with dash",
  "heredoc without dash",
  "from cat",
  "via codex link",
  "from a codex task",
  "please hold",
  "wake up",
  "to one with a sender",
  "compare a",
  "report back when done",
  "run commands here",
  "never answered",
  "in the text",
  "the same text twice",
  "large for claude",
  "large for codex",
  "while you work",
  "and once more",
] as const;

const NAMES_GIVEN_BY_THE_TESTS = [
  "Archiving Claude",
  "Archiving Codex",
  "Busy Codex",
  "Control Claude",
  "Control Codex",
  "Flag Prompt Claude",
  "Listing Claude",
  "Listing Codex",
  "Nudge Blocked",
  "Nudge Twin",
  "Sandbox Claude",
  "Sandbox Documents",
  "Senders Claude",
  "Senders Codex",
  "Sending Claude",
  "Sending Codex",
  "Showing Claude",
  "Showing Codex",
  "Traces Codex",
] as const;

const NAMELESS_PROMPT = "a prompt that names its session";

const ONE_DAY_IN_MILLISECONDS = 86_400_000;

const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

const assertionsFor = (recordedSpans: Effect.Success<ReturnType<typeof spansIn>>) => {
  const withName = (name: string) => recordedSpans.filter((span) => span.name === name);
  const hasAttribute = (span: (typeof recordedSpans)[number], key: string) =>
    span.attributes.some((attribute) => attribute.key === key);
  const requireAttributes = (name: string, keys: readonly string[]) => {
    const spans = withName(name);
    assert.ok(spans.length > 0, `no ${name} spans`);
    for (const key of keys) {
      assert.ok(
        spans.some((span) => hasAttribute(span, key)),
        `${name} never recorded ${key}`,
      );
    }
  };
  return { withName, hasAttribute, requireAttributes };
};

const requireBoundedValues = (recordedSpans: Effect.Success<ReturnType<typeof spansIn>>) => {
  const boundedValues = new Map([
    ["nudge.codex.permission.profile", [":danger-full-access", "missing", "other"]],
    ["nudge.codex.rejected.reason", ["not-full-access"]],
    ["nudge.claude.archive.path", ["nothing-to-archive", "remote-control-repair", "session-file"]],
    ["nudge.claude.rename.path", ["peer-socket", "saved-session"]],
    [
      "nudge.codex.permission.approvalPolicy",
      ["never", "on-request", "on-failure", "untrusted", "unknown"],
    ],
    [
      "nudge.codex.permission.sandbox",
      ["danger-full-access", "workspace-write", "read-only", "external-sandbox", "unknown"],
    ],
    [
      "nudge.status",
      [
        "running",
        "idle",
        "waiting-for-input",
        "waiting-for-approval",
        "failed",
        "stopped",
        "archived",
        "unknown",
        "delivered",
        "accepted",
        "unarchived",
        "unchanged",
      ],
    ],
  ]);
  for (const span of recordedSpans) {
    for (const { key, value } of span.attributes) {
      const allowed = boundedValues.get(key);
      if (allowed !== undefined) {
        assert.ok(
          allowed.includes(value.stringValue ?? ""),
          `${span.name} recorded unbounded ${key}`,
        );
      }
    }
  }
};

export const recordingCallerDecisions = machineTest((machine) =>
  Effect.gen(function* () {
    const recordedSpans = yield* spansIn(yield* machine.shell(ALL_TRACES));
    const { withName, requireAttributes } = assertionsFor(recordedSpans);
    requireAttributes("codex.askDesktop", ["nudge.codex.ipcResult"]);

    requireAttributes("codex.findFullAccessCaller", [
      "nudge.codex.caller.reason",
      "nudge.codex.candidate.count",
      "nudge.codex.helper.started",
    ]);
    const candidateKeys = new Set([
      "nudge.codex.candidate.count",
      "nudge.codex.candidate.ids",
      "nudge.codex.candidate.reasons",
      "nudge.codex.candidate.approvalPolicies",
      "nudge.codex.candidate.sandboxes",
      "nudge.codex.candidate.profiles",
    ]);
    const arrayOf = (span: (typeof recordedSpans)[number], key: string) => {
      const array = span.attributes.find((attribute) => attribute.key === key)?.value.arrayValue;
      assert.ok(array, `${span.name} did not record an array for ${key}`);
      return array.values.map((value) => value.stringValue);
    };
    for (const span of withName("codex.findFullAccessCaller")) {
      for (const { key } of span.attributes.filter((attribute) =>
        attribute.key.startsWith("nudge.codex.candidate."),
      )) {
        assert.ok(candidateKeys.has(key), `unexpected candidate attribute key ${key}`);
      }
      const ids = arrayOf(span, "nudge.codex.candidate.ids");
      const reasons = arrayOf(span, "nudge.codex.candidate.reasons");
      const policies = arrayOf(span, "nudge.codex.candidate.approvalPolicies");
      const sandboxes = arrayOf(span, "nudge.codex.candidate.sandboxes");
      const profiles = arrayOf(span, "nudge.codex.candidate.profiles");
      assert.equal(new Set(ids).size, ids.length);
      for (const id of ids) {
        assert.match(id, UUID);
      }
      assert.equal(
        span.attributes.find((attribute) => attribute.key === "nudge.codex.candidate.count")?.value
          .intValue,
        ids.length,
      );
      for (const values of [reasons, policies, sandboxes, profiles]) {
        assert.equal(values.length, ids.length, "candidate arrays have different lengths");
      }
      for (const reason of reasons) {
        assert.ok(
          [
            "not-checked",
            "checking-desktop",
            "not-full-access-in-last-turn",
            "missing-full-access-profile",
            "not-loaded-in-desktop",
            "loaded-full-access",
            "desktop-check-interrupted",
          ].includes(reason),
        );
      }
      for (const policy of policies) {
        assert.ok(
          [
            "never",
            "on-request",
            "on-failure",
            "untrusted",
            "missing",
            "not-read",
            "unknown",
          ].includes(policy),
        );
      }
      for (const sandbox of sandboxes) {
        assert.ok(
          [
            "danger-full-access",
            "workspace-write",
            "read-only",
            "external-sandbox",
            "missing",
            "not-read",
            "unknown",
          ].includes(sandbox),
        );
      }
      for (const profile of profiles) {
        assert.ok([":danger-full-access", "missing", "other", "not-read"].includes(profile));
      }
      const caller = attributeOf(span, "nudge.codex.caller.id");
      if (caller !== undefined) {
        assert.equal(reasons[ids.indexOf(caller)], "loaded-full-access");
        assert.equal(profiles[ids.indexOf(caller)], ":danger-full-access");
      }
    }
    assert.ok(
      withName("codex.findFullAccessCaller").some((span) =>
        arrayOf(span, "nudge.codex.candidate.reasons").includes("missing-full-access-profile"),
      ),
      "legacy callers were not rejected in the trace",
    );
    assert.ok(
      withName("codex.findFullAccessCaller").some(
        (span) => attributeOf(span, "nudge.codex.caller.id") !== undefined,
      ),
      "the trace recorded no reused caller",
    );
    requireAttributes("codex.requireFirstTurnFullAccess", [
      "nudge.session.id",
      "nudge.codex.permission.approvalPolicy",
      "nudge.codex.permission.sandbox",
      "nudge.codex.permission.profile",
      "nudge.codex.permission.verified",
    ]);
    requireAttributes("codex.startFullAccessCaller", [
      "nudge.codex.caller.id",
      "nudge.codex.helper.started",
      "nudge.codex.permission.applied",
      "nudge.codex.permission.appliedApprovalPolicy",
      "nudge.codex.permission.appliedSandbox",
      "nudge.codex.permission.updateRequired",
      "nudge.codex.permission.profile",
      "nudge.codex.permission.delegationVerified",
      "nudge.codex.permission.verified",
    ]);
    requireBoundedValues(recordedSpans);
    for (const span of withName("codex.create")) {
      if (attributeOf(span, "nudge.codex.rejected.reason") !== undefined) {
        assert.ok(attributeOf(span, "nudge.session.id") !== undefined);
        assert.ok(
          span.attributes.some(
            ({ key, value }) =>
              key === "nudge.codex.rejected.archived" && typeof value.boolValue === "boolean",
          ),
        );
      }
    }
  }),
);

export const recordingTraces = machineTest((machine) =>
  Effect.gen(function* () {
    const codexId = yield* machine.start("codex 'hello from nudge' --name 'Traces Codex'");
    const namelessId = yield* machine.start(`claude '${NAMELESS_PROMPT}'`);
    yield* machine.waitUntilIdle(codexId, namelessId);
    yield* machine.nudge(`show ${namelessId}`);
    yield* machine.nudge(`archive ${namelessId}`);

    const linesBeforeBlockedSend = Number(yield* machine.shell(`wc -l < ${TODAYS_TRACES}`));
    const newTraceLines = machine.shell(`tail -n +${linesBeforeBlockedSend + 1} ${TODAYS_TRACES}`);
    yield* withASilentCodexHelper(
      machine,
      Effect.gen(function* () {
        const blockedSend = yield* machine.startInThisScope(
          `exec ${NUDGE} send 'Traces Codex' 'never answered' > /dev/null 2>&1`,
        );
        yield* machine.filesHave([
          {
            file: yield* machine.shell(`echo ${TODAYS_TRACES}`),
            texts: ['"name":"findSession"'],
            afterLine: linesBeforeBlockedSend,
          },
        ]);
        const spansWhileBlocked = yield* spansIn(yield* newTraceLines);
        assert.deepEqual(
          ["nudge.start", "findSession"].filter(
            (name) => !spansWhileBlocked.some((span) => span.name === name),
          ),
          [],
        );
        yield* blockedSend.kill({ killSignal: "SIGTERM" });
      }),
    );
    const spansAfterSignal = yield* spansIn(yield* newTraceLines);
    for (const name of ["nudge", "nudge.send", "nudge.deliver", "codex.send", "codex.callTool"]) {
      const span = spansAfterSignal.find((candidate) => candidate.name === name);
      assert.ok(span, `the killed send left no ${name} span`);
      assert.ok(
        span.attributes.some(
          (attribute) =>
            attribute.key === "effect.fiber.interrupted" && attribute.value.boolValue === true,
        ),
        `${name} isn't marked interrupted`,
      );
    }
    yield* machine.nudge("archive 'Traces Codex'");

    const traceLines = (yield* machine.shell(ALL_TRACES)).split("\n");
    const traces = yield* Effect.forEach(traceLines, (line) => decodeTraceLine(line));
    for (const resourceSpan of traces.flatMap((trace) => trace.resourceSpans)) {
      assert.ok(
        resourceSpan.resource.attributes.some(
          (attribute) =>
            attribute.key === "service.name" && attribute.value.stringValue === "nudge",
        ),
      );
    }
    const recordedSpans = yield* spansIn(traceLines.join("\n"));
    const { withName, hasAttribute, requireAttributes } = assertionsFor(recordedSpans);
    requireAttributes("codex.chooseCaller", [
      "nudge.codex.caller.id",
      "nudge.codex.helper.started",
      "nudge.codex.caller.reason",
      "nudge.codex.caller.fullAccessRequired",
    ]);
    requireAttributes("codex.create", [
      "nudge.session.id",
      "nudge.codex.caller.id",
      "nudge.codex.helper.started",
      "nudge.codex.permission.source",
      "nudge.codex.permission.fullAccessRequired",
    ]);
    requireAttributes("codex.callTool", [
      "nudge.codex.caller.id",
      "nudge.codex.caller.reason",
      "nudge.codex.tool",
      "nudge.codex.call.id",
      "nudge.codex.tool.succeeded",
    ]);
    requireBoundedValues(recordedSpans);
    const created = withName("codex.create").find(
      (span) => attributeOf(span, "nudge.session.id") === codexId,
    );
    assert.ok(created, "new codex recorded no created task");
    const caller = attributeOf(created, "nudge.codex.caller.id");
    assert.ok(caller !== undefined && caller !== "", "new codex recorded no chosen caller");
    assert.ok(
      withName("codex.chooseCaller").some(
        (span) =>
          span.traceId === created.traceId && attributeOf(span, "nudge.codex.caller.id") === caller,
      ),
    );
    assert.ok(
      withName("codex.callTool").some(
        (span) =>
          span.traceId === created.traceId &&
          attributeOf(span, "nudge.codex.tool") === "create_thread" &&
          attributeOf(span, "nudge.codex.caller.id") === caller,
      ),
    );
    requireAttributes("findOneSession", [
      "nudge.resolution.by",
      "nudge.resolution.match.count",
      "nudge.resolution.match.ids",
      "nudge.resolution.archived",
      "nudge.session.id",
    ]);
    requireAttributes("findSession", ["nudge.provider", "nudge.session.id"]);
    requireAttributes("nudge.list", [
      "nudge.list.archived",
      "nudge.list.match.count",
      "nudge.list.page.count",
      "nudge.list.offset",
    ]);
    requireAttributes("nudge.show", ["nudge.session.id", "nudge.status"]);
    requireAttributes("nudge.rename", ["nudge.session.id", "nudge.rename.required"]);
    for (const name of ["nudge.archive", "nudge.unarchive"]) {
      requireAttributes(name, ["nudge.session.id", "nudge.status"]);
    }
    requireAttributes("codex.unarchive", [
      "nudge.session.id",
      "nudge.codex.unarchive.applied",
      "nudge.codex.unarchive.desktopFailure",
    ]);
    requireAttributes("claude.rename", [
      "nudge.session.id",
      "nudge.claude.rename.path",
      "nudge.rename.required",
    ]);
    requireAttributes("claude.archive", [
      "nudge.session.id",
      "nudge.claude.archive.path",
      "nudge.claude.archive.stop",
    ]);
    requireAttributes("nudge.new", [
      "nudge.sender.reason",
      "nudge.sender.ancestor.count",
      "nudge.sender.unknownInSession",
      "nudge.session.id",
      "nudge.warning.count",
    ]);
    requireAttributes("codex.readDefaultPermissions", [
      "nudge.codex.permission.source",
      "nudge.codex.permission.selection",
      "nudge.codex.permission.saved",
      "nudge.codex.permission.workspaceKind",
      "nudge.codex.permission.fullAccess",
    ]);
    for (const name of ["codex.send", "claude.send"]) {
      requireAttributes(name, ["nudge.session.id", "nudge.delivery.path", "nudge.status"]);
    }
    requireAttributes("codex.send", ["nudge.delivery.turnRunning"]);
    requireAttributes("nudge.deliver", ["nudge.session.id", "nudge.provider", "nudge.status"]);
    requireAttributes("claude.requirePrivate", [
      "nudge.claude.file.type",
      "nudge.claude.file.private",
      "nudge.claude.file.mode",
      "nudge.claude.file.ownerMatches",
    ]);
    requireAttributes("claude.findPeerKey", [
      "nudge.session.id",
      "nudge.claude.peerKey.candidate.count",
      "nudge.claude.peerKey.match.count",
    ]);
    requireAttributes("claude.startJob", ["nudge.claude.job.resumed", "nudge.claude.job.same"]);
    requireAttributes("claude.resume", ["nudge.session.id"]);
    requireAttributes("claude.create", ["nudge.session.id", "nudge.claude.firstReply.apiError"]);
    const waits = withName("nudge.wait").filter((span) =>
      hasAttribute(span, "nudge.wait.target.ids"),
    );
    assert.ok(waits.length > 0, "no wait recorded its watches");
    for (const span of waits) {
      for (const key of ["nudge.wait.target.ids", "nudge.wait.directory.ids"]) {
        assert.match(attributeOf(span, key) ?? "", /^[a-f0-9]{64}(?: [a-f0-9]{64})*$/u);
      }
      for (const key of [
        "nudge.wait.target.count",
        "nudge.wait.directory.count",
        "nudge.wait.parentWatch.count",
      ]) {
        assert.ok(hasAttribute(span, key));
      }
    }
    const traceText = traceLines.join("\n");
    for (const text of [...MESSAGES_SENT_BY_THE_TESTS, NAMELESS_PROMPT]) {
      assert.ok(!traceText.includes(text), `the traces contain the message "${text}"`);
    }
    for (const name of NAMES_GIVEN_BY_THE_TESTS) {
      assert.ok(!traceText.includes(name), `the traces contain the session name "${name}"`);
    }
    assert.ok(traceText.includes(codexId), "the traces don't contain the task's ID");

    const missingPipe = "/tmp/no-such-app-tools-pipe";
    yield* machine.shell(
      `CODEX_APP_TOOLS_PIPE_PATH=${missingPipe} ${BUN} ${DIST}nudge-codex-desktop-helper.mjs </dev/null`,
    );
    const helperFailure = (yield* spansIn(yield* machine.shell(ALL_TRACES))).find(
      (span) => span.name === "codexHelper.failure",
    );
    assert.ok(helperFailure, "the Codex helper didn't record its failure to connect");
    assert.equal(
      attributeOf(helperFailure, "nudge.helper.operation"),
      `connect to Codex's app tools at ${missingPipe}`,
    );
    assert.match(attributeOf(helperFailure, "nudge.helper.error") ?? "", /ENOENT/u);

    const [, tracesAfterList = "", today = ""] = yield* machine.shells([
      `touch ${TRACES}/2000-01-01.jsonl ${TRACES}/notes.txt && ${NUDGE} list`,
      `ls ${TRACES}`,
      "date +%F",
    ]);
    const yesterday = new Date(Date.parse(today) - ONE_DAY_IN_MILLISECONDS)
      .toISOString()
      .slice(0, ISO_DATE_LENGTH);
    assert.deepEqual(
      tracesAfterList
        .split("\n")
        .filter((file) => file !== `${yesterday}.jsonl`)
        .toSorted(),
      [`${today}.jsonl`, "notes.txt"],
    );

    const versionsAtOnce = yield* machine.shell(
      `touch ${TRACES}/2000-{01..12}-{01..28}.jsonl && mv ${CODEX_BRIDGE}/codex.sock ${CODEX_BRIDGE}/codex.sock.real && for run in $(seq ${CONCURRENT_NUDGES}); do ${NUDGE} --version > ${machine.scratch}/version-$run 2>&1 & done; wait; mv ${CODEX_BRIDGE}/codex.sock.real ${CODEX_BRIDGE}/codex.sock && cat ${machine.scratch}/version-*`,
    );
    assert.doesNotMatch(versionsAtOnce, /warning/u);

    yield* machine.shell(`chmod 400 ${TODAYS_TRACES}`);
    const withoutClaudeSessions = `CLAUDE_CONFIG_DIR=${machine.scratch}/no-claude NUDGE_CLAUDE_DESKTOP_DIR=${machine.scratch}/no-claude-desktop`;
    const unwritable = yield* machine.attempt(`${withoutClaudeSessions} ${NUDGE} list`);
    const unwritableWithSilentHelper = yield* withASilentCodexHelper(
      machine,
      machine.attempt(`${withoutClaudeSessions} ${NUDGE} list`),
    );
    yield* machine.shell(`chmod 600 ${TODAYS_TRACES}`);
    const cannotOpenTraces = `warning: nudge didn't record traces: PermissionDenied: FileSystem.open (${machine.home}/.local/state/nudge/traces/${today}.jsonl)`;
    assert.equal(unwritable.code, 0);
    assert.equal(unwritable.standardOutput, NO_SESSIONS);
    assert.ok(
      unwritable.standardError.startsWith(
        `${cannotOpenTraces}, and the Codex helper couldn't record them: `,
      ),
      unwritable.standardError,
    );
    assert.deepEqual(unwritableWithSilentHelper, {
      code: 0,
      standardOutput: NO_SESSIONS,
      standardError: `${cannotOpenTraces}, and the Codex helper didn't reply before nudge exited`,
    });

    const otlpExports = `${machine.scratch}/otlp-exports.jsonl`;
    const countTraceLines = Effect.map(
      machine.shell(ALL_TRACES),
      (allTraces) => allTraces.split("\n").length,
    );
    const linesBeforeExport = yield* countTraceLines;
    yield* machine.shell(exportToAReceiver(otlpExports));
    const exports = yield* Effect.forEach(
      (yield* machine.shell(`cat ${otlpExports}`)).split("\n"),
      (line) => Schema.decodeEffect(OtlpExport)(line),
    );
    assert.deepEqual([...new Set(exports.map((exported) => exported.path))], ["/v1/traces"]);
    const exportedSpans = yield* spansIn(exports.map((exported) => exported.body).join("\n"));
    assert.ok(exportedSpans.some((span) => span.name === "nudge.list"));
    const retention = exportedSpans.find((span) => span.name === "deleteOldTraceFiles");
    assert.ok(retention, "the active tracer did not record retention");
    assert.ok(hasAttribute(retention, "nudge.trace.expired.count"));
    assert.equal(yield* countTraceLines, linesBeforeExport);
  }),
);
