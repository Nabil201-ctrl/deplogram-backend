/**
 * Persistence abstraction for the Deplogram backend.
 *
 * The default engine (`InMemoryDatabase`) keeps everything in Maps and is used
 * when no `DATABASE_URL` is provided. When `DATABASE_URL` is set (Postgres,
 * Supabase, Neon, …), `PostgresDatabase` takes over so data and sessions survive
 * deploys and cold starts.
 *
 * Every method is scoped to an authenticated user / workspace — there is no
 * shared singleton current user. The HTTP layer resolves the requesting user
 * from the session cookie on every request and passes it down.
 */
import type {
  AccountPreferences,
  AccountSettings,
  ActivityEvent,
  ActivityPage,
  ActivityType,
  ApiId,
  ApiKey,
  ApiRequest,
  ApiUsage,
  BuildLogLine,
  BuildStepId,
  CreatedApiKey,
  Deployment,
  DeploymentConfigSnapshot,
  DeploymentState,
  DeploymentTrigger,
  EnvVarRecord,
  GitBranch,
  GitConnection,
  GitDetection,
  GitRepository,
  NewApiKey,
  Project,
  ProjectEnvVar,
  ProjectSummary,
  RuntimeLogLevel,
  RuntimeLogSource,
  RuntimeLogLine,
  StorageItem,
  TrafficPoint,
  User,
  Viewer,
  WebhookEndpoint,
  WebhookRequest,
  Workspace,
} from '../types.js';
import {
  SecurityOverviewDto,
  SessionDto,
  TwoFactorSetupDto,
} from '../account/dto.js';

// ── CodePad domain types (distinct from the backend Deployment "Pad") ──────────

export interface CodePadFile {
  path: string;
  content: string;
  updatedAt: string;
}

export interface CodePad {
  id: string;
  name: string;
  runtime: string;
  entry: string;
  projectId: string | null;
  updatedAt: string;
  files: CodePadFile[];
}

export interface CodePadSummary {
  id: string;
  name: string;
  runtime: string;
  fileCount: number;
  paths: string[];
  updatedAt: string;
  projectId: string | null;
}

export interface SessionInfo {
  browser: string;
  os: string;
  device: 'desktop' | 'mobile';
  location: string | null;
  ip: string;
}

export interface AuthResult {
  viewer: Viewer;
  sessionToken: string;
}

export interface CodePadRunLogLine {
  n: number;
  at: string;
  text: string;
  stream: 'stdout' | 'stderr';
}

export interface CodePadRunLogs {
  lines: CodePadRunLogLine[];
  done: boolean;
  exitCode: number | null;
}

export interface GitInstallation {
  id: number;
  account: string;
  type: 'user' | 'organization';
  repositorySelection: 'all' | 'selected';
  repositories: number;
  installedAt: string;
  settingsUrl: string;
}

export interface GitConnectionResult {
  url: string;
}

export interface NotificationSettings {
  email: string;
  events: Record<string, boolean>;
  digest: 'off' | 'weekly';
}

export interface StorageList {
  path: string;
  items: StorageItem[];
  public: boolean;
  publicFrom: string | null;
}

export interface StorageUpload {
  uploadUrl: string;
}

export interface StorageLink {
  url: string;
  expiresAt: string;
}

export interface StoragePreview {
  url: string | null;
  text: string | null;
  truncated: boolean;
}

export interface UploadComplete {
  kind: 'file';
  name: string;
  path: string;
  size: number;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  public: boolean;
  publicUrl: string | null;
}

export interface RenameItemResult {
  kind: 'file' | 'folder';
  name: string;
  path: string;
  size: number;
  contentType: string | null;
  items: number | null;
  createdAt: string;
  updatedAt: string;
  thumbnailUrl: string | null;
  public: boolean;
  publicUrl: string | null;
}

export interface DeployPadResult {
  project: ProjectSummary;
  deployment: Deployment;
}

export abstract class Database {
  // ── auth & users ─────────────────────────────────────────────────────────────

  abstract findUserByEmail(email: string): Promise<User | undefined>;
  abstract getUser(id: string): Promise<User | undefined>;
  abstract signUp(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<AuthResult>;
  abstract signIn(email: string, password: string): Promise<Viewer>;
  abstract changePassword(userId: string, current: string, next: string): Promise<void>;
  abstract deleteAccount(userId: string): Promise<void>;

  // ── preferences / account settings ───────────────────────────────────────────

  abstract preferencesOf(userId: string): Promise<AccountPreferences>;
  abstract getAccountSettings(userId: string): Promise<AccountSettings>;
  abstract updateAccountSettings(userId: string, settings: AccountSettings): Promise<void>;

  // ── security / two-factor / notifications ────────────────────────────────────

  abstract getSecurityOverview(userId: string): Promise<SecurityOverviewDto>;
  abstract setupTwoFactor(userId: string): Promise<TwoFactorSetupDto>;
  abstract enableTwoFactor(userId: string, code: string): Promise<{ recoveryCodes: string[] }>;
  abstract disableTwoFactor(userId: string, code: string): Promise<void>;
  abstract newRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }>;

  abstract getNotificationSettings(userId: string): Promise<NotificationSettings>;
  abstract updateNotificationSettings(
    userId: string,
    update: { events?: Partial<Record<string, boolean>>; digest?: 'off' | 'weekly' },
  ): Promise<NotificationSettings>;

  // ── sessions ─────────────────────────────────────────────────────────────────

  abstract createSession(userId: string, info: SessionInfo): Promise<string>;
  abstract getSession(token: string): Promise<{ userId: string } | undefined>;
  abstract touchSession(token: string): Promise<void>;
  abstract getSessions(userId: string): Promise<SessionDto[]>;
  abstract endSession(token: string): Promise<boolean>;
  abstract endOtherSessions(currentSessionToken: string): Promise<void>;

  // ── workspaces ───────────────────────────────────────────────────────────────

  abstract currentWorkspace(userId: string): Promise<Workspace>;
  abstract getWorkspace(id: string): Promise<Workspace | undefined>;

  // ── projects ─────────────────────────────────────────────────────────────────

  abstract createProject(
    userId: string,
    input: {
      name: string;
      repositoryId: string;
      branch: string;
      runtime: string;
      config: {
        buildCommand: string | null;
        startCommand: string | null;
        port: number | null;
        rootDirectory: string | null;
      };
      env: { key: string; value: string }[];
    },
    id?: string,
  ): Promise<Project>;
  abstract getProject(id: string): Promise<Project | undefined>;
  abstract listProjects(workspaceId: string): Promise<Project[]>;
  abstract updateProject(
    id: string,
    update: {
      name?: string;
      branch?: string;
      config?: {
        buildCommand?: string | null;
        startCommand?: string | null;
        port?: number | null;
        rootDirectory?: string | null;
      };
    },
  ): Promise<Project | undefined>;
  abstract deleteProject(id: string): Promise<void>;
  abstract getEnvVars(projectId: string): Promise<EnvVarRecord[]>;
  abstract saveEnvVars(
    projectId: string,
    values: { key: string; value: string | null }[],
  ): Promise<EnvVarRecord[]>;

  // ── deployments ──────────────────────────────────────────────────────────────

  abstract createDeployment(
    projectId: string,
    options: {
      trigger: DeploymentTrigger;
      commitSha: string;
      commitMessage: string;
      author: { name: string; avatarUrl: string | null };
      createdAt?: string;
    },
    id?: string,
  ): Promise<Deployment>;
  abstract getDeployment(id: string): Promise<Deployment | undefined>;
  abstract deploymentsOfProject(projectId: string): Promise<Deployment[]>;
  abstract allDeployments(workspaceId: string): Promise<Deployment[]>;
  abstract latestDeployment(projectId: string): Promise<Deployment | undefined>;
  abstract markLive(projectId: string, deploymentId: string): Promise<void>;
  abstract rollbackTo(
    projectId: string,
    deploymentId: string,
  ): Promise<Deployment | undefined>;
  abstract finishDeployment(deploymentId: string, state: DeploymentState): Promise<void>;

  // ── logs ─────────────────────────────────────────────────────────────────────

  abstract appendBuildLog(
    deploymentId: string,
    entries: [BuildStepId, 'stdout' | 'stderr', string][],
  ): Promise<void>;
  abstract appendRuntimeLog(
    deploymentId: string,
    entries: [RuntimeLogLevel, RuntimeLogSource, string][],
  ): Promise<void>;
  abstract getBuildLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: BuildLogLine[]; end: number }>;
  abstract getRuntimeLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: RuntimeLogLine[]; end: number }>;

  // ── activity ─────────────────────────────────────────────────────────────────

  abstract recordActivity(
    actor: User | null,
    type: ActivityType,
    projectName: string,
    projectId: string | null,
    deploymentId: string | null,
    detail: string | null,
  ): Promise<void>;
  abstract activityPage(
    afterCursor: string | null,
    limit: number,
    workspaceId?: string,
  ): Promise<ActivityPage>;
  abstract recentActivity(limit: number): Promise<ActivityEvent[]>;

  // ── traffic / access log ─────────────────────────────────────────────────────

  abstract appendRequest(
    deployment: Deployment,
    error: boolean,
    city: string,
    status: number,
    latencyMs: number,
    path: string,
  ): Promise<void>;
  abstract getRequests(): Promise<TrafficPoint[]>;
  abstract requestsOfProject(projectId: string): Promise<TrafficPoint[]>;
  abstract getLiveDeployments(): Promise<Deployment[]>;

  // ── git ──────────────────────────────────────────────────────────────────────

  abstract getConnection(userId: string): Promise<GitConnection>;
  abstract getRepositories(userId: string, q?: string): Promise<GitRepository[]>;
  abstract getBranches(repositoryId: string): Promise<GitBranch[]>;
  abstract detect(repositoryId: string, branch: string): Promise<GitDetection>;
  abstract connectGit(userId: string): Promise<GitConnectionResult>;
  abstract disconnectGit(userId: string): Promise<void>;
  abstract getGitInstallations(userId: string): Promise<GitInstallation[]>;
  abstract githubAuthCallback(code: string, state: string): Promise<{ userId: string; account: string }>;

  // ── CodePad ──────────────────────────────────────────────────────────────────

  abstract listPads(userId: string): Promise<CodePadSummary[]>;
  abstract getPad(id: string): Promise<CodePad | undefined>;
  abstract createPad(
    userId: string,
    name: string,
    template: 'static' | 'node' | 'python',
  ): Promise<CodePad>;
  abstract updatePad(id: string, name: string): Promise<CodePad | undefined>;
  abstract deletePad(id: string): Promise<boolean>;
  abstract savePadFile(
    id: string,
    path: string,
    content: string,
  ): Promise<CodePadFile | undefined>;
  abstract renamePadFile(
    id: string,
    from: string,
    to: string,
  ): Promise<CodePad | 'exists' | undefined>;
  abstract deletePadFile(id: string, path: string): Promise<CodePad | undefined>;
  abstract startPadRun(id: string): Promise<string | undefined>;
  abstract getRunLogs(
    id: string,
    after: number,
  ): Promise<{
    lines: CodePadRunLogLine[];
    done: boolean;
    exitCode: number | null;
  } | undefined>;
  abstract deployPad(
    id: string,
  ): Promise<DeployPadResult | undefined>;

  // ── storage ──────────────────────────────────────────────────────────────────

  abstract getStorageList(
    path: string,
  ): Promise<{ path: string; items: StorageItem[]; public: boolean; publicFrom: string | null } | undefined>;
  abstract searchStorage(q: string): Promise<StorageItem[]>;
  abstract getStorageFolders(): Promise<string[]>;
  abstract createStorageFolder(
    path: string,
  ): Promise<StorageItem | 'exists' | 'no-parent'>;
  abstract completeStorageUpload(
    token: string,
    bytes: ArrayBuffer | null,
  ): Promise<StorageItem | undefined>;
  abstract createStorageUpload(
    path: string,
    size: number,
    contentType: string,
  ): Promise<{ uploadUrl: string } | undefined>;
  abstract renameStorageItem(
    path: string,
    name: string,
    makePublic?: boolean,
  ): Promise<StorageItem | null | 'exists' | 'missing'>;
  abstract moveStorageItems(paths: string[], to: string): Promise<number | 'bad-target'>;
  abstract deleteStorageItems(paths: string[]): Promise<{ deleted: number; freed: number }>;
  abstract previewStorage(
    path: string,
  ): Promise<{ url: string | null; text: string | null; truncated: boolean } | undefined>;
  abstract createStorageLink(
    path: string,
    expiresIn: '1h' | '1d' | '7d',
  ): Promise<{ url: string; expiresAt: string } | undefined>;

  // ── webhooks ─────────────────────────────────────────────────────────────────

  abstract getWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint | null>;
  abstract rotateWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint>;
  abstract listWebhookRequests(workspaceId: string): Promise<WebhookRequest[]>;
  abstract clearWebhookRequests(workspaceId: string): Promise<void>;
  abstract captureWebhookRequest(
    workspaceId: string,
    request: Omit<WebhookRequest, 'id' | 'receivedAt'>,
  ): Promise<WebhookRequest>;
  abstract getWebhookRequest(id: string): Promise<WebhookRequest | undefined>;

  // ── APIs ─────────────────────────────────────────────────────────────────────

  abstract listApiKeys(userId: string): Promise<ApiKey[]>;
  abstract createApiKey(userId: string, input: NewApiKey): Promise<CreatedApiKey>;
  abstract revokeApiKey(id: string): Promise<boolean>;
  abstract getApiUsage(): Promise<ApiUsage>;
  abstract listApiRequests(api?: ApiId): Promise<ApiRequest[]>;
  abstract tryApi(
    request: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> },
  ): Promise<{ status: number; durationMs: number; body: unknown }>;
}
