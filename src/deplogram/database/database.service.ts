/**
 * `DatabaseService` is the single persistence entry point used by every feature
 * service and controller. It delegates to either the in-memory engine (default,
 * used locally and in tests) or the Postgres engine when `DATABASE_URL` is set
 * (Postgres, Supabase, Neon, …), so data and sessions survive deploys and cold
 * starts.
 *
 * There is no shared singleton current user: every method takes an explicit
 * `userId` / `workspaceId`, and the HTTP layer resolves the requesting user from
 * the session cookie on each request.
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';

import { Database } from './database.js';
import { InMemoryDatabase } from './in-memory-database.js';
import { PostgresDatabase } from './postgres-database.js';

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database;

  constructor() {
    this.db = process.env.DATABASE_URL ? new PostgresDatabase(process.env.DATABASE_URL) : new InMemoryDatabase();
  }

  async onModuleInit(): Promise<void> {
    if (this.db instanceof PostgresDatabase) {
      await this.db.connect();
    }
  }

  /** The engine currently in use, for tests that need to inspect state. */
  get engine(): Database {
    return this.db;
  }

  /** Raw access to the in-memory engine (tests only). */
  get inMemory(): InMemoryDatabase {
    if (!(this.db instanceof InMemoryDatabase)) {
      throw new Error('in-memory engine is not active');
    }
    return this.db;
  }

  // ── auth & users ─────────────────────────────────────────────────────────────

  findUserByEmail(email: string): Promise<import('../types.js').User | undefined> {
    return this.db.findUserByEmail(email);
  }
  getUser(id: string): Promise<import('../types.js').User | undefined> {
    return this.db.getUser(id);
  }
  signUp(input: { name: string; email: string; password: string }): Promise<import('./database.js').AuthResult> {
    return this.db.signUp(input);
  }
  signIn(email: string, password: string): Promise<import('../types.js').Viewer> {
    return this.db.signIn(email, password);
  }
  changePassword(userId: string, current: string, next: string): Promise<void> {
    return this.db.changePassword(userId, current, next);
  }
  deleteAccount(userId: string): Promise<void> {
    return this.db.deleteAccount(userId);
  }

  // ── preferences / account settings ───────────────────────────────────────────

  preferencesOf(userId: string): Promise<import('../types.js').AccountPreferences> {
    return this.db.preferencesOf(userId);
  }
  getAccountSettings(userId: string): Promise<import('../types.js').AccountSettings> {
    return this.db.getAccountSettings(userId);
  }
  updateAccountSettings(userId: string, settings: import('../types.js').AccountSettings): Promise<void> {
    return this.db.updateAccountSettings(userId, settings);
  }

  // ── security / two-factor / notifications ────────────────────────────────────

  getSecurityOverview(userId: string): Promise<import('../account/dto.js').SecurityOverviewDto> {
    return this.db.getSecurityOverview(userId);
  }
  setupTwoFactor(userId: string): Promise<import('../account/dto.js').TwoFactorSetupDto> {
    return this.db.setupTwoFactor(userId);
  }
  enableTwoFactor(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    return this.db.enableTwoFactor(userId, code);
  }
  disableTwoFactor(userId: string, code: string): Promise<void> {
    return this.db.disableTwoFactor(userId, code);
  }
  newRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
    return this.db.newRecoveryCodes(userId);
  }
  getNotificationSettings(userId: string): Promise<{
    email: string;
    events: Record<string, boolean>;
    digest: 'off' | 'weekly';
  }> {
    return this.db.getNotificationSettings(userId);
  }
  updateNotificationSettings(
    userId: string,
    update: { events?: Partial<Record<string, boolean>>; digest?: 'off' | 'weekly' },
  ): Promise<{
    email: string;
    events: Record<string, boolean>;
    digest: 'off' | 'weekly';
  }> {
    return this.db.updateNotificationSettings(userId, update);
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  createSession(userId: string, info: import('./database.js').SessionInfo): Promise<string> {
    return this.db.createSession(userId, info);
  }
  getSession(token: string): Promise<{ userId: string } | undefined> {
    return this.db.getSession(token);
  }
  touchSession(token: string): Promise<void> {
    return this.db.touchSession(token);
  }
  getSessions(userId: string): Promise<import('../account/dto.js').SessionDto[]> {
    return this.db.getSessions(userId);
  }
  endSession(token: string): Promise<boolean> {
    return this.db.endSession(token);
  }
  endOtherSessions(currentSessionToken: string): Promise<void> {
    return this.db.endOtherSessions(currentSessionToken);
  }

  // ── workspaces ───────────────────────────────────────────────────────────────

  currentWorkspace(userId: string): Promise<import('../types.js').Workspace> {
    return this.db.currentWorkspace(userId);
  }
  getWorkspace(id: string): Promise<import('../types.js').Workspace | undefined> {
    return this.db.getWorkspace(id);
  }

  // ── projects ─────────────────────────────────────────────────────────────────

  createProject(
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
  ): Promise<import('../types.js').Project> {
    return this.db.createProject(userId, input, id);
  }
  getProject(id: string): Promise<import('../types.js').Project | undefined> {
    return this.db.getProject(id);
  }
  listProjects(workspaceId: string): Promise<import('../types.js').Project[]> {
    return this.db.listProjects(workspaceId);
  }
  updateProject(
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
  ): Promise<import('../types.js').Project | undefined> {
    return this.db.updateProject(id, update);
  }
  deleteProject(id: string): Promise<void> {
    return this.db.deleteProject(id);
  }
  getEnvVars(projectId: string): Promise<import('../types.js').EnvVarRecord[]> {
    return this.db.getEnvVars(projectId);
  }
  saveEnvVars(
    projectId: string,
    values: { key: string; value: string | null }[],
  ): Promise<import('../types.js').EnvVarRecord[]> {
    return this.db.saveEnvVars(projectId, values);
  }

  // ── deployments ──────────────────────────────────────────────────────────────

  createDeployment(
    projectId: string,
    options: {
      trigger: import('../types.js').DeploymentTrigger;
      commitSha: string;
      commitMessage: string;
      author: { name: string; avatarUrl: string | null };
      createdAt?: string;
    },
    id?: string,
  ): Promise<import('../types.js').Deployment> {
    return this.db.createDeployment(projectId, options, id);
  }
  getDeployment(id: string): Promise<import('../types.js').Deployment | undefined> {
    return this.db.getDeployment(id);
  }
  deploymentsOfProject(projectId: string): Promise<import('../types.js').Deployment[]> {
    return this.db.deploymentsOfProject(projectId);
  }
  allDeployments(workspaceId: string): Promise<import('../types.js').Deployment[]> {
    return this.db.allDeployments(workspaceId);
  }
  latestDeployment(projectId: string): Promise<import('../types.js').Deployment | undefined> {
    return this.db.latestDeployment(projectId);
  }
  markLive(projectId: string, deploymentId: string): Promise<void> {
    return this.db.markLive(projectId, deploymentId);
  }
  rollbackTo(projectId: string, deploymentId: string): Promise<import('../types.js').Deployment | undefined> {
    return this.db.rollbackTo(projectId, deploymentId);
  }
  finishDeployment(deploymentId: string, state: import('../types.js').DeploymentState): Promise<void> {
    return this.db.finishDeployment(deploymentId, state);
  }

  // ── logs ─────────────────────────────────────────────────────────────────────

  appendBuildLog(
    deploymentId: string,
    entries: [import('../types.js').BuildStepId, 'stdout' | 'stderr', string][],
  ): Promise<void> {
    return this.db.appendBuildLog(deploymentId, entries);
  }
  appendRuntimeLog(
    deploymentId: string,
    entries: [import('../types.js').RuntimeLogLevel, import('../types.js').RuntimeLogSource, string][],
  ): Promise<void> {
    return this.db.appendRuntimeLog(deploymentId, entries);
  }
  getBuildLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: import('../types.js').BuildLogLine[]; end: number }> {
    return this.db.getBuildLog(deploymentId, after);
  }
  getRuntimeLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: import('../types.js').RuntimeLogLine[]; end: number }> {
    return this.db.getRuntimeLog(deploymentId, after);
  }

  // ── activity ─────────────────────────────────────────────────────────────────

  recordActivity(
    actor: import('../types.js').User | null,
    type: import('../types.js').ActivityType,
    projectName: string,
    projectId: string | null,
    deploymentId: string | null,
    detail: string | null,
  ): Promise<void> {
    return this.db.recordActivity(actor, type, projectName, projectId, deploymentId, detail);
  }
  activityPage(
    afterCursor: string | null,
    limit: number,
    workspaceId?: string,
  ): Promise<import('../types.js').ActivityPage> {
    return this.db.activityPage(afterCursor, limit, workspaceId);
  }
  recentActivity(limit: number): Promise<import('../types.js').ActivityEvent[]> {
    return this.db.recentActivity(limit);
  }

  // ── traffic / access log ─────────────────────────────────────────────────────

  appendRequest(
    deployment: import('../types.js').Deployment,
    error: boolean,
    city: string,
    status: number,
    latencyMs: number,
    path: string,
  ): Promise<void> {
    return this.db.appendRequest(deployment, error, city, status, latencyMs, path);
  }
  getRequests(): Promise<import('../types.js').TrafficPoint[]> {
    return this.db.getRequests();
  }
  requestsOfProject(projectId: string): Promise<import('../types.js').TrafficPoint[]> {
    return this.db.requestsOfProject(projectId);
  }
  getLiveDeployments(): Promise<import('../types.js').Deployment[]> {
    return this.db.getLiveDeployments();
  }

  // ── git ──────────────────────────────────────────────────────────────────────

  getConnection(userId: string): Promise<import('../types.js').GitConnection> {
    return this.db.getConnection(userId);
  }
  getRepositories(userId: string, q?: string): Promise<import('../types.js').GitRepository[]> {
    return this.db.getRepositories(userId, q);
  }
  getBranches(repositoryId: string): Promise<import('../types.js').GitBranch[]> {
    return this.db.getBranches(repositoryId);
  }
  detect(repositoryId: string, branch: string): Promise<import('../types.js').GitDetection> {
    return this.db.detect(repositoryId, branch);
  }
  connectGit(userId: string): Promise<{ url: string }> {
    return this.db.connectGit(userId);
  }
  disconnectGit(userId: string): Promise<void> {
    return this.db.disconnectGit(userId);
  }
  getGitInstallations(userId: string): Promise<{
    id: number;
    account: string;
    type: 'user' | 'organization';
    repositorySelection: 'all' | 'selected';
    repositories: number;
    installedAt: string;
    settingsUrl: string;
  }[]> {
    return this.db.getGitInstallations(userId);
  }
  githubAuthCallback(code: string, state: string): Promise<{ userId: string; account: string }> {
    return this.db.githubAuthCallback(code, state);
  }

  // ── CodePad ──────────────────────────────────────────────────────────────────

  listPads(userId: string): Promise<import('./database.js').CodePadSummary[]> {
    return this.db.listPads(userId);
  }
  getPad(id: string): Promise<import('./database.js').CodePad | undefined> {
    return this.db.getPad(id);
  }
  createPad(
    userId: string,
    name: string,
    template: 'static' | 'node' | 'python',
  ): Promise<import('./database.js').CodePad> {
    return this.db.createPad(userId, name, template);
  }
  updatePad(id: string, name: string): Promise<import('./database.js').CodePad | undefined> {
    return this.db.updatePad(id, name);
  }
  deletePad(id: string): Promise<boolean> {
    return this.db.deletePad(id);
  }
  savePadFile(
    id: string,
    path: string,
    content: string,
  ): Promise<import('./database.js').CodePadFile | undefined> {
    return this.db.savePadFile(id, path, content);
  }
  renamePadFile(
    id: string,
    from: string,
    to: string,
  ): Promise<import('./database.js').CodePad | 'exists' | undefined> {
    return this.db.renamePadFile(id, from, to);
  }
  deletePadFile(id: string, path: string): Promise<import('./database.js').CodePad | undefined> {
    return this.db.deletePadFile(id, path);
  }
  startPadRun(id: string): Promise<string | undefined> {
    return this.db.startPadRun(id);
  }
  getRunLogs(
    id: string,
    after: number,
  ): Promise<{
    lines: import('./database.js').CodePadRunLogLine[];
    done: boolean;
    exitCode: number | null;
  } | undefined> {
    return this.db.getRunLogs(id, after);
  }
  deployPad(
    id: string,
  ): Promise<{ project: import('../types.js').ProjectSummary; deployment: import('../types.js').Deployment } | undefined> {
    return this.db.deployPad(id);
  }

  // ── storage ──────────────────────────────────────────────────────────────────

  getStorageList(
    path: string,
  ): Promise<{
    path: string;
    items: import('../types.js').StorageItem[];
    public: boolean;
    publicFrom: string | null;
  } | undefined> {
    return this.db.getStorageList(path);
  }
  searchStorage(q: string): Promise<import('../types.js').StorageItem[]> {
    return this.db.searchStorage(q);
  }
  getStorageFolders(): Promise<string[]> {
    return this.db.getStorageFolders();
  }
  createStorageFolder(path: string): Promise<import('../types.js').StorageItem | 'exists' | 'no-parent'> {
    return this.db.createStorageFolder(path);
  }
  completeStorageUpload(token: string, bytes: ArrayBuffer | null): Promise<import('../types.js').StorageItem | undefined> {
    return this.db.completeStorageUpload(token, bytes);
  }
  createStorageUpload(
    path: string,
    size: number,
    contentType: string,
  ): Promise<{ uploadUrl: string } | undefined> {
    return this.db.createStorageUpload(path, size, contentType);
  }
  renameStorageItem(
    path: string,
    name: string,
    makePublic?: boolean,
  ): Promise<import('../types.js').StorageItem | null | 'exists' | 'missing'> {
    return this.db.renameStorageItem(path, name, makePublic);
  }
  moveStorageItems(paths: string[], to: string): Promise<number | 'bad-target'> {
    return this.db.moveStorageItems(paths, to);
  }
  deleteStorageItems(paths: string[]): Promise<{ deleted: number; freed: number }> {
    return this.db.deleteStorageItems(paths);
  }
  previewStorage(
    path: string,
  ): Promise<{ url: string | null; text: string | null; truncated: boolean } | undefined> {
    return this.db.previewStorage(path);
  }
  createStorageLink(
    path: string,
    expiresIn: '1h' | '1d' | '7d',
  ): Promise<{ url: string; expiresAt: string } | undefined> {
    return this.db.createStorageLink(path, expiresIn);
  }

  // ── webhooks ─────────────────────────────────────────────────────────────────

  getWebhookEndpoint(workspaceId: string): Promise<import('../types.js').WebhookEndpoint | null> {
    return this.db.getWebhookEndpoint(workspaceId);
  }
  rotateWebhookEndpoint(workspaceId: string): Promise<import('../types.js').WebhookEndpoint> {
    return this.db.rotateWebhookEndpoint(workspaceId);
  }
  listWebhookRequests(workspaceId: string): Promise<import('../types.js').WebhookRequest[]> {
    return this.db.listWebhookRequests(workspaceId);
  }
  clearWebhookRequests(workspaceId: string): Promise<void> {
    return this.db.clearWebhookRequests(workspaceId);
  }
  captureWebhookRequest(
    workspaceId: string,
    request: Omit<import('../types.js').WebhookRequest, 'id' | 'receivedAt'>,
  ): Promise<import('../types.js').WebhookRequest> {
    return this.db.captureWebhookRequest(workspaceId, request);
  }
  getWebhookRequest(id: string): Promise<import('../types.js').WebhookRequest | undefined> {
    return this.db.getWebhookRequest(id);
  }

  // ── APIs ─────────────────────────────────────────────────────────────────────

  listApiKeys(userId: string): Promise<import('../types.js').ApiKey[]> {
    return this.db.listApiKeys(userId);
  }
  createApiKey(userId: string, input: import('../types.js').NewApiKey): Promise<import('../types.js').CreatedApiKey> {
    return this.db.createApiKey(userId, input);
  }
  revokeApiKey(id: string): Promise<boolean> {
    return this.db.revokeApiKey(id);
  }
  getApiUsage(): Promise<import('../types.js').ApiUsage> {
    return this.db.getApiUsage();
  }
  listApiRequests(api?: import('../types.js').ApiId): Promise<import('../types.js').ApiRequest[]> {
    return this.db.listApiRequests(api);
  }
  tryApi(
    request: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> },
  ): Promise<{ status: number; durationMs: number; body: unknown }> {
    return this.db.tryApi(request);
  }
}
