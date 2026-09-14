export type AgentIdentity = {
  readonly provider: "claude" | "codex"
  readonly id: string
  readonly name: string
}

export function chooseSourceIdentity(options: {
  readonly claudeTargets: readonly (AgentIdentity & { readonly pid: number })[]
  readonly ancestorPids: readonly number[]
  readonly codexThreadId?: string
  readonly codexThreads: readonly AgentIdentity[]
}): AgentIdentity | null {
  for (const pid of options.ancestorPids) {
    const claude = options.claudeTargets.find((target) => target.pid === pid)
    if (claude !== undefined) {
      return { provider: claude.provider, id: claude.id, name: claude.name }
    }
  }

  const codexThreadId = options.codexThreadId?.trim()
  if (!codexThreadId) return null
  return (
    options.codexThreads.find((thread) => thread.id === codexThreadId) ?? {
      provider: "codex",
      id: codexThreadId,
      name: codexThreadId
    }
  )
}

export function peerMessage(message: string, source: AgentIdentity | null): string {
  const body = codexMessage(message, source).replace(
    /<\/cross-session-message/giu,
    "<\\/cross-session-message"
  )
  const attributes =
    source?.provider === "claude"
      ? ` from-session="${escapeAttribute(source.id)}" from-name="${escapeAttribute(source.name.replace(/\s+/gu, " ").trim())}"`
      : ""
  return `<cross-session-message${attributes}>\n${body}\n</cross-session-message>`
}

export function codexMessage(message: string, source: AgentIdentity | null): string {
  if (source === null) return `Message via nudge CLI:\n\n${message}`
  const name = source.name.replace(/[\s"]+/gu, " ").trim()
  const sender = source.provider === "codex" ? "Codex task" : "Claude session"
  return `Message from ${sender} "${name}" (${source.id}) via nudge CLI:\n\n${message}`
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\t", "&#9;")
}
