import { isDeepStrictEqual } from "node:util";

import { Effect, FileSystem, Option, Predicate, Schema } from "effect";

import { CodexDefaultPermissionsUnreadable } from "./errors.ts";
import { appServerCommand, askAppServer } from "./read-app-server-defaults.ts";
import type {
  AppServerConfig,
  AppServerRequirements,
  ApprovalPolicy,
  PermissionProfile,
} from "./read-app-server-defaults.ts";

export const FULL_ACCESS = {
  profile: ":danger-full-access",
  sandbox: "danger-full-access",
  approvalPolicy: "never",
} as const;

const READ_ONLY = { profile: ":read-only", sandbox: "read-only" } as const;

const WORKSPACE = { profile: ":workspace", sandbox: "workspace-write" } as const;

const ON_REQUEST = "on-request";

const USER_REVIEWER = "user";

const GUARDIAN_REVIEWERS: ReadonlySet<string> = new Set(["auto_review", "guardian_subagent"]);

const GUARDIAN_SUBAGENT = "guardian_subagent";

const GUARDIAN_FEATURE = "guardian_approval";

const PROJECTLESS = "projectless";

const GRANULAR_APPROVAL = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: true,
  },
} as const;

const MODEL_PROVIDER = /^[A-Za-z0-9_-]+$/u;

const PermissionSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent-mode"), agentMode: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("profile"), profileId: Schema.String }),
  Schema.Struct({ kind: Schema.Literals(["custom", "server-default"]) }),
]);

const PERMISSION_SELECTION_KEY = "permission-selection-by-host-id:local";

const DesktopState = Schema.fromJsonString(
  Schema.Struct({
    "electron-persisted-atom-state": Schema.optional(
      Schema.Struct({ [PERMISSION_SELECTION_KEY]: Schema.optional(PermissionSelection) }),
    ),
  }),
);

const AGENT_MODES = [
  {
    agentMode: "read-only",
    profile: READ_ONLY.profile,
    approvalPolicy: ON_REQUEST,
    reviewer: USER_REVIEWER,
  },
  {
    agentMode: "auto",
    profile: WORKSPACE.profile,
    approvalPolicy: ON_REQUEST,
    reviewer: USER_REVIEWER,
  },
  {
    agentMode: "granular",
    profile: WORKSPACE.profile,
    approvalPolicy: GRANULAR_APPROVAL,
    reviewer: USER_REVIEWER,
  },
  {
    agentMode: "guardian-approvals",
    profile: WORKSPACE.profile,
    approvalPolicy: ON_REQUEST,
    reviewer: GUARDIAN_SUBAGENT,
  },
  {
    agentMode: "full-access",
    profile: FULL_ACCESS.profile,
    approvalPolicy: FULL_ACCESS.approvalPolicy,
    reviewer: USER_REVIEWER,
  },
] as const;

const SANDBOX_PROFILES = new Map<string, string>([
  [READ_ONLY.sandbox, READ_ONLY.profile],
  [WORKSPACE.sandbox, WORKSPACE.profile],
  [FULL_ACCESS.sandbox, FULL_ACCESS.profile],
]);

const agentMode = (
  mode: (typeof AGENT_MODES)[number]["agentMode"],
): typeof PermissionSelection.Type => ({ kind: "agent-mode", agentMode: mode });

const isGuardianReviewer = (reviewer: string) => GUARDIAN_REVIEWERS.has(reviewer);

const isReviewerAllowed = (allowed: readonly string[] | null | undefined, reviewer: string) => {
  if (Predicate.isNullish(allowed)) {
    return true;
  }
  const isGuardianAllowed =
    isGuardianReviewer(reviewer) && allowed.some((known) => isGuardianReviewer(known));
  return allowed.includes(reviewer) || isGuardianAllowed;
};

const isApprovalAllowed = (
  requirements: typeof AppServerRequirements.Type | null,
  approval: typeof ApprovalPolicy.Type,
) => {
  const allowed = requirements?.allowedApprovalPolicies;
  if (Predicate.isNullish(allowed)) {
    return true;
  }
  return allowed.some((policy) => isDeepStrictEqual(policy, approval));
};

const readGuardianFeature = (config: typeof AppServerConfig.Type) => {
  const flat = config["features.guardian_approval"];
  const nested = config.features?.[GUARDIAN_FEATURE];
  return Option.orElse(Option.liftPredicate(flat, Predicate.isBoolean), () =>
    Option.liftPredicate(nested, Predicate.isBoolean),
  );
};

const isGuardianTurnedOff = (config: typeof AppServerConfig.Type) =>
  Option.contains(readGuardianFeature(config), false);

const isAllowedProfile = (
  profiles: readonly (typeof PermissionProfile.Type)[],
  id: string | undefined,
) => profiles.some((profile) => profile.allowed && profile.id === id);

const configuredReviewer = (config: typeof AppServerConfig.Type) => {
  const reviewer = config.approvals_reviewer ?? "";
  const isKnown = reviewer === USER_REVIEWER || isGuardianReviewer(reviewer);
  const isTurnedOff = reviewer === GUARDIAN_SUBAGENT && isGuardianTurnedOff(config);
  const isUsable = isKnown && !isTurnedOff;
  return isUsable ? reviewer : USER_REVIEWER;
};

const isPlainWorkspace = (config: typeof AppServerConfig.Type) => {
  const workspace = config.sandbox_workspace_write;
  const hasNetwork = workspace?.network_access ?? false;
  const excludesTemporary =
    (workspace?.exclude_slash_tmp ?? false) || (workspace?.exclude_tmpdir_env_var ?? false);
  return !hasNetwork && !excludesTemporary;
};

const configuredPermissions = (config: typeof AppServerConfig.Type) => {
  const reviewer = configuredReviewer(config);
  const sandbox = config.sandbox_mode ?? READ_ONLY.sandbox;
  const isFullAccess = sandbox === FULL_ACCESS.sandbox;
  const isKnownSandbox =
    isFullAccess || sandbox === WORKSPACE.sandbox || sandbox === READ_ONLY.sandbox;
  const unsetApproval = isFullAccess ? FULL_ACCESS.approvalPolicy : ON_REQUEST;
  return isKnownSandbox
    ? Option.some({ sandbox, approval: config.approval_policy ?? unsetApproval, reviewer })
    : Option.none();
};

const modeOfPermissions = ({
  config,
  sandbox,
  approval,
  reviewer,
}: {
  readonly config: typeof AppServerConfig.Type;
  readonly sandbox: string;
  readonly approval: typeof ApprovalPolicy.Type;
  readonly reviewer: string;
}) => {
  const isOnRequest = approval === ON_REQUEST;
  const isWorkspace = sandbox === WORKSPACE.sandbox && isPlainWorkspace(config);
  const isReadOnlyOnRequest = sandbox === READ_ONLY.sandbox && isOnRequest;
  const isGranular =
    isWorkspace && isDeepStrictEqual(approval, GRANULAR_APPROVAL) && reviewer === USER_REVIEWER;
  const isWorkspaceOnRequest = isWorkspace && isOnRequest;
  const isFullAccess = sandbox === FULL_ACCESS.sandbox && approval === FULL_ACCESS.approvalPolicy;
  if (isReadOnlyOnRequest) {
    return Option.some("read-only" as const);
  }
  if (isGranular) {
    return Option.some("granular" as const);
  }
  if (isWorkspaceOnRequest) {
    return Option.some(isGuardianReviewer(reviewer) ? "guardian-approvals" : "auto");
  }
  return isFullAccess ? Option.some("full-access" as const) : Option.none();
};

const agentModeOfConfig = (config: typeof AppServerConfig.Type) =>
  Option.flatMap(configuredPermissions(config), (permissions) =>
    Option.flatMap(modeOfPermissions({ config, ...permissions }), (mode) => {
      const entry = AGENT_MODES.find((known) => known.agentMode === mode);
      const isSameReviewer =
        entry?.reviewer === permissions.reviewer ||
        (isGuardianReviewer(entry?.reviewer ?? "") && isGuardianReviewer(permissions.reviewer));
      const isSameApproval = isDeepStrictEqual(entry?.approvalPolicy, permissions.approval);
      const isSameMode = isSameReviewer && isSameApproval;
      return isSameMode ? Option.some(mode) : Option.none();
    }),
  );

const isCustomOffered = ({
  config,
  profiles,
  requirements,
  offered,
}: {
  readonly config: typeof AppServerConfig.Type;
  readonly profiles: readonly (typeof PermissionProfile.Type)[];
  readonly requirements: typeof AppServerRequirements.Type | null;
  readonly offered: readonly (typeof AGENT_MODES)[number][];
}) => {
  const approval = Option.fromNullishOr(config.approval_policy);
  const reviewer = Option.fromNullishOr(config.approvals_reviewer);
  const sandbox = Option.fromNullishOr(config.sandbox_mode);
  const isUnset = Option.isNone(approval) && Option.isNone(reviewer) && Option.isNone(sandbox);
  const isSandboxRefused = Option.exists(
    sandbox,
    (mode) => !isAllowedProfile(profiles, SANDBOX_PROFILES.get(mode)),
  );
  const isApprovalRefused = Option.exists(
    approval,
    (policy) => !isApprovalAllowed(requirements, policy),
  );
  const isReviewerRefused = Option.exists(
    reviewer,
    (configured) => !isReviewerAllowed(requirements?.allowedApprovalsReviewers, configured),
  );
  const isRefused = isUnset || isSandboxRefused || isApprovalRefused || isReviewerRefused;
  if (isRefused) {
    return false;
  }
  return Option.match(agentModeOfConfig(config), {
    onNone: () => true,
    onSome: (mode) => !offered.some((entry) => entry.agentMode === mode),
  });
};

const isModeOffered = ({
  entry,
  config,
  profiles,
  requirements,
  isGuardianRequired,
  workspaceMode,
}: {
  readonly entry: (typeof AGENT_MODES)[number];
  readonly config: typeof AppServerConfig.Type;
  readonly profiles: readonly (typeof PermissionProfile.Type)[];
  readonly requirements: typeof AppServerRequirements.Type | null;
  readonly isGuardianRequired: boolean;
  readonly workspaceMode: string;
}) => {
  const isPermitted =
    isAllowedProfile(profiles, entry.profile) &&
    isApprovalAllowed(requirements, entry.approvalPolicy) &&
    isReviewerAllowed(requirements?.allowedApprovalsReviewers, entry.reviewer);
  const isGuardianHidden =
    entry.agentMode === "guardian-approvals" && !isGuardianRequired && isGuardianTurnedOff(config);
  const isOtherWorkspaceMode =
    (entry.agentMode === "auto" || entry.agentMode === "granular") &&
    entry.agentMode !== workspaceMode;
  return isPermitted && !isGuardianHidden && !isOtherWorkspaceMode;
};

const listAvailable = ({
  config,
  profiles,
  requirements,
  isGuardianRequired,
  workspaceKind,
}: {
  readonly config: typeof AppServerConfig.Type;
  readonly profiles: readonly (typeof PermissionProfile.Type)[];
  readonly requirements: typeof AppServerRequirements.Type | null;
  readonly isGuardianRequired: boolean;
  readonly workspaceKind: string;
}): readonly (typeof PermissionSelection.Type)[] => {
  const workspaceMode = workspaceKind === PROJECTLESS ? "granular" : "auto";
  const offered = AGENT_MODES.filter((entry) =>
    isModeOffered({ entry, config, profiles, requirements, isGuardianRequired, workspaceMode }),
  );
  const customProfiles = profiles
    .filter((profile) => profile.allowed && !profile.id.startsWith(":"))
    .map((profile): typeof PermissionSelection.Type => ({
      kind: "profile",
      profileId: profile.id,
    }));
  const isCustom =
    customProfiles.length === 0 && isCustomOffered({ config, profiles, requirements, offered });
  const custom = (isCustom ? (["custom"] as const) : []).map(
    (kind): typeof PermissionSelection.Type => ({ kind }),
  );
  const all = [...offered.map((entry) => agentMode(entry.agentMode)), ...custom, ...customProfiles];
  return all.length > 0 ? all : [{ kind: "server-default" }];
};

const isWorkspaceMode = (selection: typeof PermissionSelection.Type) =>
  selection.kind === "agent-mode" &&
  (selection.agentMode === "auto" || selection.agentMode === "granular");

const findMode = (
  available: readonly (typeof PermissionSelection.Type)[],
  mode: (typeof AGENT_MODES)[number]["agentMode"],
) =>
  Option.fromNullishOr(
    available.find((selection) => isDeepStrictEqual(selection, agentMode(mode))),
  );

const normalize = ({
  available,
  selection,
  workspaceKind,
}: {
  readonly available: readonly (typeof PermissionSelection.Type)[];
  readonly selection: Option.Option<typeof PermissionSelection.Type>;
  readonly workspaceKind: string;
}) =>
  Option.flatMap(selection, (chosen) => {
    const wanted = isWorkspaceMode(chosen)
      ? agentMode(workspaceKind === PROJECTLESS ? "granular" : "auto")
      : chosen;
    return Option.fromNullishOr(available.find((offered) => isDeepStrictEqual(offered, wanted)));
  });

const modelName = (model: string) => {
  const slash = model.indexOf("/");
  if (slash === -1) {
    return Option.some(model);
  }
  const provider = model.slice(0, slash);
  const name = model.slice(slash + 1);
  const isUsable = MODEL_PROVIDER.test(provider) && !name.includes("/");
  return isUsable ? Option.some(name) : Option.none();
};

const requiresGuardian = (
  requirements: typeof AppServerRequirements.Type | null,
  model: Option.Option<string>,
) => {
  const models = requirements?.autoReview?.requiredOnModels ?? [];
  return Option.exists(Option.flatMap(model, modelName), (name) => models.includes(name));
};

const selectionOfProfile = (profileId: string): typeof PermissionSelection.Type => {
  if (profileId === READ_ONLY.profile) {
    return agentMode("read-only");
  }
  if (profileId === WORKSPACE.profile) {
    return agentMode("auto");
  }
  return profileId === FULL_ACCESS.profile
    ? agentMode("full-access")
    : { kind: "profile", profileId };
};

const findDefaultProfile = ({
  config,
  profiles,
  requirements,
}: {
  readonly config: typeof AppServerConfig.Type;
  readonly profiles: readonly (typeof PermissionProfile.Type)[];
  readonly requirements: typeof AppServerRequirements.Type | null;
}) => {
  const allowed = requirements?.allowedPermissionProfiles;
  const isRequiredAllowed = (id: string) => Predicate.isNullish(allowed) || allowed[id] === true;
  const usable = profiles.filter((profile) => profile.allowed && isRequiredAllowed(profile.id));
  const isUsable = (id: string) => usable.some((profile) => profile.id === id);
  const configured = Option.filter(Option.fromNullishOr(config.default_permissions), isUsable);
  const isWorkspaceFallback =
    allowed?.[READ_ONLY.profile] === true && allowed[WORKSPACE.profile] === true;
  const wanted = Option.orElse(
    Option.orElse(Option.fromNullishOr(requirements?.defaultPermissions), () => configured),
    () => (isWorkspaceFallback ? Option.some(WORKSPACE.profile) : Option.none()),
  );
  return Option.filter(wanted, isUsable);
};

const isSelectionFullAccess = ({
  selection,
  config,
}: {
  readonly selection: typeof PermissionSelection.Type;
  readonly config: typeof AppServerConfig.Type;
}) => {
  if (selection.kind === "agent-mode") {
    return selection.agentMode === "full-access";
  }
  if (selection.kind === "custom") {
    return Option.exists(
      configuredPermissions(config),
      (permissions) =>
        permissions.sandbox === FULL_ACCESS.sandbox &&
        permissions.approval === FULL_ACCESS.approvalPolicy,
    );
  }
  const isConfiguredFullAccess =
    config.sandbox_mode === FULL_ACCESS.sandbox &&
    config.approval_policy === FULL_ACCESS.approvalPolicy;
  return selection.kind === "server-default" && isConfiguredFullAccess;
};

const describeSelection = (selection: typeof PermissionSelection.Type) => {
  if (selection.kind === "agent-mode") {
    return selection.agentMode;
  }
  return selection.kind === "profile" ? selection.profileId : selection.kind;
};

const resolveDefaultSelection = ({
  config,
  requirements,
  profiles,
  saved,
  model,
  workspaceKind,
}: {
  readonly config: typeof AppServerConfig.Type;
  readonly requirements: typeof AppServerRequirements.Type | null;
  readonly profiles: readonly (typeof PermissionProfile.Type)[];
  readonly saved: Option.Option<typeof PermissionSelection.Type>;
  readonly model: Option.Option<string>;
  readonly workspaceKind: string;
}) => {
  const isGuardianRequired = requiresGuardian(
    requirements,
    Option.orElse(model, () => Option.fromNullishOr(config.model)),
  );
  const listed = listAvailable({
    config,
    profiles,
    requirements,
    isGuardianRequired,
    workspaceKind,
  });
  const required = normalize({
    available: listed,
    selection: isGuardianRequired ? Option.some(agentMode("guardian-approvals")) : Option.none(),
    workspaceKind,
  });
  const workspace = listed.find((selection) => isWorkspaceMode(selection));
  const available =
    workspace === undefined
      ? listed
      : [
          workspace,
          ...listed.filter(
            (selection) =>
              selection.kind !== "agent-mode" ||
              !["read-only", describeSelection(workspace)].includes(selection.agentMode),
          ),
        ];
  const from = (
    source: "configured" | "fallback" | "required" | "saved",
    selection: Option.Option<typeof PermissionSelection.Type>,
  ) => Option.map(selection, (found) => ({ source, selection: found }));
  const configured = Option.map(
    findDefaultProfile({ config, profiles, requirements }),
    selectionOfProfile,
  );
  const chosen = Option.getOrElse(
    Option.firstSomeOf([
      from("required", required),
      from("saved", normalize({ available, selection: saved, workspaceKind })),
      from("configured", normalize({ available, selection: configured, workspaceKind })),
      from("fallback", findMode(available, "guardian-approvals")),
      from("fallback", Option.fromNullishOr(available.find((item) => isWorkspaceMode(item)))),
      from("fallback", Option.fromNullishOr(available.find((item) => item.kind === "profile"))),
      from("fallback", findMode(available, "read-only")),
      from("fallback", findMode(available, "full-access")),
    ]),
    () => ({ source: "fallback" as const, selection: { kind: "server-default" as const } }),
  );
  return {
    ...chosen,
    isFullAccess: isSelectionFullAccess({ selection: chosen.selection, config }),
  };
};

const readSavedSelection = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    );
    if (Option.isNone(text)) {
      return Option.none<typeof PermissionSelection.Type>();
    }
    const state = yield* Schema.decodeEffect(DesktopState)(text.value).pipe(
      Effect.mapError(
        (error) => new CodexDefaultPermissionsUnreadable({ path, reason: error.message }),
      ),
    );
    return Option.fromNullishOr(state["electron-persisted-atom-state"]?.[PERMISSION_SELECTION_KEY]);
  });

export const resolveDefaultPermissions = Effect.fn("codex.readDefaultPermissions")(function* ({
  root,
  directory,
  model,
  workspaceKind,
  appServer,
}: {
  readonly root: string;
  readonly directory: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly workspaceKind: "project" | "projectless";
  readonly appServer: readonly [string, ...string[]];
}) {
  const saved = yield* readSavedSelection(`${root}/.codex-global-state.json`);
  const defaults = yield* askAppServer({ command: appServer, directory });
  const resolved = resolveDefaultSelection({ ...defaults, saved, model, workspaceKind });
  yield* Effect.annotateCurrentSpan({
    "nudge.codex.permission.source": resolved.source,
    "nudge.codex.permission.selection": describeSelection(resolved.selection),
    "nudge.codex.permission.saved": Option.match(saved, {
      onNone: () => "none",
      onSome: describeSelection,
    }),
    "nudge.codex.permission.workspaceKind": workspaceKind,
    "nudge.codex.permission.fullAccess": resolved.isFullAccess,
  });
  return resolved;
});

export const readDefaultPermissions = (
  options: Omit<Parameters<typeof resolveDefaultPermissions>[0], "appServer">,
) =>
  Effect.flatMap(appServerCommand, (appServer) =>
    resolveDefaultPermissions({ ...options, appServer }),
  );
