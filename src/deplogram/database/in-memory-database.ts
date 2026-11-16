/**
 * In-memory implementation of the `Database` abstraction.
 *
 * Used when no `DATABASE_URL` is configured. Every collection is keyed and
 * scoped by the requesting user's workspace — there is no shared singleton
 * current user. Passwords are hashed with bcrypt; sessions are JWTs stored as
 * server-side session rows (revocable, listed per user).
 */
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';

import type { Database, AuthResult, SessionInfo } from './database.js';
import type { CodePad, CodePadFile, CodePadSummary } from './database.js';
import {
  AccountPreferences,
  AccountSettings,
  ActivityEvent,
  ActivityPage,
  ActivityType,
  ApiId,
  ApiKey,
  ApiRequest,
  ApiUsage,
  API_IDS,
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

const BCRYPT_ROUNDS = 10;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function isoNow(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function jwtSecret(): string {
  return process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production';
}

function signSessionToken(userId: string, jti: string): string {
  return sign({ sub: userId, jti }, jwtSecret(), {
    expiresIn: SESSION_MAX_AGE_SECONDS,
    issuer: 'deplogram',
  });
}

function decodeSessionToken(token: string): { userId: string; jti: string } | null {
  try {
    const payload = verify(token, jwtSecret(), { issuer: 'deplogram' }) as JwtPayload & {
      sub: string;
      jti: string;
    };
    return { userId: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  image: string | null;
  passwordHash: string;
  createdAt: string;
}

interface SessionRow {
  id: string; // jti
  token: string; // raw JWT (cookie value)
  userId: string;
  browser: string;
  os: string;
  device: 'desktop' | 'mobile';
  location: string | null;
  ip: string;
  lastActiveAt: string;
  createdAt: string;
  current: boolean;
  revokedAt: string | null;
}

interface ProjectExt extends Project {
  workspaceId: string;
}

interface GitRepositoryExt extends GitRepository {
  userId: string;
}

const MAX_REQUEST_LOG = 5000;
const MAX_ACTIVITY_LOG = 500;

interface ProjectConfigInput {
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  rootDirectory: string | null;
}

@Injectable()
export class InMemoryDatabase implements Database {
  readonly users = new Map<string, UserRow>();
  readonly workspaces = new Map<string, Workspace>();
  /** userId -> personal workspace id */
  readonly workspaceOfUser = new Map<string, string>();
  /** workspaceId -> owning userId */
  readonly workspaceOwner = new Map<string, string>();
  /** userId -> GitHub OAuth connection */
  readonly gitConnections = new Map<string, { connected: boolean; account: string | null }>();
  readonly projects = new Map<string, ProjectExt>();
  /** projectId -> workspaceId */
  readonly projectWorkspace = new Map<string, string>();
  readonly deployments = new Map<string, Deployment>();
  /** deploymentId -> projectId (mirrors Deployment.projectId) */
  readonly repositories = new Map<string, GitRepositoryExt>();
  readonly branches = new Map<string, GitBranch[]>;
  readonly activity = new Map<string, ActivityEvent>();
  readonly activityOrder: ActivityEvent[] = [];
  readonly requests: TrafficPoint[] = [];
  readonly preferences = new Map<string, AccountPreferences>();
  readonly storage = new Map<string, StorageItem>();
  private readonly storageContents = new Map<
    string,
    { bytes: ArrayBuffer | null; text: string | null; url: string | null }
  >();
  private readonly storagePublic = new Map<string, string>();
  private readonly storageLinks = new Map<string, { path: string; size: number; contentType: string }>();
  readonly pads = new Map<string, CodePad>();
  private readonly runs = new Map<
    string,
    { startedAt: number; script: { text: string; stream?: 'stdout' | 'stderr'; delay: number }[]; exitCode: number }
  >();

  private readonly buildLog = new Map<string, BuildLogLine[]>();
  private readonly runtimeLog = new Map<string, RuntimeLogLine[]>();

  private webhookEndpoint: WebhookEndpoint | null = null;
  private webhookRequests: WebhookRequest[] = [];
  private webhookSeq = 0;

  private apiKeys: ApiKey[] = [];
  private apiRequests: ApiRequest[] = [];

  readonly sessions = new Map<string, SessionRow>();

  twoFactorEnabled = false;
  twoFactorEnabledAt: string | null = null;
  recoveryCodes: string[] = [];
  passwordChangedAt: string | null = null;

  notificationSettings: { email: string; events: Record<string, boolean>; digest: 'off' | 'weekly' } = {
    email: '',
    events: {
      deploy_failed: true,
      service_crashed: true,
      deploy_succeeded: false,
      limit_near: true,
      limit_reached: true,
      new_sign_in: true,
      api_keys: true,
      product_updates: false,
      tips: false,
    },
    digest: 'weekly',
  };

  // ── auth & users ─────────────────────────────────────────────────────────────

  async findUserByEmail(email: string): Promise<User | undefined> {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === needle) return user;
    }
    return undefined;
  }

  async getUser(id: string): Promise<User | undefined> {
    const row = this.users.get(id);
    if (!row) return undefined;
    const { passwordHash, ...rest } = row;
    return rest;
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async signUp(input: { name: string; email: string; password: string }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    if (this.findUserByEmailSync(email)) {
      throw new Error('Email already registered');
    }
    const passwordHash = await this.hashPassword(input.password);
    const user: UserRow = {
      id: newId('user'),
      email,
      name: input.name.trim(),
      image: null,
      passwordHash,
      createdAt: isoNow(),
    };
    this.users.set(user.id, user);
    await this.ensurePersonalWorkspace(user.id);
    return this.createSessionAuth(user);
  }

  async signIn(email: string, password: string): Promise<Viewer> {
    const userRow = await this.findUserRowByEmail(email);
    if (!userRow || !(await this.verifyPassword(password, userRow.passwordHash))) {
      throw new Error('Invalid email or password');
    }
    return this.toViewer(userRow);
  }

  private findUserRowByEmail(email: string): Promise<UserRow | undefined> {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === needle) return Promise.resolve(user);
    }
    return Promise.resolve(undefined);
  }

  private findUserByEmailSync(email: string): boolean {
    for (const user of this.users.values()) {
      if (user.email === email) return true;
    }
    return false;
  }

  private async createSessionAuth(userRow: UserRow): Promise<AuthResult> {
    const user: User = {
      id: userRow.id,
      email: userRow.email,
      name: userRow.name,
      image: userRow.image,
      createdAt: userRow.createdAt,
    };
    const sessionToken = await this.createSession(user.id, {
      browser: 'unknown',
      os: 'unknown',
      device: 'desktop',
      location: null,
      ip: '0.0.0.0',
    });
    return { viewer: this.toViewer(userRow), sessionToken };
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user || !(await bcrypt.compare(current, user.passwordHash))) {
      throw new Error('Current password is incorrect');
    }
    user.passwordHash = await this.hashPassword(next);
    this.passwordChangedAt = new Date().toISOString();
  }

  async deleteAccount(userId: string): Promise<void> {
    this.users.delete(userId);
    const workspaceId = this.workspaceOfUser.get(userId);
    this.workspaceOfUser.delete(userId);
    if (workspaceId) {
      this.workspaceOwner.delete(workspaceId);
      this.workspaces.delete(workspaceId);
    }
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) this.sessions.delete(token);
    }
    if (workspaceId) {
      for (const [pid, wid] of this.projectWorkspace.entries()) {
        if (wid === workspaceId) {
          this.projects.delete(pid);
          this.projectWorkspace.delete(pid);
        }
      }
      for (const [did, dep] of this.deployments.entries()) {
        if (dep.projectId && this.projectWorkspace.get(dep.projectId) === workspaceId) {
          this.deployments.delete(did);
        }
      }
    }
  }

  // ── preferences / account settings ───────────────────────────────────────────

  async preferencesOf(userId: string): Promise<AccountPreferences> {
    let preferences = this.preferences.get(userId);
    if (!preferences) {
      preferences = {
        defaultRuntime: 'nextjs',
        deploymentEmails: true,
        productUpdates: true,
      };
      this.preferences.set(userId, preferences);
    }
    return preferences;
  }

  async getAccountSettings(userId: string): Promise<AccountSettings> {
    const user = await this.getUser(userId);
    if (!user) throw new Error('Not signed in');
    const preferences = await this.preferencesOf(userId);
    return {
      name: user.name,
      email: user.email,
      preferences: {
        defaultRuntime: preferences.defaultRuntime,
        deploymentEmails: preferences.deploymentEmails,
        productUpdates: preferences.productUpdates,
      },
    };
  }

  async updateAccountSettings(userId: string, settings: AccountSettings): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('Not signed in');
    user.name = settings.name;
    const preferences = await this.preferencesOf(userId);
    preferences.defaultRuntime = settings.preferences.defaultRuntime;
    preferences.deploymentEmails = settings.preferences.deploymentEmails;
    preferences.productUpdates = settings.preferences.productUpdates;
  }

  // ── security / two-factor / notifications ────────────────────────────────────

  async getSecurityOverview(userId: string): Promise<SecurityOverviewDto> {
    return {
      passwordChangedAt: this.passwordChangedAt,
      twoFactor: {
        enabled: this.twoFactorEnabled,
        enabledAt: this.twoFactorEnabledAt,
        recoveryCodesLeft: this.recoveryCodes.length,
      },
    };
  }

  async setupTwoFactor(userId: string): Promise<TwoFactorSetupDto> {
    const secret = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(Math.random() * 32)],
    ).join('');
    return {
      secret,
      otpauthUrl: `otpauth://totp/Deplogram:${encodeURIComponent(userId)}?secret=${secret}`,
    };
  }

  async enableTwoFactor(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    if (!/^\d{6}$/.test(code)) {
      throw new Error('Invalid code');
    }
    this.twoFactorEnabled = true;
    this.twoFactorEnabledAt = new Date().toISOString();
    this.recoveryCodes = Array.from({ length: 10 }, () =>
      Array.from({ length: 8 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)],
      ).join(''),
    );
    return { recoveryCodes: [...this.recoveryCodes] };
  }

  async disableTwoFactor(userId: string, code: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) {
      throw new Error('Invalid code');
    }
    this.twoFactorEnabled = false;
    this.twoFactorEnabledAt = null;
    this.recoveryCodes = [];
  }

  async newRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
    if (!this.twoFactorEnabled) {
      throw new Error('Two-factor is not enabled');
    }
    this.recoveryCodes = Array.from({ length: 10 }, () =>
      Array.from({ length: 8 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)],
      ).join(''),
    );
    return { recoveryCodes: [...this.recoveryCodes] };
  }

  async getNotificationSettings(userId: string): Promise<{ email: string; events: Record<string, boolean>; digest: 'off' | 'weekly' }> {
    return { ...this.notificationSettings, events: { ...this.notificationSettings.events } };
  }

  async updateNotificationSettings(
    userId: string,
    update: { events?: Partial<Record<string, boolean>>; digest?: 'off' | 'weekly' },
  ): Promise<{ email: string; events: Record<string, boolean>; digest: 'off' | 'weekly' }> {
    if (update.events) {
      this.notificationSettings.events = {
        ...this.notificationSettings.events,
        ...update.events,
      } as Record<string, boolean>;
    }
    if (update.digest !== undefined) {
      this.notificationSettings.digest = update.digest;
    }
    return this.getNotificationSettings(userId);
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  async createSession(userId: string, info: SessionInfo): Promise<string> {
    const jti = newId('sess');
    const token = signSessionToken(userId, jti);
    const now = new Date().toISOString();
    this.sessions.set(jti, {
      id: jti,
      token,
      userId,
      ...info,
      lastActiveAt: now,
      createdAt: now,
      current: true,
      revokedAt: null,
    });
    for (const [otherJti, session] of this.sessions.entries()) {
      if (otherJti !== jti && session.userId === userId) session.current = false;
    }
    return token;
  }

  async getSession(token: string): Promise<{ userId: string } | undefined> {
    const decoded = decodeSessionToken(token);
    if (!decoded) return undefined;
    const session = this.sessions.get(decoded.jti);
    if (!session || session.token !== token || session.revokedAt) return undefined;
    return { userId: session.userId };
  }

  async touchSession(token: string): Promise<void> {
    const decoded = decodeSessionToken(token);
    if (!decoded) return;
    const session = this.sessions.get(decoded.jti);
    if (session) session.lastActiveAt = new Date().toISOString();
  }

  async getSessions(userId: string): Promise<SessionDto[]> {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && !s.revokedAt)
      .map(({ token: _token, userId: _userId, ...rest }) => rest);
  }

  async endSession(token: string): Promise<boolean> {
    const decoded = decodeSessionToken(token);
    if (!decoded) return false;
    const session = this.sessions.get(decoded.jti);
    if (!session) return false;
    session.revokedAt = new Date().toISOString();
    this.sessions.delete(decoded.jti);
    return true;
  }

  async endOtherSessions(currentSessionToken: string): Promise<void> {
    const decoded = decodeSessionToken(currentSessionToken);
    const currentJti = decoded ? decoded.jti : null;
    for (const [jti, session] of this.sessions.entries()) {
      if (currentJti && jti === currentJti) continue;
      session.revokedAt = new Date().toISOString();
      this.sessions.delete(jti);
    }
  }

  // ── workspaces ───────────────────────────────────────────────────────────────

  async ensurePersonalWorkspace(userId: string): Promise<void> {
    if (this.workspaceOfUser.has(userId)) return;
    const workspace: Workspace = {
      id: newId('ws'),
      name: 'Personal',
      kind: 'personal',
      plan: 'free',
    };
    this.workspaces.set(workspace.id, workspace);
    this.workspaceOfUser.set(userId, workspace.id);
    this.workspaceOwner.set(workspace.id, userId);
  }

  async currentWorkspace(userId: string): Promise<Workspace> {
    await this.ensurePersonalWorkspace(userId);
    const workspaceId = this.workspaceOfUser.get(userId)!;
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error('No current workspace');
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    return this.workspaces.get(id);
  }

  // ── projects ─────────────────────────────────────────────────────────────────

  private defaultRuntimeVersion(runtime: string): string {
    switch (runtime) {
      case 'nextjs':
        return '22.14.0';
      case 'node':
        return '22.x';
      case 'python':
        return '3.12';
      case 'php':
        return '8.3';
      case 'go':
        return '1.23';
      default:
        return 'latest';
    }
  }

  async createProject(
    userId: string,
    input: {
      name: string;
      repositoryId: string;
      branch: string;
      runtime: string;
      config: ProjectConfigInput;
      env: { key: string; value: string }[];
    },
    id?: string,
  ): Promise<Project> {
    const workspaceId = (await this.currentWorkspace(userId)).id;
    const repository = this.repositories.get(input.repositoryId);
    const project: ProjectExt = {
      id: id ?? newId('proj'),
      name: input.name,
      runtime: input.runtime,
      state: 'QUEUED',
      url: null,
      repository: repository ? repository.fullName : '',
      branch: input.branch,
      updatedAt: isoNow(),
      latest: null,
      recent: [],
      createdAt: isoNow(),
      liveDeploymentId: null,
      envCount: 0,
      config: {
        runtimeVersion: this.defaultRuntimeVersion(input.runtime),
        buildCommand: input.config.buildCommand,
        startCommand: input.config.startCommand,
        port: input.config.port,
        rootDirectory: input.config.rootDirectory,
      },
      env: this.applyEnv(input.env),
      workspaceId,
    };
    this.projects.set(project.id, project);
    this.projectWorkspace.set(project.id, workspaceId);
    const user = await this.getUser(userId);
    await this.recordActivity(
      user ?? null,
      'project.created',
      input.name,
      project.id,
      null,
      'created project',
    );
    return project;
  }

  private applyEnv(env: { key: string; value: string }[]): ProjectEnvVar[] {
    const variables = env.map((variable, index) => ({
      key: variable.key,
      value: variable.value,
      updatedAt: new Date(Date.now() + index).toISOString(),
    }));
    variables.sort((a, b) => a.key.localeCompare(b.key));
    return variables;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async listProjects(workspaceId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.workspaceId === workspaceId);
  }

  async updateProject(
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
  ): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project) return undefined;
    if (update.name !== undefined) project.name = update.name;
    if (update.branch !== undefined) project.branch = update.branch;
    const config = project.config;
    if (update.config) {
      if (update.config.buildCommand !== undefined)
        config.buildCommand = update.config.buildCommand;
      if (update.config.startCommand !== undefined)
        config.startCommand = update.config.startCommand;
      if (update.config.port !== undefined) config.port = update.config.port;
      if (update.config.rootDirectory !== undefined)
        config.rootDirectory = update.config.rootDirectory;
    }
    project.updatedAt = isoNow();
    const user = await this.getUser(this.projectWorkspace.get(id)!);
    if (update.name !== undefined && update.name !== project.name) {
      await this.recordActivity(
        user ?? null,
        'project.renamed',
        project.name,
        project.id,
        null,
        `renamed to ${update.name}`,
      );
    } else if (update.branch !== undefined || update.config !== undefined) {
      await this.recordActivity(
        user ?? null,
        'settings.updated',
        project.name,
        project.id,
        null,
        'changed project settings',
      );
    }
    return project;
  }

  async deleteProject(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (!project) return;
    const workspaceId = project.workspaceId;
    for (const deployment of this.deployments.values()) {
      if (deployment.projectId === id) this.deployments.delete(deployment.id);
    }
    this.projects.delete(id);
    this.projectWorkspace.delete(id);
    const user = await this.getUser(this.workspaceOfUser.get(workspaceId)!);
    await this.recordActivity(
      user ?? null,
      'project.deleted',
      project.name,
      id,
      null,
      'deleted project',
    );
  }

  async getEnvVars(projectId: string): Promise<EnvVarRecord[]> {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return project.env.map((variable) => ({
      key: variable.key,
      updatedAt: variable.updatedAt,
    }));
  }

  async saveEnvVars(
    projectId: string,
    values: { key: string; value: string | null }[],
  ): Promise<EnvVarRecord[]> {
    const project = this.projects.get(projectId);
    if (!project) return [];
    const saved = new Map<string, { value: string | null; updatedAt: string }>();
    for (const variable of project.env) {
      const entry = values.find((value) => value.key === variable.key);
      if (!entry) continue;
      saved.set(
        variable.key,
        entry.value === null
          ? { value: variable.value, updatedAt: variable.updatedAt }
          : { value: entry.value, updatedAt: new Date().toISOString() },
      );
    }
    for (const value of values) {
      if (value.value === null) continue;
      if (saved.has(value.key)) continue;
      saved.set(value.key, { value: value.value, updatedAt: new Date().toISOString() });
    }
    project.env = [...saved.entries()]
      .map(([key, variable]) => ({ key, value: variable.value, updatedAt: variable.updatedAt }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const records = project.env.map((variable) => ({
      key: variable.key,
      updatedAt: variable.updatedAt,
    }));
    const user = await this.getUser(this.projectWorkspace.get(projectId)!);
    await this.recordActivity(
      user ?? null,
      'env.updated',
      project.name,
      projectId,
      null,
      `saved ${records.length} variables`,
    );
    return records;
  }

  // ── deployments ──────────────────────────────────────────────────────────────

  async createDeployment(
    projectId: string,
    options: {
      trigger: DeploymentTrigger;
      commitSha: string;
      commitMessage: string;
      author: { name: string; avatarUrl: string | null };
      createdAt?: string;
    },
    id?: string,
  ): Promise<Deployment> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project');
    const previous = await this.latestDeployment(projectId);
    const deployment: Deployment = {
      id: id ?? newId('dep'),
      projectId,
      projectName: project.name,
      runtime: project.runtime,
      state: 'QUEUED',
      live: false,
      commit: {
        sha: options.commitSha,
        message: options.commitMessage,
        branch: project.branch,
        author: options.author,
      },
      trigger: options.trigger,
      createdAt: options.createdAt ?? isoNow(),
      durationSeconds: null,
      url: null,
      config: {
        runtimeVersion: project.config.runtimeVersion,
        buildCommand: project.config.buildCommand,
        startCommand: project.config.startCommand,
        port: project.config.port,
        rootDirectory: project.config.rootDirectory,
      },
      previousLiveId: previous ? previous.id : null,
    };
    this.deployments.set(deployment.id, deployment);
    project.state = 'QUEUED';
    project.updatedAt = isoNow();
    const user = await this.getUser(project.workspaceId);
    await this.recordActivity(
      user ?? null,
      'deployment.started',
      project.name,
      projectId,
      deployment.id,
      `started by ${options.trigger}`,
    );
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return this.deployments.get(id);
  }

  async deploymentsOfProject(projectId: string): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((deployment) => deployment.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async allDeployments(workspaceId: string): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter((deployment) => {
        const project = this.projects.get(deployment.projectId);
        return project && project.workspaceId === workspaceId;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async latestDeployment(projectId: string): Promise<Deployment | undefined> {
    const deployments = await this.deploymentsOfProject(projectId);
    return deployments[0];
  }

  async markLive(projectId: string, deploymentId: string): Promise<void> {
    const deployment = this.deployments.get(deploymentId);
    const project = this.projects.get(projectId);
    if (!deployment || !project) return;
    for (const candidate of this.deployments.values()) {
      if (candidate.projectId === projectId && candidate.live) {
        candidate.live = false;
      }
    }
    deployment.live = true;
    deployment.state = 'RUNNING';
    deployment.url = this.urlOf(project.name);
    project.liveDeploymentId = deploymentId;
    project.state = 'RUNNING';
    project.updatedAt = isoNow();
  }

  async rollbackTo(projectId: string, deploymentId: string): Promise<Deployment | undefined> {
    const deployment = this.deployments.get(deploymentId);
    const project = this.projects.get(projectId);
    if (!deployment || !project) return undefined;
    const targetId = deployment.previousLiveId;
    if (!targetId) return undefined;
    const target = this.deployments.get(targetId);
    if (!target) return undefined;
    await this.markLive(projectId, targetId);
    deployment.live = false;
    const user = await this.getUser(project.workspaceId);
    await this.recordActivity(
      user ?? null,
      'deployment.rolled_back',
      project.name,
      projectId,
      deploymentId,
      `rolled back to ${target.id}`,
    );
    return target;
  }

  async finishDeployment(deploymentId: string, state: DeploymentState): Promise<void> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return;
    deployment.state = state;
    deployment.durationSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(deployment.createdAt).getTime()) / 1000),
    );
  }

  // ── logs ─────────────────────────────────────────────────────────────────────

  async appendBuildLog(
    deploymentId: string,
    entries: [BuildStepId, 'stdout' | 'stderr', string][],
  ): Promise<void> {
    const lines = this.buildLog.get(deploymentId) ?? [];
    let n = lines.length ? lines[lines.length - 1].n + 1 : 1;
    for (const [step, stream, text] of entries) {
      lines.push({ n, at: isoNow(), step, stream, text });
      n += 1;
    }
    this.buildLog.set(deploymentId, lines);
  }

  async appendRuntimeLog(
    deploymentId: string,
    entries: [RuntimeLogLevel, RuntimeLogSource, string][],
  ): Promise<void> {
    const lines = this.runtimeLog.get(deploymentId) ?? [];
    let n = lines.length ? lines[lines.length - 1].n + 1 : 1;
    for (const [level, source, text] of entries) {
      lines.push({ n, at: isoNow(), level, source, text });
      n += 1;
    }
    this.runtimeLog.set(deploymentId, lines);
  }

  async getBuildLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: BuildLogLine[]; end: number }> {
    const lines = this.buildLog.get(deploymentId) ?? [];
    const end = lines.length ? lines[lines.length - 1].n : after;
    return { lines: lines.slice(after), end };
  }

  async getRuntimeLog(
    deploymentId: string,
    after: number,
  ): Promise<{ lines: RuntimeLogLine[]; end: number }> {
    const lines = this.runtimeLog.get(deploymentId) ?? [];
    const end = lines.length ? lines[lines.length - 1].n : after;
    return { lines: lines.slice(after), end };
  }

  // ── activity ─────────────────────────────────────────────────────────────────

  async recordActivity(
    actor: User | null,
    type: ActivityType,
    projectName: string,
    projectId: string | null,
    deploymentId: string | null,
    detail: string | null,
  ): Promise<void> {
    let workspaceId: string | null = null;
    if (actor) workspaceId = this.workspaceOfUser.get(actor.id) ?? null;
    else if (projectId) {
      const project = this.projects.get(projectId);
      if (project) workspaceId = project.workspaceId ?? null;
    }
    const event: ActivityEvent = {
      id: newId('evt'),
      at: isoNow(),
      type,
      actor: { name: actor ? actor.name : 'system' },
      workspaceId,
      project: projectId ? { id: projectId, name: projectName } : null,
      deployment: deploymentId ? this.deploymentRef(deploymentId) : null,
      detail,
    };
    this.activity.set(event.id, event);
    this.activityOrder.unshift(event);
    while (this.activityOrder.length > MAX_ACTIVITY_LOG) {
      this.activityOrder.pop();
    }
  }

  private deploymentRef(deploymentId: string): ActivityEvent['deployment'] {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return null;
    return {
      id: deployment.id,
      sha: deployment.commit.sha,
      message: deployment.commit.message,
      branch: deployment.commit.branch,
      state: deployment.state,
      trigger: deployment.trigger,
    };
  }

  async activityPage(afterCursor: string | null, limit: number, workspaceId?: string): Promise<ActivityPage> {
    let ordered = this.activityOrder;
    if (workspaceId) {
      ordered = this.activityOrder.filter((event) => event.workspaceId === workspaceId);
    }
    const startIndex = afterCursor
      ? ordered.findIndex((event) => event.id === afterCursor) + 1
      : 0;
    const endIndex = startIndex + limit;
    const window = ordered.slice(startIndex, endIndex);
    let nextCursor: string | null = null;
    if (endIndex < ordered.length) {
      nextCursor = window[window.length - 1]?.id ?? null;
    }
    return { items: window, nextCursor };
  }

  async recentActivity(limit: number): Promise<ActivityEvent[]> {
    return this.activityOrder.slice(0, limit);
  }

  // ── access log (traffic & metrics) ──────────────────────────────────────────

  async appendRequest(
    deployment: Deployment,
    error: boolean,
    city: string,
    status: number,
    latencyMs: number,
    path: string,
  ): Promise<void> {
    const point: TrafficPoint = {
      at: new Date().toISOString(),
      projectId: deployment.projectId,
      error,
      city,
      status,
      latencyMs,
      path,
    };
    this.requests.push(point);
    if (this.requests.length > MAX_REQUEST_LOG) {
      this.requests.shift();
    }
  }

  async getRequests(): Promise<TrafficPoint[]> {
    return this.requests;
  }

  async requestsOfProject(projectId: string): Promise<TrafficPoint[]> {
    return this.requests.filter((point) => point.projectId === projectId);
  }

  async getLiveDeployments(): Promise<Deployment[]> {
    const live: Deployment[] = [];
    for (const deployment of this.deployments.values()) {
      if (deployment.live) live.push(deployment);
    }
    return live;
  }

  // ── git ──────────────────────────────────────────────────────────────────────

  async getConnection(userId: string): Promise<GitConnection> {
    const connection = this.gitConnections.get(userId);
    const connected = Boolean(connection?.connected);
    return {
      provider: 'github',
      connected,
      account: connected ? connection?.account ?? null : null,
    };
  }

  async getRepositories(userId: string, q?: string): Promise<GitRepository[]> {
    const repositories = [...this.repositories.values()].filter((r) => r.userId === userId);
    if (!q) return repositories;
    const needle = q.toLowerCase();
    return repositories.filter((repository) =>
      repository.fullName.toLowerCase().includes(needle),
    );
  }

  async getBranches(repositoryId: string): Promise<GitBranch[]> {
    return this.branches.get(repositoryId) ?? [];
  }

  async detect(repositoryId: string, _branch: string): Promise<GitDetection> {
    const detectionFor: Record<string, GitDetection | null> = {
      repo_storefront: {
        runtime: 'nextjs',
        evidence: 'package.json (next)',
        buildCommand: 'npm run build',
        startCommand: 'npm start',
        port: 3000,
        envExample: [],
      },
      repo_api: {
        runtime: 'node',
        evidence: 'package.json (express)',
        buildCommand: 'npm run build',
        startCommand: 'node server.js',
        port: 8080,
        envExample: [],
      },
    };
    return (
      detectionFor[repositoryId] ?? {
        runtime: null,
        evidence: null,
        buildCommand: null,
        startCommand: null,
        port: null,
        envExample: [],
      }
    );
  }

  async connectGit(userId: string): Promise<{ url: string }> {
    const callback = this.githubCallbackUrl();
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID ?? '',
      redirect_uri: callback,
      scope: 'read:user,user:email,repo',
      state: userId,
    });
    return { url: `https://github.com/login/oauth/authorize?${params.toString()}` };
  }

  async disconnectGit(userId: string): Promise<void> {
    this.gitConnections.delete(userId);
    return undefined;
  }

  async getGitInstallations(userId: string): Promise<{
    id: number;
    account: string;
    type: 'user' | 'organization';
    repositorySelection: 'all' | 'selected';
    repositories: number;
    installedAt: string;
    settingsUrl: string;
  }[]> {
    const connection = this.gitConnections.get(userId);
    if (!connection?.connected) return [];
    return [
      {
        id: 1,
        account: connection.account ?? userId,
        type: 'user',
        repositorySelection: 'all',
        repositories: this.getRepositoriesSync(userId).length,
        installedAt: new Date().toISOString(),
        settingsUrl: 'https://github.com/settings/installations/1',
      },
    ];
  }

  private getRepositoriesSync(userId: string): GitRepository[] {
    return [...this.repositories.values()].filter((r) => r.userId === userId);
  }

  private githubCallbackUrl(): string {
    const configured = process.env.GITHUB_CALLBACK_URL;
    if (configured) return configured;
    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    return `${host}/v1/git/callback`;
  }

  async githubAuthCallback(code: string, state: string): Promise<{ userId: string; account: string }> {
    // Exchanges the OAuth code for a GitHub access token when a real client
    // secret is configured; otherwise records a demo connection keyed by state.
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    let accessToken: string | null = null;
    if (clientId && clientSecret) {
      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        });
        const json = await res.json();
        accessToken = json.access_token ?? null;
      } catch {
        accessToken = null;
      }
    }
    const userId = state || 'user_anonymous';
    const account = accessToken ? await this.fetchGitHubAccount(accessToken) : 'demo';
    this.gitConnections.set(userId, { connected: true, account });
    const repoId = `repo_${userId}`;
    if (!this.repositories.has(repoId)) {
      this.repositories.set(repoId, {
        id: repoId,
        fullName: `${account}/demo-repo`,
        private: true,
        defaultBranch: 'main',
        updatedAt: isoNow(),
        projectId: null,
        userId,
      });
      this.branches.set(repoId, [
        { name: 'main', commit: { sha: 'a1b2c3d', message: 'Initial commit' } },
      ]);
    }
    return { userId, account };
  }

  private async fetchGitHubAccount(accessToken: string): Promise<string> {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'deplogram-backend' },
      });
      if (res.ok) {
        const json = await res.json();
        return typeof json.login === 'string' ? json.login : 'github';
      }
    } catch {
      // ignore
    }
    return 'github';
  }

  // ── CodePad ──────────────────────────────────────────────────────────────────

  async listPads(userId: string): Promise<CodePadSummary[]> {
    const workspaceId = this.workspaceOfUser.get(userId);
    return [...this.pads.values()]
      .filter((pad) => pad.projectId ? this.projectWorkspace.get(pad.projectId) === workspaceId : true)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((pad) => ({
        id: pad.id,
        name: pad.name,
        runtime: pad.runtime,
        fileCount: pad.files.length,
        paths: pad.files.map((f) => f.path),
        updatedAt: pad.updatedAt,
        projectId: pad.projectId,
      }));
  }

  async getPad(id: string): Promise<CodePad | undefined> {
    return this.pads.get(id);
  }

  async createPad(
    userId: string,
    name: string,
    template: 'static' | 'node' | 'python',
  ): Promise<CodePad> {
    const runtime = template;
    const entry = runtime === 'static' ? 'index.html' : runtime === 'node' ? 'index.js' : 'main.py';
    const files: CodePadFile[] =
      runtime === 'static'
        ? [
            { path: 'index.html', content: '<h1>Hello from CodePad</h1>\n', updatedAt: isoNow() },
            { path: 'style.css', content: 'body { margin: 0; }\n', updatedAt: isoNow() },
            { path: 'script.js', content: 'console.log("hello");\n', updatedAt: isoNow() },
          ]
        : runtime === 'node'
          ? [
              { path: 'index.js', content: 'console.log("hello from Node");\n', updatedAt: isoNow() },
              { path: 'package.json', content: '{"name":"hello-node","version":"1.0.0"}\n', updatedAt: isoNow() },
            ]
          : [
              { path: 'main.py', content: 'print("Hello from Python")\n', updatedAt: isoNow() },
              { path: 'requirements.txt', content: '', updatedAt: isoNow() },
            ];
    const pad: CodePad = {
      id: newId('pad'),
      name,
      runtime,
      entry,
      projectId: null,
      updatedAt: isoNow(),
      files,
    };
    this.pads.set(pad.id, pad);
    return pad;
  }

  async updatePad(id: string, name: string): Promise<CodePad | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    pad.name = name;
    pad.updatedAt = isoNow();
    return pad;
  }

  async deletePad(id: string): Promise<boolean> {
    return this.pads.delete(id);
  }

  async savePadFile(id: string, path: string, content: string): Promise<CodePadFile | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    const saved: CodePadFile = { path, content, updatedAt: isoNow() };
    const at = pad.files.findIndex((f) => f.path === path);
    if (at >= 0) pad.files[at] = saved;
    else pad.files.push(saved);
    pad.files.sort((a, b) => a.path.localeCompare(b.path));
    pad.updatedAt = saved.updatedAt;
    return saved;
  }

  async renamePadFile(
    id: string,
    from: string,
    to: string,
  ): Promise<CodePad | 'exists' | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    if (pad.files.some((f) => f.path === to)) return 'exists';
    const file = pad.files.find((f) => f.path === from);
    if (!file) return undefined;
    file.path = to;
    if (pad.entry === from) pad.entry = to;
    pad.files.sort((a, b) => a.path.localeCompare(b.path));
    pad.updatedAt = isoNow();
    return pad;
  }

  async deletePadFile(id: string, path: string): Promise<CodePad | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    pad.files = pad.files.filter((f) => f.path !== path);
    if (pad.entry === path) pad.entry = pad.files[0]?.path ?? '';
    pad.updatedAt = isoNow();
    return pad;
  }

  async startPadRun(id: string): Promise<string | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    const runId = newId('run');
    const script = padScript(pad);
    this.runs.set(runId, { startedAt: Date.now(), script, exitCode: 0 });
    return runId;
  }

  async getRunLogs(
    id: string,
    after: number,
  ): Promise<{
    lines: { n: number; at: string; text: string; stream: 'stdout' | 'stderr' }[];
    done: boolean;
    exitCode: number | null;
  } | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const elapsed = Date.now() - run.startedAt;
    let t = 0;
    const due = run.script.flatMap((line, i) => {
      t += line.delay;
      return t <= elapsed
        ? [{ n: i + 1, at: new Date(run.startedAt + t).toISOString(), text: line.text, stream: line.stream ?? 'stdout' }]
        : [];
    });
    const done = due.length === run.script.length;
    return {
      lines: done ? due.filter((l) => l.n > after) : due.filter((l) => l.n > after),
      done,
      exitCode: done ? run.exitCode : null,
    };
  }

  async deployPad(id: string): Promise<{ project: ProjectSummary; deployment: Deployment } | undefined> {
    const pad = this.pads.get(id);
    if (!pad) return undefined;

    if (pad.projectId) {
      const project = this.projects.get(pad.projectId);
      if (!project) return undefined;
      const latest = await this.latestDeployment(pad.projectId);
      if (!latest) return undefined;
      const fresh = await this.createDeployment(pad.projectId, {
        trigger: 'manual',
        commitSha: Math.random().toString(16).slice(2, 9),
        commitMessage: 'Deployed from CodePad',
        author: { name: 'You', avatarUrl: null },
      });
      return {
        project: this.summarizePadProject(project),
        deployment: fresh,
      };
    }

    const repoId = `codepad_${pad.name}`;
    if (!this.repositories.has(repoId)) {
      this.repositories.set(repoId, {
        id: repoId,
        fullName: `codepad/${pad.name}`,
        private: true,
        defaultBranch: 'codepad',
        updatedAt: isoNow(),
        projectId: null,
        userId: 'system',
      });
    }
    const config: ProjectConfigInput = {
      buildCommand: null,
      startCommand: pad.runtime === 'static' ? null : pad.runtime === 'node' ? `node ${pad.entry}` : `python ${pad.entry}`,
      port: pad.runtime === 'static' ? null : pad.runtime === 'node' ? 3000 : 8000,
      rootDirectory: null,
    };
    const project = await this.createProject(
      'system',
      {
        name: pad.name,
        repositoryId: repoId,
        branch: 'codepad',
        runtime: pad.runtime,
        config,
        env: [],
      },
      newId('proj'),
    );
    const repo = this.repositories.get(repoId);
    if (repo) repo.projectId = project.id;
    const deployment = await this.createDeployment(project.id, {
      trigger: 'manual',
      commitSha: Math.random().toString(16).slice(2, 9),
      commitMessage: 'Deployed from CodePad',
      author: { name: 'You', avatarUrl: null },
    });
    (this.pads.get(id) as CodePad).projectId = project.id;
    return { project: this.summarizePadProject(project), deployment };
  }

  private summarizePadProject(project: Project): ProjectSummary {
    const deployments = this.deploymentsOfProjectSync(project.id);
    const latest = deployments[0];
    const state: DeploymentState = latest ? latest.state : 'QUEUED';
    return {
      id: project.id,
      name: project.name,
      runtime: project.runtime,
      state,
      url: state === 'RUNNING' && latest ? this.urlOf(project.name) : null,
      repository: project.repository,
      branch: project.branch,
      updatedAt: project.updatedAt,
      latest: latest
        ? {
            id: latest.id,
            state: latest.state,
            live: latest.live,
            sha: latest.commit.sha,
            message: latest.commit.message,
            createdAt: latest.createdAt,
          }
        : null,
      recent: deployments.slice(0, 10).map((deployment) => deployment.state),
    };
  }

  private deploymentsOfProjectSync(projectId: string): Deployment[] {
    return [...this.deployments.values()]
      .filter((deployment) => deployment.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private urlOf(projectName: string): string {
    return `${projectName}.deplogram.app`;
  }

  // ── storage ──────────────────────────────────────────────────────────────────

  async getStorageList(
    path: string,
  ): Promise<{ path: string; items: StorageItem[]; public: boolean; publicFrom: string | null } | undefined> {
    if (!(path === '' || this.storage.get(path)?.kind === 'folder')) return undefined;
    const from = this.storagePublicFrom(path);
    const items = [...this.storage.values()]
      .filter((item) => this.storageParentOf(item.path) === path)
      .map((item) => this.storageView(item));
    return { path, items, public: from != null, publicFrom: from };
  }

  async searchStorage(q: string): Promise<StorageItem[]> {
    const needle = q.toLowerCase();
    return [...this.storage.values()]
      .filter((item) => item.name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((item) => this.storageView(item));
  }

  async getStorageFolders(): Promise<string[]> {
    return [...this.storage.values()]
      .filter((i) => i.kind === 'folder')
      .map((i) => i.path)
      .sort();
  }

  async createStorageFolder(path: string): Promise<StorageItem | 'exists' | 'no-parent'> {
    if (this.storage.has(path)) return 'exists';
    if (!(path === '' || this.storage.get(this.storageParentOf(path))?.kind === 'folder'))
      return 'no-parent';
    const now = new Date().toISOString();
    const folder: StorageItem = {
      kind: 'folder',
      name: path.split('/').pop()!,
      path,
      size: 0,
      contentType: null,
      items: 0,
      createdAt: now,
      updatedAt: now,
      thumbnailUrl: null,
      public: false,
      publicUrl: null,
    };
    this.storage.set(path, folder);
    return this.storageView(folder);
  }

  async completeStorageUpload(token: string, bytes: ArrayBuffer | null): Promise<StorageItem | undefined> {
    const upload = this.storageLinks.get(token);
    if (!upload) return undefined;
    const { path, size, contentType } = upload;
    this.storageLinks.delete(token);
    return this.addStorageFile(path, size, contentType, bytes);
  }

  async createStorageUpload(
    path: string,
    size: number,
    contentType: string,
  ): Promise<{ uploadUrl: string } | undefined> {
    const limit = this.storageUsedBytes();
    if (limit + size > 256 * 1024 * 1024) return undefined;
    const token = newId('upt');
    this.storageLinks.set(token, { path, size, contentType });
    return { uploadUrl: `/v1/storage/uploads/${token}` };
  }

  async renameStorageItem(
    path: string,
    name: string,
    makePublic?: boolean,
  ): Promise<StorageItem | null | 'exists' | 'missing'> {
    if (makePublic !== undefined) {
      const item = this.storage.get(path);
      if (!item || item.kind !== 'folder') return null;
      this.storage.set(path, { ...item, public: makePublic, updatedAt: new Date().toISOString() });
      return this.storageView(this.storage.get(path)!);
    }
    if (!name) return 'missing';
    const item = this.storage.get(path);
    if (!item) return 'missing';
    const parent = this.storageParentOf(path);
    const to = parent ? `${parent}/${name}` : name;
    if (to !== path && this.storage.has(to)) return 'exists';
    this.storageRelocate(path, to);
    return this.storageView(this.storage.get(to)!);
  }

  async moveStorageItems(paths: string[], to: string): Promise<number | 'bad-target'> {
    if (!(to === '' || this.storage.get(to)?.kind === 'folder')) return 'bad-target';
    if (paths.some((p) => to === p || to.startsWith(`${p}/`))) return 'bad-target';
    let moved = 0;
    for (const path of paths) {
      const item = this.storage.get(path);
      if (!item || this.storageParentOf(path) === to) continue;
      const taken = new Set(this.getStorageListSync(to)!.items.map((i) => i.name));
      let name = item.name;
      for (let n = 1; taken.has(name); n += 1) name = `${item.name} (${n})`;
      this.storageRelocate(path, to ? `${to}/${name}` : name);
      moved += 1;
    }
    return moved;
  }

  async deleteStorageItems(paths: string[]): Promise<{ deleted: number; freed: number }> {
    let freed = 0;
    let deleted = 0;
    for (const path of paths) {
      for (const [key, item] of [...this.storage]) {
        if (key === path || key.startsWith(`${path}/`)) {
          if (item.kind === 'file') freed += item.size;
          this.storage.delete(key);
          this.storageContents.delete(key);
          if (key === path) deleted += 1;
        }
      }
    }
    return { deleted, freed };
  }

  async previewStorage(
    path: string,
  ): Promise<{ url: string | null; text: string | null; truncated: boolean } | undefined> {
    const item = this.storage.get(path);
    if (!item || item.kind !== 'file') return undefined;
    const uploaded = this.storageContents.get(path);
    const isTextLike = this.storageItemIsTextLike(item);
    if (isTextLike) {
      const text = uploaded?.text ?? null;
      const limit = 200_000;
      return {
        url: null,
        text: text && text.length > limit ? text.slice(0, limit) : text,
        truncated: Boolean(text && text.length > limit),
      };
    }
    return { url: uploaded?.url ?? item.thumbnailUrl ?? null, text: null, truncated: false };
  }

  async createStorageLink(
    path: string,
    expiresIn: '1h' | '1d' | '7d',
  ): Promise<{ url: string; expiresAt: string } | undefined> {
    if (!this.storage.get(path)) return undefined;
    const ms = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000 }[expiresIn];
    const token = newId('lnk');
    const publicUrl = `https://files.dpl.app/${encodeURI(path)}?token=${token}`;
    this.storagePublic.set(path, publicUrl);
    return {
      url: publicUrl,
      expiresAt: new Date(Date.now() + ms).toISOString(),
    };
  }

  private storageExists(path: string): boolean {
    return path === '' || this.storage.get(path)?.kind === 'folder';
  }

  private storagePublicFrom(path: string): string | null {
    for (let p = path; p; p = this.storageParentOf(p)) {
      const item = this.storage.get(p);
      if (item?.kind === 'folder' && item.public) return p;
    }
    return null;
  }

  private storageParentOf(path: string): string {
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }

  private storageView(item: StorageItem): StorageItem {
    const pub = this.storagePublicFrom(item.path) != null;
    if (item.kind === 'file') return { ...item, public: pub, publicUrl: pub ? `https://files.dpl.app/ada/${encodeURI(item.path)}` : null };
    const prefix = `${item.path}/`;
    let size = 0;
    let children = 0;
    for (const other of this.storage.values()) {
      if (!other.path.startsWith(prefix)) continue;
      if (other.kind === 'file') size += other.size;
      if (this.storageParentOf(other.path) === item.path) children += 1;
    }
    return { ...item, size, items: children, public: pub, publicUrl: null };
  }

  private getStorageListSync(path: string): { path: string; items: StorageItem[]; public: boolean; publicFrom: string | null } | undefined {
    if (!(path === '' || this.storage.get(path)?.kind === 'folder')) return undefined;
    const items = [...this.storage.values()]
      .filter((item) => this.storageParentOf(item.path) === path)
      .map((item) => this.storageView(item));
    return { path, items, public: false, publicFrom: null };
  }

  private addStorageFile(path: string, size: number, contentType: string, bytes: ArrayBuffer | null): StorageItem {
    const folder = this.storageParentOf(path);
    const taken = new Set(this.getStorageListSync(folder!)!.items.map((i) => i.name));
    let name = path.split('/').pop()!;
    if (taken.has(name)) {
      const dot = name.lastIndexOf('.');
      const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let n = 1;
      while (taken.has(`${base} (${n})${ext}`)) n += 1;
      name = `${base} (${n})${ext}`;
    }
    const full = folder ? `${folder}/${name}` : name;
    const now = new Date().toISOString();
    const blobUrl = bytes ? URL.createObjectURL(new Blob([bytes], { type: contentType })) : null;
    const file: StorageItem = {
      kind: 'file',
      name,
      path: full,
      size,
      contentType,
      items: null,
      createdAt: now,
      updatedAt: now,
      thumbnailUrl: contentType.startsWith('image/') ? (blobUrl ?? null) : null,
      public: false,
      publicUrl: null,
    };
    this.storage.set(full, file);
    if (blobUrl) {
      const text = this.storageItemIsTextLike(file) && bytes && bytes.byteLength < 2_000_000 ? new TextDecoder().decode(bytes) : null;
      this.storageContents.set(full, { bytes, text, url: blobUrl ?? null });
    }
    return this.storageView(file);
  }

  private storageItemIsTextLike(item: StorageItem): boolean {
    const type = item.contentType ?? '';
    const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
    return (
      type.startsWith('text/') ||
      /json|xml|javascript|yaml/.test(type) ||
      ['md', 'txt', 'csv', 'json', 'js', 'ts', 'py', 'html', 'css', 'sql', 'yml', 'yaml', 'env'].includes(ext)
    );
  }

  private storageUsedBytes(): number {
    let bytes = 0;
    for (const item of this.storage.values()) {
      if (item.kind === 'file') bytes += item.size;
    }
    return bytes;
  }

  private storageRelocate(from: string, to: string) {
    const now = new Date().toISOString();
    for (const [key, item] of [...this.storage]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      const next = to + key.slice(from.length);
      this.storage.delete(key);
      this.storage.set(next, { ...item, path: next, name: next.split('/').pop()!, updatedAt: key === from ? now : item.updatedAt });
      const content = this.storageContents.get(key);
      if (content) {
        this.storageContents.delete(key);
        this.storageContents.set(next, content);
      }
    }
  }

  // ── webhooks ──────────────────────────────────────────────────────────────────

  async getWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint | null> {
    return this.webhookEndpoint;
  }

  async rotateWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint> {
    const token = () => Math.random().toString(36).slice(2, 10);
    this.webhookEndpoint = { url: `https://hooks.dpl.app/h/${token()}`, createdAt: new Date().toISOString() };
    this.webhookRequests = [];
    return this.webhookEndpoint;
  }

  async listWebhookRequests(workspaceId: string): Promise<WebhookRequest[]> {
    return this.webhookRequests.slice(0, 50);
  }

  async clearWebhookRequests(workspaceId: string): Promise<void> {
    this.webhookRequests = [];
  }

  async captureWebhookRequest(
    workspaceId: string,
    request: Omit<WebhookRequest, 'id' | 'receivedAt'>,
  ): Promise<WebhookRequest> {
    const id = `wh_${++this.webhookSeq}${Math.random().toString(36).slice(2, 4)}`;
    const entry: WebhookRequest = { ...request, id, receivedAt: new Date().toISOString() };
    this.webhookRequests = [entry, ...this.webhookRequests];
    return entry;
  }

  async getWebhookRequest(id: string): Promise<WebhookRequest | undefined> {
    return this.webhookRequests.find((r) => r.id === id);
  }

  // ── APIs ─────────────────────────────────────────────────────────────────────

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    return [...this.apiKeys];
  }

  async createApiKey(userId: string, input: NewApiKey): Promise<CreatedApiKey> {
    const secret = `dpl_${input.mode}_${Math.random().toString(16).slice(2, 42)}`;
    const user = await this.getUser(userId);
    const key: ApiKey = {
      id: newId('key'),
      name: input.name,
      prefix: secret.slice(0, 13),
      mode: input.mode,
      access: input.access,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      createdBy: user ? user.name : 'you',
    };
    this.apiKeys = [key, ...this.apiKeys];
    return { ...key, secret };
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const found = this.apiKeys.some((k) => k.id === id);
    this.apiKeys = this.apiKeys.filter((k) => k.id !== id);
    return found;
  }

  async getApiUsage(): Promise<ApiUsage> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    const plan: Record<string, { limit: number; perDay: number; p50: number; errors: number }> = {
      otp: { limit: 500, perDay: 12, p50: 412, errors: 0.012 },
      email: { limit: 3_000, perDay: 70, p50: 186, errors: 0.004 },
      images: { limit: 5_000, perDay: 162, p50: 238, errors: 0.006 },
      qr: { limit: 10_000, perDay: 80, p50: 41, errors: 0.001 },
    };
    const apis = API_IDS.map((id) => {
      const daily = Array.from({ length: 30 }, (_, i) => {
        const date = new Date(now.getTime() - (29 - i) * 86_400_000);
        const requests = Math.round(plan[id].perDay * (0.8 + i / 100));
        return { date: date.toISOString().slice(0, 10), requests, errors: Math.round(requests * plan[id].errors) };
      });
      const used = daily.reduce((sum, d) => sum + d.requests, 0);
      return { id, used, limit: plan[id].limit, successRate: 1 - plan[id].errors, p50Ms: plan[id].p50, daily };
    });
    return { period: { start: start.toISOString(), end: end.toISOString() }, apis };
  }

  async listApiRequests(api?: ApiId): Promise<ApiRequest[]> {
    return (api ? this.apiRequests.filter((r) => r.api === api) : this.apiRequests).slice(0, 50);
  }

  async tryApi(
    request: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> },
  ): Promise<{ status: number; durationMs: number; body: unknown }> {
    const started = Date.now();
    const api = this.apiOfPath(request.path);
    const status = api ? 200 : 404;
    const body = api
      ? { id: `t_${Math.random().toString(16).slice(2, 10)}`, ok: true }
      : { error: { code: 'not_found', message: `No endpoint ${request.method} ${request.path}.` } };
    const durationMs = Math.max(1, Date.now() - started);
    const entry: ApiRequest = {
      id: `req_${Math.random().toString(16).slice(2, 10)}`,
      api: api ?? 'otp',
      method: request.method,
      path: request.path,
      status,
      durationMs,
      keyPrefix: 'dpl_test_9c1e',
      mode: 'test',
      at: new Date().toISOString(),
    };
    this.apiRequests = [entry, ...this.apiRequests].slice(0, 200);
    return { status, durationMs, body };
  }

  private apiOfPath(path: string): ApiId | undefined {
    const segment = path.split('/')[2];
    return API_IDS.includes(segment as ApiId) ? (segment as ApiId) : undefined;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private toViewer(user: UserRow): Viewer {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    };
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

interface PadScriptLine {
  text: string;
  stream?: 'stdout' | 'stderr';
  delay: number;
}

/** A deterministic script for running a pad, mirroring the CodePad mock. */
function padScript(pad: {
  runtime: string;
  entry: string;
  files: { path: string; content?: string }[];
}): PadScriptLine[] {
  const { runtime, entry, files } = pad;
  if (runtime === 'static') {
    return [
      { text: `$ serve . (${files.length} files)`, delay: 150 },
      {
        text: `Serving ${entry} with ${files.filter((f) => f.path.endsWith('.css')).length} stylesheet(s) and ${files.filter((f) => f.path.endsWith('.js')).length} script(s)`,
        delay: 350,
      },
      { text: "Preview is live in the panel on the right.", delay: 150 },
    ];
  }
  if (runtime === 'python') {
    const entryFile = files.find((f) => f.path === entry);
    const names = entryFile?.content?.match(/\["([^\]]+)"\]/)?.[1]?.split(/",\s*"/) ?? [];
    const day = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
    return [
      { text: `$ python ${entry}`, delay: 200 },
      ...(names.length
        ? names.map((n: string, i: number) => ({ text: `Hello, ${n}! Today is ${day}.`, delay: i === 0 ? 600 : 80 }))
        : [{ text: '(no output)', delay: 600 }]),
      { text: 'Process finished with exit code 0', delay: 120 },
    ];
  }
  return [
    { text: `$ node ${entry}`, delay: 200 },
    { text: 'Listening on http://localhost:3000', delay: 700 },
    { text: 'GET / 200 3ms', delay: 900 },
    { text: 'Run ended — runs in CodePad are short and time-limited.', delay: 1200 },
  ];
}
