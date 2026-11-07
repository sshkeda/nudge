import { Effect, Option, Schema } from "effect";

import { Claude } from "../lib/claude/index.ts";
import { Codex } from "../lib/codex/index.ts";
import { Sender } from "../shared/message-envelope.ts";
import { Output } from "../shared/output.ts";
import { CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID } from "../shared/read-environment.ts";
import { messageOf, prose, Report } from "../shared/report.ts";
import { runCommand } from "../shared/run-command.ts";
import { hasControlCharacters } from "../shared/session.ts";

const PROCESS_PARENT_AND_COMMAND = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+(?<command>.*)$/u;

const CODEX_COMMAND = "codex";

class SenderUnknown extends Schema.TaggedError<SenderUnknown>()("SenderUnknown", {}) {
  public readonly report = new Report({
    message: prose`couldn't tell which session is sending, so the receiver can't reply with nudge`,
  });

  public override get message() {
    return messageOf(this.report);
  }
}

const readAncestorProcesses = Effect.gen(function* () {
  const processes = new Map<number, { readonly parent: number; readonly command: string }>();
  for (const line of (yield* runCommand("ps", ["-axo", "pid=,ppid=,comm="])).split("\n")) {
    const { pid, parent, command } = PROCESS_PARENT_AND_COMMAND.exec(line)?.groups ?? {};
    const isProcessLine = pid !== undefined && parent !== undefined && command !== undefined;
    if (isProcessLine) {
      processes.set(Number(pid), {
        parent: Number(parent),
        command: command.trim().split("/").at(-1) ?? "",
      });
    }
  }
  const climb = (
    pid: number,
    seen: ReadonlySet<number>,
  ): readonly { readonly pid: number; readonly command: string }[] => {
    const found = processes.get(pid);
    const isEndOfChain = pid <= 0 || seen.has(pid) || found === undefined;
    return isEndOfChain
      ? []
      : [{ pid, command: found.command }, ...climb(found.parent, new Set([...seen, pid]))];
  };
  return climb(process.ppid, new Set());
});

const findCodexSender = (threadId: string) =>
  Effect.gen(function* () {
    const reply = yield* (yield* Codex).findReplyThread(threadId);
    return Option.map(reply, ({ id, name }) => Sender.make({ provider: "Codex", id, name }));
  });

const chooseSender = Effect.gen(function* () {
  const codexThreadId = Option.filter(
    yield* CODEX_THREAD_ID,
    (threadId) => !hasControlCharacters(threadId),
  );
  const ancestors = yield* readAncestorProcesses;
  const claudeInChain = yield* (yield* Claude).findSessionRunningIn(
    ancestors.map(({ pid }) => pid),
  );
  const claudePosition = Option.map(claudeInChain, ({ pid }) =>
    ancestors.findIndex((ancestor) => ancestor.pid === pid),
  );
  const codexPosition = Option.filter(
    Option.some(ancestors.findIndex(({ command }) => command === CODEX_COMMAND)),
    (position) => position >= 0,
  );
  const isClaudeNearer =
    Option.isSome(claudePosition) &&
    (Option.isNone(codexPosition) || claudePosition.value < codexPosition.value);
  const isCodexThreadInChain = Option.isSome(codexPosition) && Option.isSome(codexThreadId);
  yield* Effect.annotateCurrentSpan({
    "nudge.sender.ancestor.count": ancestors.length,
    "nudge.sender.reason": isClaudeNearer ? "nearest-claude-ancestor" : "no-session-ancestor",
  });
  if (isClaudeNearer) {
    return Option.map(claudeInChain, ({ id, name }) =>
      Sender.make({ provider: "Claude", id, name }),
    );
  }
  if (isCodexThreadInChain) {
    yield* Effect.annotateCurrentSpan("nudge.sender.reason", "codex-ancestor-and-thread-id");
    return yield* findCodexSender(codexThreadId.value);
  }
  return Option.none();
});

export const findSender = Effect.gen(function* () {
  const sender = yield* chooseSender;
  const runsInASession =
    Option.isSome(yield* CODEX_THREAD_ID) || Option.isSome(yield* CLAUDE_CODE_SESSION_ID);
  const isUnknownInASession = runsInASession && Option.isNone(sender);
  if (isUnknownInASession) {
    yield* (yield* Output).warn(new SenderUnknown());
  }
  yield* Effect.annotateCurrentSpan("nudge.sender.unknownInSession", isUnknownInASession);
  yield* Effect.annotateCurrentSpan(
    Option.match(sender, {
      onNone: () => ({ "nudge.sender.provider": "none" }),
      onSome: ({ provider, id }) => ({
        "nudge.sender.provider": provider,
        "nudge.sender.id": id,
      }),
    }),
  );
  return sender;
});
