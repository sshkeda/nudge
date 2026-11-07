import assert from "node:assert/strict";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Option, Schema } from "effect";

import { BUN } from "../../scripts/shared/codex-and-claude.ts";
import {
  describeCatalogSession,
  groupSources,
} from "../../src/lib/claude/internal/claude-catalog.ts";
import { HistorySession } from "../../src/lib/claude/internal/claude-history.ts";
import {
  ClaudeRegistration,
  ClaudeSavedSession,
  ClaudeSession,
} from "../../src/lib/claude/internal/claude-session.ts";
import { DesktopSession } from "../../src/lib/claude/internal/read-desktop-sessions.ts";

const PROJECT = "/tmp/nudge-project";

const WORKTREE = `${PROJECT}/.claude/worktrees/desktop`;

const PROJECT_DIRECTORY_NAME = "-tmp-nudge-project";

const INLINE = "11111111-1111-4111-8111-111111111111";
const AI_TITLED = "22222222-2222-4222-8222-222222222222";
const SIDECAR = "33333333-3333-4333-8333-333333333333";
const AGENT_NAMED = "44444444-4444-4444-8444-444444444444";
const UNTITLED = "55555555-5555-4555-8555-555555555555";
const IN_DESKTOP = "66666666-6666-4666-8666-666666666666";
const ARCHIVED_IN_DESKTOP = "77777777-7777-4777-8777-777777777777";
const LIVE = "88888888-8888-4888-8888-888888888888";
const BRIDGED = "99999999-9999-4999-8999-999999999999";
const AMBIGUOUS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESTARTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ONE_OFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BACKGROUND = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CRASHED_TERMINAL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RESUMED = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RESUME_FAILS = "abababab-abab-4bab-8bab-abababababab";

const BRIDGE = "01GLXFRWFDnXyQbVwpiaWU27";
const OTHER_BRIDGE = "01GLXFRUkAX8htKo6yesoWv3";

const GONE_PROCESS = 2_147_483_000;

const EXECUTABLE = 0o755;

const FIRST_MESSAGE_AT = "2026-11-01T10:00:00.000Z";
const LAST_MESSAGE_AT = "2026-11-01T10:05:00.000Z";
const DESKTOP_ACTIVITY = 1_794_000_000_000;
const OLDER_DESKTOP_ACTIVITY = 1_793_000_000_000;
const ARCHIVED_ACTIVITY = 1_793_500_000_000;
const ONLY_IN_DESKTOP_ACTIVITY = 1_792_000_000_000;

const MESSAGE_ID_PREFIX_LENGTH = 8;

const messageIdOf = ({
  sessionId,
  index,
}: {
  readonly sessionId: string;
  readonly index: number;
}) => `${sessionId.slice(0, MESSAGE_ID_PREFIX_LENGTH)}-0000-4000-8000-00000000000${index}`;

const userMessage = (sessionId: string, origin = "") =>
  `{"type":"user","uuid":"${messageIdOf({ sessionId, index: 1 })}","parentUuid":null,${origin}"sessionId":"${sessionId}","cwd":"${PROJECT}","timestamp":"${FIRST_MESSAGE_AT}","message":{"role":"user","content":"hello from nudge"}}`;

const bridgeRecord = ({
  sessionId,
  bridgeId,
}: {
  readonly sessionId: string;
  readonly bridgeId: string;
}) =>
  `{"type":"bridge-session","sessionId":"${sessionId}","bridgeSessionId":"cse_${bridgeId}","lastSequenceNum":3}`;

const jobState = ({
  sessionId,
  state,
  bridgeId,
}: {
  readonly sessionId: string;
  readonly state: string;
  readonly bridgeId: string;
}) =>
  `{"state":"${state}","detail":null,"sessionId":"${sessionId}","bridgeSessionId":"cse_${bridgeId}"}`;

const assistantMessage = (sessionId: string) =>
  `{"type":"assistant","uuid":"${messageIdOf({ sessionId, index: 2 })}","parentUuid":"${messageIdOf({ sessionId, index: 1 })}","sessionId":"${sessionId}","cwd":"${PROJECT}","timestamp":"${LAST_MESSAGE_AT}","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}`;

const titleRecord = ({
  sessionId,
  type,
  field,
  title,
}: {
  readonly sessionId: string;
  readonly type: string;
  readonly field: string;
  readonly title: string;
}) => `{"type":"${type}","${field}":"${title}","sessionId":"${sessionId}"}`;

const TRANSCRIPTS = [
  {
    id: INLINE,
    lines: [
      userMessage(INLINE),
      assistantMessage(INLINE),
      titleRecord({
        sessionId: INLINE,
        type: "custom-title",
        field: "customTitle",
        title: "Inline Title",
      }),
    ],
  },
  {
    id: AI_TITLED,
    lines: [
      userMessage(AI_TITLED),
      titleRecord({
        sessionId: AI_TITLED,
        type: "ai-title",
        field: "aiTitle",
        title: "claude-picked-title",
      }),
    ],
  },
  { id: SIDECAR, lines: [userMessage(SIDECAR)] },
  {
    id: AGENT_NAMED,
    lines: [
      userMessage(AGENT_NAMED),
      titleRecord({
        sessionId: AGENT_NAMED,
        type: "agent-name",
        field: "agentName",
        title: "Agent Name",
      }),
    ],
  },
  { id: UNTITLED, lines: [userMessage(UNTITLED)] },
  {
    id: IN_DESKTOP,
    lines: [
      userMessage(IN_DESKTOP),
      titleRecord({
        sessionId: IN_DESKTOP,
        type: "custom-title",
        field: "customTitle",
        title: "Claude Code Title",
      }),
    ],
  },
  { id: ARCHIVED_IN_DESKTOP, lines: [userMessage(ARCHIVED_IN_DESKTOP)] },
  {
    id: BRIDGED,
    lines: [userMessage(BRIDGED), bridgeRecord({ sessionId: BRIDGED, bridgeId: BRIDGE })],
  },
  {
    id: AMBIGUOUS,
    lines: [userMessage(AMBIGUOUS), bridgeRecord({ sessionId: AMBIGUOUS, bridgeId: OTHER_BRIDGE })],
  },
  {
    id: RESTARTING,
    lines: [userMessage(RESTARTING), bridgeRecord({ sessionId: RESTARTING, bridgeId: BRIDGE })],
  },
  {
    id: CRASHED_TERMINAL,
    lines: [
      userMessage(CRASHED_TERMINAL),
      bridgeRecord({ sessionId: CRASHED_TERMINAL, bridgeId: OTHER_BRIDGE }),
    ],
  },
  {
    id: RESUMED,
    lines: [userMessage(RESUMED), bridgeRecord({ sessionId: RESUMED, bridgeId: BRIDGE })],
  },
  {
    id: RESUME_FAILS,
    lines: [userMessage(RESUME_FAILS), bridgeRecord({ sessionId: RESUME_FAILS, bridgeId: BRIDGE })],
  },
  { id: ONE_OFF, lines: [userMessage(ONE_OFF, `"entrypoint":"sdk-cli",`)] },
  {
    id: BACKGROUND,
    lines: [userMessage(BACKGROUND, `"entrypoint":"cli","sessionKind":"bg",`)],
  },
] as const;

const JOBS = [
  { sessionId: BRIDGED, state: "done", bridgeId: BRIDGE },
  { sessionId: AMBIGUOUS, state: "done", bridgeId: BRIDGE },
  { sessionId: RESTARTING, state: "working", bridgeId: BRIDGE },
  { sessionId: RESUMED, state: "done", bridgeId: BRIDGE },
  { sessionId: RESUME_FAILS, state: "done", bridgeId: BRIDGE },
] as const;

const RUNS_IN_WORK: ReadonlySet<string> = new Set([BRIDGED, RESUMED, RESUME_FAILS]);

const RESUMED_JOB = RESUMED.slice(0, MESSAGE_ID_PREFIX_LENGTH);

const RESUME_FAILS_JOB = RESUME_FAILS.slice(0, MESSAGE_ID_PREFIX_LENGTH);

const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = stop ]; then
  printf '%s\\n' "$*" >> "$NUDGE_TEST_CLAUDE_CALL"
  for registration in "$CLAUDE_CONFIG_DIR"/sessions/*.json; do
    if grep -q '"jobId":"'"$2"'"' "$registration"; then
      kill "$(basename "$registration" .json)"
      rm "$registration"
    fi
  done
  printf '{"state":"stopped"}' > "$CLAUDE_CONFIG_DIR/jobs/$2/state.json"
  exit 0
fi
printf '%s %s\\n' "$PWD" "$*" >> "$NUDGE_TEST_CLAUDE_CALL"
if [ "$3" = ${RESUME_FAILS} ]; then
  printf '{"state":"confused","sessionId":"${RESUME_FAILS}"}' > "$CLAUDE_CONFIG_DIR/jobs/${RESUME_FAILS_JOB}/state.json"
  echo "backgrounded · ${RESUME_FAILS_JOB}"
  exit 0
fi
if [ "$3" = ${RESUMED} ]; then
  runtime=$(${BUN} -e 'const runtime = require("node:child_process").spawn("sleep", ["600"], { detached: true, stdio: "ignore" }); runtime.unref(); console.log(runtime.pid);')
  printf '{"pid":%s,"sessionId":"${RESUMED}","startedAt":1,"jobId":"${RESUMED_JOB}","procStart":"never","messagingSocketPath":"/nowhere/\\\\u0000","bridgeSessionId":"session_${BRIDGE}"}' "$runtime" > "$CLAUDE_CONFIG_DIR/sessions/$runtime.json"
  echo "backgrounded · ${RESUMED_JOB}"
  exit 0
fi
echo "fake claude doesn't start sessions" >&2
exit 1
`;

const DESKTOP_RECORDS = [
  {
    path: "account-one/organization-one/local_in-desktop.json",
    record: {
      sessionId: "local_in-desktop",
      cliSessionId: IN_DESKTOP,
      isArchived: false,
      title: "Desktop Title",
      cwd: WORKTREE,
      originCwd: PROJECT,
      lastActivityAt: DESKTOP_ACTIVITY,
    },
  },
  {
    path: "account-one/organization-two/local_in-desktop-before.json",
    record: {
      sessionId: "local_in-desktop-before",
      cliSessionId: IN_DESKTOP,
      isArchived: false,
      title: "Older Desktop Title",
      cwd: PROJECT,
      lastActivityAt: OLDER_DESKTOP_ACTIVITY,
    },
  },
  {
    path: "account-two/organization-three/local_archived.json",
    record: {
      sessionId: "local_archived",
      cliSessionId: ARCHIVED_IN_DESKTOP,
      isArchived: true,
      title: "Archived In The App",
      cwd: PROJECT,
      lastActivityAt: ARCHIVED_ACTIVITY,
    },
  },
  {
    path: "account-two/organization-three/local_only-in-desktop.json",
    record: {
      sessionId: "local_only-in-desktop",
      isArchived: false,
      title: "Only In The App",
      lastActivityAt: ONLY_IN_DESKTOP_ACTIVITY,
    },
  },
] as const;

const Listed = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  project: Schema.String,
  directory: Schema.String,
  lastActiveAt: Schema.String,
  hasTranscript: Schema.Boolean,
});

const Change = Schema.Struct({
  id: Schema.String,
  appTitle: Schema.optional(Schema.NullOr(Schema.String)),
  archived: Schema.optional(Schema.String),
});

const Listing = Schema.fromJsonString(
  Schema.Struct({
    targets: Schema.Array(Schema.String),
    listed: Schema.Array(Listed),
    archived: Schema.Array(Listed),
    changes: Schema.Array(Change),
  }),
);

const LIST_SCRIPT = `
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { Claude, claudeLayer } from "${new URL("../../src/lib/claude/index.ts", import.meta.url).pathname}";
import { platformLayer } from "${new URL("../../src/lib/platform/index.ts", import.meta.url).pathname}";
import { outputLayerFor } from "${new URL("../../src/shared/output.ts", import.meta.url).pathname}";
const plain = (session) => ({
  id: session.id,
  name: session.name,
  status: session.status,
  project: session.project,
  directory: session.directory,
  lastActiveAt: session.lastActiveAt,
  hasTranscript: Option.isSome(session.transcript),
});
const layer = claudeLayer.pipe(
  Layer.provideMerge(outputLayerFor({ mode: "terminal", home: "/nowhere" })),
  Layer.provideMerge(platformLayer),
  Layer.provideMerge(BunServices.layer),
);
const listing = await Effect.runPromise(
  Effect.gen(function* () {
    const claude = yield* Claude;
    const find = (id) =>
      Effect.map(Effect.all([claude.list, claude.listArchived]), (lists) =>
        lists.flat().find((session) => session.id === id),
      );
    const changes = [];
    const linesOf = (text) => (text ?? "").split("\\n").filter((line) => line !== "");
    for (const [id, name] of linesOf(process.env.NUDGE_TEST_RENAMES).map((line) => line.split("\\t"))) {
      const renamed = yield* claude.rename({ session: yield* find(id), name });
      changes.push({ id, appTitle: Option.getOrNull(renamed.appTitle) });
    }
    for (const id of linesOf(process.env.NUDGE_TEST_ARCHIVES)) {
      const archived = yield* Effect.result(claude.archive(yield* find(id)));
      changes.push({ id, archived: archived._tag === "Failure" ? archived.failure._tag : archived.success });
    }
    const targets = (yield* claude.findTarget(process.env.NUDGE_TEST_TARGET ?? "")).map((session) => session.id);
    return {
      targets,
      listed: (yield* claude.list).map(plain),
      archived: (yield* claude.listArchived).map(plain),
      changes,
    };
  }).pipe(Effect.provide(layer)),
);
console.log(JSON.stringify(listing));`;

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const byId = (sessions: readonly (typeof Listed.Type)[]) =>
  Object.fromEntries(sessions.map((session) => [session.id, session]));

const stopped = ({
  id,
  name,
  directory = PROJECT,
  lastActiveAt = FIRST_MESSAGE_AT,
}: {
  readonly id: string;
  readonly name: string;
  readonly directory?: string;
  readonly lastActiveAt?: string;
}) => ({
  id,
  name,
  status: "stopped",
  project: directory,
  directory,
  lastActiveAt,
  hasTranscript: true,
});

const listWith = ({
  base,
  desktop,
  renames = [],
  archives = [],
  target = "",
}: {
  readonly base: string;
  readonly desktop: string;
  readonly renames?: readonly (readonly [string, string])[];
  readonly archives?: readonly string[];
  readonly target?: string;
}) =>
  Task.exec(BUN, ["-e", LIST_SCRIPT], {
    env: {
      CLAUDE_CONFIG_DIR: `${base}/claude`,
      NUDGE_CLAUDE_DESKTOP_DIR: desktop,
      NUDGE_TEST_RENAMES: renames.map((pair) => pair.join("\t")).join("\n"),
      NUDGE_TEST_ARCHIVES: archives.join("\n"),
      NUDGE_TEST_TARGET: target,
      NUDGE_TEST_CLAUDE_CALL: `${base}/claude-call.txt`,
      PATH: `${base}/bin:/usr/bin:/bin`,
    },
  }).pipe(Effect.flatMap(Schema.decodeEffect(Listing)));

const liveSession = ClaudeSession.make({
  provider: "Claude",
  appTitle: Option.none(),
  appState: "absent",
  id: LIVE,
  name: "Live Name",
  status: "idle",
  project: PROJECT,
  section: "",
  directory: PROJECT,
  transcript: Option.none(),
  lastActiveAt: LAST_MESSAGE_AT,
  handle: ClaudeRegistration.make({ file: "/nowhere/1.json" }),
});

const desktopSession = (fields: Partial<typeof DesktopSession.Type>) =>
  DesktopSession.make({
    sessionId: "local_live",
    cliSessionId: Option.some(LIVE),
    isArchived: false,
    title: Option.none(),
    directory: Option.none(),
    originDirectory: Option.none(),
    lastActivityAt: DESKTOP_ACTIVITY,
    ...fields,
  });

const describeLive = (desktop: readonly (typeof DesktopSession.Type)[]) => {
  const [group] = groupSources({
    live: [liveSession],
    desktop,
    history: [
      HistorySession.make({
        id: LIVE,
        title: Option.some("History Title"),
        directory: Option.some(PROJECT),
        createdAt: Option.none(),
      }),
    ],
  });
  assert.ok(group);
  return describeCatalogSession({
    group,
    transcript: Option.none(),
    lastMessageAt: Option.none(),
    agentName: Option.none(),
  });
};

export const listingClaudeSessions = Task.make(
  "listing-claude-sessions",
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const base = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const config = `${base}/claude`;
      const project = `${config}/projects/${PROJECT_DIRECTORY_NAME}`;
      yield* fileSystem.makeDirectory(`${project}/${SIDECAR}`, { recursive: true });
      const work = `${base}/work`;
      yield* fileSystem.makeDirectory(work, { recursive: true });
      yield* Effect.forEach(
        TRANSCRIPTS,
        ({ id, lines }) => {
          const text = `${lines.join("\n")}\n`;
          return fileSystem.writeFileString(
            `${project}/${id}.jsonl`,
            RUNS_IN_WORK.has(id) ? text.replaceAll(PROJECT, work) : text,
          );
        },
        { discard: true },
      );
      yield* Effect.forEach(
        JOBS,
        (job) =>
          Effect.gen(function* () {
            const directory = `${config}/jobs/${job.sessionId.slice(0, MESSAGE_ID_PREFIX_LENGTH)}`;
            yield* fileSystem.makeDirectory(directory, { recursive: true });
            yield* fileSystem.writeFileString(`${directory}/state.json`, jobState(job));
          }),
        { discard: true },
      );
      yield* fileSystem.makeDirectory(`${config}/sessions`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${config}/sessions/${GONE_PROCESS}.json`,
        `{"pid":${GONE_PROCESS},"sessionId":"${BRIDGED}","startedAt":${DESKTOP_ACTIVITY},"cwd":"${work}","bridgeSessionId":"session_${BRIDGE}"}`,
      );
      yield* fileSystem.writeFileString(
        `${config}/sessions/${GONE_PROCESS + 1}.json`,
        `{"pid":${GONE_PROCESS + 1},"sessionId":"${CRASHED_TERMINAL}","startedAt":${DESKTOP_ACTIVITY},"status":"busy","bridgeSessionId":"session_${OTHER_BRIDGE}"}`,
      );
      yield* fileSystem.makeDirectory(`${base}/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${base}/bin/claude`, FAKE_CLAUDE);
      yield* fileSystem.chmod(`${base}/bin/claude`, EXECUTABLE);
      yield* fileSystem.writeFileString(
        `${project}/${SIDECAR}/custom-title.json`,
        `{"customTitle":"Sidecar Title"}`,
      );
      const desktop = `${base}/desktop`;
      yield* Effect.forEach(
        DESKTOP_RECORDS,
        ({ path, record }) =>
          Effect.gen(function* () {
            const file = `${desktop}/claude-code-sessions/${path}`;
            yield* fileSystem.makeDirectory(file.slice(0, file.lastIndexOf("/")), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(file, yield* encodeJson(record));
          }),
        { discard: true },
      );
      yield* fileSystem.writeFileString(
        `${desktop}/claude-code-sessions/account-two/organization-three/local_torn.json`,
        "{",
      );

      const withDesktop = yield* listWith({ base, desktop, target: UNTITLED });
      const fromHistory = {
        [INLINE]: stopped({ id: INLINE, name: "Inline Title", lastActiveAt: LAST_MESSAGE_AT }),
        [AI_TITLED]: stopped({ id: AI_TITLED, name: "claude-picked-title" }),
        [SIDECAR]: stopped({ id: SIDECAR, name: "Sidecar Title" }),
        [AGENT_NAMED]: stopped({ id: AGENT_NAMED, name: "Agent Name" }),
        [UNTITLED]: stopped({ id: UNTITLED, name: UNTITLED }),
        [BRIDGED]: stopped({ id: BRIDGED, name: BRIDGED, directory: work }),
        [AMBIGUOUS]: stopped({ id: AMBIGUOUS, name: AMBIGUOUS }),
        [RESTARTING]: stopped({ id: RESTARTING, name: RESTARTING }),
        [BACKGROUND]: stopped({ id: BACKGROUND, name: BACKGROUND }),
        [CRASHED_TERMINAL]: stopped({ id: CRASHED_TERMINAL, name: CRASHED_TERMINAL }),
        [RESUMED]: stopped({ id: RESUMED, name: RESUMED, directory: work }),
        [RESUME_FAILS]: stopped({ id: RESUME_FAILS, name: RESUME_FAILS, directory: work }),
      };
      assert.deepEqual(byId(withDesktop.listed), {
        [IN_DESKTOP]: {
          id: IN_DESKTOP,
          name: "Desktop Title",
          status: "stopped",
          project: PROJECT,
          directory: WORKTREE,
          lastActiveAt: new Date(DESKTOP_ACTIVITY).toISOString(),
          hasTranscript: true,
        },
        "local_only-in-desktop": {
          id: "local_only-in-desktop",
          name: "Only In The App",
          status: "stopped",
          project: "",
          directory: "",
          lastActiveAt: new Date(ONLY_IN_DESKTOP_ACTIVITY).toISOString(),
          hasTranscript: false,
        },
      });
      assert.deepEqual(byId(withDesktop.archived), {
        ...fromHistory,
        [ARCHIVED_IN_DESKTOP]: {
          id: ARCHIVED_IN_DESKTOP,
          name: "Archived In The App",
          status: "archived",
          project: PROJECT,
          directory: PROJECT,
          lastActiveAt: new Date(ARCHIVED_ACTIVITY).toISOString(),
          hasTranscript: true,
        },
      });
      assert.deepEqual(withDesktop.targets, [UNTITLED]);
      assert.deepEqual(
        (yield* listWith({ base, desktop, target: "Archived In The App" })).targets,
        [],
      );
      assert.deepEqual((yield* listWith({ base, desktop, target: ONE_OFF })).targets, []);

      const withoutDesktop = yield* listWith({ base, desktop: `${base}/no-desktop` });
      assert.deepEqual(withoutDesktop.listed, []);
      assert.deepEqual(byId(withoutDesktop.archived), {
        ...fromHistory,
        [IN_DESKTOP]: stopped({ id: IN_DESKTOP, name: "Claude Code Title" }),
        [ARCHIVED_IN_DESKTOP]: stopped({ id: ARCHIVED_IN_DESKTOP, name: ARCHIVED_IN_DESKTOP }),
      });

      const changed = yield* listWith({
        base,
        desktop,
        renames: [
          [INLINE, "Inline Renamed"],
          [IN_DESKTOP, "Renamed In Claude Code"],
        ],
        archives: [
          UNTITLED,
          ARCHIVED_IN_DESKTOP,
          IN_DESKTOP,
          AMBIGUOUS,
          RESTARTING,
          CRASHED_TERMINAL,
          BRIDGED,
          RESUMED,
          RESUME_FAILS,
        ],
      });
      assert.deepEqual(changed.changes, [
        { id: INLINE, appTitle: null },
        { id: IN_DESKTOP, appTitle: "Desktop Title" },
        { id: UNTITLED, archived: "unchanged" },
        { id: ARCHIVED_IN_DESKTOP, archived: "unchanged" },
        { id: IN_DESKTOP, archived: "ClaudeAppSessionNotArchivable" },
        { id: AMBIGUOUS, archived: "ClaudeRemoteControlAmbiguous" },
        { id: RESTARTING, archived: "ClaudeSessionRestarting" },
        { id: CRASHED_TERMINAL, archived: "ClaudeSessionRestarting" },
        { id: BRIDGED, archived: "CommandFailed" },
        { id: RESUMED, archived: "PlatformError" },
        { id: RESUME_FAILS, archived: "ClaudeJobStateUnknown" },
      ]);
      assert.equal(
        yield* fileSystem.readFileString(`${base}/claude-call.txt`),
        [
          `${work} --bg --resume ${BRIDGED}`,
          `${work} --bg --resume ${RESUMED}`,
          `stop ${RESUMED_JOB}`,
          `${work} --bg --resume ${RESUME_FAILS}`,
          `stop ${RESUME_FAILS_JOB}`,
          "",
        ].join("\n"),
      );
      assert.deepEqual((yield* fileSystem.readDirectory(`${config}/sessions`)).toSorted(), [
        `${GONE_PROCESS}.json`,
        `${GONE_PROCESS + 1}.json`,
      ]);
      const changedById = byId(changed.archived);
      assert.equal(changedById[INLINE]?.name, "Inline Renamed");
      assert.equal(changedById[UNTITLED]?.status, "stopped");
      assert.equal(byId(changed.listed)[IN_DESKTOP]?.name, "Desktop Title");
      const renamedWithoutDesktop = byId(
        (yield* listWith({ base, desktop: `${base}/no-desktop` })).archived,
      );
      assert.equal(renamedWithoutDesktop[IN_DESKTOP]?.name, "Renamed In Claude Code");

      const live = describeLive([]);
      assert.equal(live.status, "idle");
      assert.equal(live.name, "Live Name");
      assert.ok(Option.isNone(live.appTitle));
      assert.equal(live.handle._tag, "ClaudeRegistration");
      const liveInDesktop = describeLive([
        desktopSession({
          title: Option.some("Desktop Title"),
          directory: Option.some(WORKTREE),
          originDirectory: Option.some(PROJECT),
          isArchived: true,
        }),
      ]);
      assert.deepEqual(
        {
          status: liveInDesktop.status,
          name: liveInDesktop.name,
          appTitle: liveInDesktop.appTitle,
          project: liveInDesktop.project,
          directory: liveInDesktop.directory,
          lastActiveAt: liveInDesktop.lastActiveAt,
        },
        {
          status: "idle",
          name: "Desktop Title",
          appTitle: Option.some("Desktop Title"),
          project: PROJECT,
          directory: WORKTREE,
          lastActiveAt: new Date(DESKTOP_ACTIVITY).toISOString(),
        },
      );
      const [saved] = groupSources({
        live: [],
        desktop: [desktopSession({ sessionId: "local_live-again", isArchived: false })],
        history: [],
      });
      assert.ok(saved);
      assert.deepEqual(
        describeCatalogSession({
          group: saved,
          transcript: Option.none(),
          lastMessageAt: Option.none(),
          agentName: Option.none(),
        }).handle,
        ClaudeSavedSession.make({}),
      );
    }),
  ),
);
