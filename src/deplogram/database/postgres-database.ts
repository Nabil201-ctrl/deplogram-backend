/**
 * Postgres implementation of the `Database` abstraction.
 *
 * Used when `DATABASE_URL` is set (Postgres, Supabase, Neon, …). All tables are
 * created with `CREATE TABLE IF NOT EXISTS` on first connect, so the backend is
 * ready to run without migrations. Sessions, users, projects and every other
 * entity are persisted here, surviving deploys and Vercel cold starts.
 */
import { Pool, type PoolClient } from 'pg';

import { Database, type AuthResult, type SessionInfo } from './database.js';
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
import { CodePad, CodePadFile, CodePadSummary, CodePadRunLogLine } from './database.js';

const BCRYPT_ROUNDS = 10;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function isoNow(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  image TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  browser TEXT,
  os TEXT,
  device TEXT,
  location TEXT,
  ip TEXT,
  last_active_at TEXT,
  created_at TEXT,
  current BOOLEAN DEFAULT TRUE,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  state TEXT NOT NULL,
  url TEXT,
  repository TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  live_deployment_id TEXT,
  env_count INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  env JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  state TEXT NOT NULL,
  live BOOLEAN NOT NULL DEFAULT FALSE,
  commit JSONB NOT NULL DEFAULT '{}',
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duration_seconds INTEGER,
  url TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  previous_live_id TEXT
);

CREATE TABLE IF NOT EXISTS deployment_build_logs (
  deployment_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  at TEXT NOT NULL,
  step TEXT NOT NULL,
  stream TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (deployment_id, n)
);

CREATE TABLE IF NOT EXISTS deployment_runtime_logs (
  deployment_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (deployment_id, n)
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT 'system',
  workspace_id TEXT,
  project_id TEXT,
  project_name TEXT,
  deployment_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS activity_order (
  position SERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS traffic (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  project_id TEXT NOT NULL,
  error BOOLEAN NOT NULL DEFAULT FALSE,
  city TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id TEXT PRIMARY KEY,
  default_runtime TEXT NOT NULL DEFAULT 'nextjs',
  deployment_emails BOOLEAN NOT NULL DEFAULT TRUE,
  product_updates BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS git_connections (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'github',
  connected BOOLEAN NOT NULL DEFAULT FALSE,
  account TEXT,
  access_token TEXT
);

CREATE TABLE IF NOT EXISTS git_repositories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private BOOLEAN NOT NULL DEFAULT FALSE,
  default_branch TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT
);

CREATE TABLE IF NOT EXISTS git_branches (
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  PRIMARY KEY (repository_id, name)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  mode TEXT NOT NULL,
  access JSONB NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'you'
);

CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY,
  api TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  key_prefix TEXT NOT NULL,
  mode TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_items (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  items INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  thumbnail_url TEXT,
  public BOOLEAN NOT NULL DEFAULT FALSE,
  public_url TEXT
);

CREATE TABLE IF NOT EXISTS storage_contents (
  path TEXT PRIMARY KEY,
  bytes BYTEA,
  text TEXT,
  url TEXT
);

CREATE TABLE IF NOT EXISTS storage_links (
  token TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codepads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  entry TEXT NOT NULL,
  project_id TEXT,
  updated_at TEXT NOT NULL,
  files JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS codepad_runs (
  id TEXT PRIMARY KEY,
  started_at BIGINT NOT NULL,
  script JSONB NOT NULL DEFAULT '[]',
  exit_code INTEGER
);

CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_requests (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query JSONB NOT NULL DEFAULT '[]',
  headers JSONB NOT NULL DEFAULT '[]',
  body TEXT NOT NULL DEFAULT '',
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'
);
`;

export class PostgresDatabase implements Database {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(SCHEMA);
    } finally {
      client.release();
    }
  }

  private async client<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await action(client);
    } finally {
      client.release();
    }
  }

  // ── auth & users ─────────────────────────────────────────────────────────────

  async findUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, email, name, image, password_hash, created_at FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase()],
    );
    if (rows.length === 0) return undefined;
    return this.toUser(rows[0]);
  }

  async getUser(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, email, name, image, password_hash, created_at FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    if (rows.length === 0) return undefined;
    return this.toUser(rows[0]);
  }

  private async getUserRow(id: string) {
    const { rows } = await this.pool.query(
      'SELECT id, email, name, image, password_hash, created_at FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0];
  }

  private toUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      image: row.image ?? null,
      createdAt: row.created_at,
    };
  }

  async hashPassword(password: string): Promise<string> {
    const bcrypt = await import('bcryptjs');
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    const bcrypt = await import('bcryptjs');
    return bcrypt.compare(password, hash);
  }

  async signUp(input: { name: string; email: string; password: string }): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.findUserByEmail(email);
    if (existing) throw new Error('Email already registered');
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const id = newId('user');
    const now = isoNow();
    await this.pool.query(
      'INSERT INTO users (id, email, name, image, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, email, input.name.trim(), null, passwordHash, now],
    );
    await this.ensurePersonalWorkspaceTx(id, id, now);
    const viewer: Viewer = { id, name: input.name.trim(), email, image: null };
    return this.createSessionAuth(id, viewer);
  }

  async signIn(email: string, password: string): Promise<Viewer> {
    const row = await this.pool.query(
      'SELECT id, email, name, image, password_hash FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase()],
    );
    if (row.rows.length === 0) throw new Error('Invalid email or password');
    const user = row.rows[0];
    const bcrypt = await import('bcryptjs');
    if (!(await bcrypt.compare(password, user.password_hash))) {
      throw new Error('Invalid email or password');
    }
    return { id: user.id, name: user.name, email: user.email, image: user.image ?? null };
  }

  private async createSessionAuth(userId: string, viewer: Viewer): Promise<AuthResult> {
    const { sign } = await import('jsonwebtoken');
    const jti = newId('sess');
    const token = sign({ sub: userId, jti }, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      issuer: 'deplogram',
    });
    const now = isoNow();
    await this.pool.query(
      `INSERT INTO sessions (id, token, user_id, browser, os, device, location, ip, last_active_at, created_at, current, revoked_at)
       VALUES ($1,$2,$3,$4,$5,'desktop',NULL,'0.0.0.0',$6,$6,TRUE,NULL)
       ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, current = TRUE, revoked_at = NULL`,
      [jti, token, userId, now],
    );
    await this.pool.query("UPDATE sessions SET current = FALSE WHERE user_id = $1 AND id <> $2", [userId, jti]);
    return { viewer, sessionToken: token };
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const row = await this.pool.query('SELECT password_hash FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (row.rows.length === 0) throw new Error('Current password is incorrect');
    const bcrypt = await import('bcryptjs');
    if (!(await bcrypt.compare(current, row.rows[0].password_hash))) throw new Error('Current password is incorrect');
    const bcrypt2 = await import('bcryptjs');
    const passwordHash = await bcrypt2.hash(next, BCRYPT_ROUNDS);
    await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await this.pool.query("INSERT INTO platform_state (key, value) VALUES ('password_changed_at', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ at: isoNow() })]);
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.client(async (client) => {
      const { rows } = await client.query('SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1', [userId]);
      const workspaceId = rows[0]?.id;
      if (workspaceId) {
        await client.query('DELETE FROM projects WHERE workspace_id = $1', [workspaceId]);
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      }
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM git_connections WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    });
  }

  // ── preferences / account settings ───────────────────────────────────────────

  async preferencesOf(userId: string): Promise<AccountPreferences> {
    const { rows } = await this.pool.query(
      'SELECT default_runtime, deployment_emails, product_updates FROM preferences WHERE user_id = $1 LIMIT 1',
      [userId],
    );
    if (rows.length === 0) {
      const prefs: AccountPreferences = { defaultRuntime: 'nextjs', deploymentEmails: true, productUpdates: true };
      await this.pool.query(
        'INSERT INTO preferences (user_id, default_runtime, deployment_emails, product_updates) VALUES ($1,$2,$3,$4)',
        [userId, prefs.defaultRuntime, prefs.deploymentEmails, prefs.productUpdates],
      );
      return prefs;
    }
    const r = rows[0];
    return { defaultRuntime: r.default_runtime, deploymentEmails: r.deployment_emails, productUpdates: r.product_updates };
  }

  async getAccountSettings(userId: string): Promise<AccountSettings> {
    const row = await this.pool.query('SELECT name, email FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (row.rows.length === 0) throw new Error('Not signed in');
    const preferences = await this.preferencesOf(userId);
    const u = row.rows[0];
    return { name: u.name, email: u.email, preferences };
  }

  async updateAccountSettings(userId: string, settings: AccountSettings): Promise<void> {
    await this.pool.query('UPDATE users SET name = $1 WHERE id = $2', [settings.name, userId]);
    const prefs = await this.preferencesOf(userId);
    await this.pool.query(
      'UPDATE preferences SET default_runtime = $1, deployment_emails = $2, product_updates = $3 WHERE user_id = $4',
      [settings.preferences.defaultRuntime, settings.preferences.deploymentEmails, settings.preferences.productUpdates, userId],
    );
  }

  // ── security / two-factor / notifications ────────────────────────────────────

  async getSecurityOverview(userId: string): Promise<SecurityOverviewDto> {
    const row = await this.pool.query("SELECT value FROM platform_state WHERE key = 'password_changed_at' LIMIT 1", []);
    const twoFactorRow = await this.pool.query("SELECT value FROM platform_state WHERE key = 'two_factor' LIMIT 1", []);
    const tf = twoFactorRow.rows[0]?.value ?? {};
    return {
      passwordChangedAt: row.rows[0]?.value?.at ?? null,
      twoFactor: {
        enabled: Boolean(tf.enabled),
        enabledAt: tf.enabledAt ?? null,
        recoveryCodesLeft: Array.isArray(tf.recoveryCodes) ? tf.recoveryCodes.length : 0,
      },
    };
  }

  async setupTwoFactor(userId: string): Promise<TwoFactorSetupDto> {
    const secret = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(Math.random() * 32)]).join('');
    return { secret, otpauthUrl: `otpauth://totp/Deplogram:${encodeURIComponent(userId)}?secret=${secret}` };
  }

  async enableTwoFactor(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    if (!/^\d{6}$/.test(code)) throw new Error('Invalid code');
    const codes = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join(''));
    await this.pool.query("INSERT INTO platform_state (key, value) VALUES ('two_factor', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ enabled: true, enabledAt: isoNow(), recoveryCodes: codes })]);
    return { recoveryCodes: [...codes] };
  }

  async disableTwoFactor(userId: string, code: string): Promise<void> {
    if (!/^\d{6}$/.test(code)) throw new Error('Invalid code');
    await this.pool.query("INSERT INTO platform_state (key, value) VALUES ('two_factor', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ enabled: false, enabledAt: null, recoveryCodes: [] })]);
  }

  async newRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
    const row = await this.pool.query("SELECT value FROM platform_state WHERE key = 'two_factor' LIMIT 1", []);
    if (!row.rows[0]?.value?.enabled) throw new Error('Two-factor is not enabled');
    const codes = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join(''));
    await this.pool.query("UPDATE platform_state SET value = $1 WHERE key = 'two_factor'", [JSON.stringify({ enabled: true, enabledAt: isoNow(), recoveryCodes: codes })]);
    return { recoveryCodes: [...codes] };
  }

  async getNotificationSettings(userId: string): Promise<{ email: string; events: Record<string, boolean>; digest: 'off' | 'weekly' }> {
    const u = await this.pool.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [userId]);
    const row = await this.pool.query("SELECT value FROM platform_state WHERE key = 'notifications' LIMIT 1", []);
    const value = row.rows[0]?.value ?? { email: u.rows[0]?.email ?? '', events: {}, digest: 'weekly' };
    return { email: value.email, events: value.events, digest: value.digest };
  }

  async updateNotificationSettings(
    userId: string,
    update: { events?: Partial<Record<string, boolean>>; digest?: 'off' | 'weekly' },
  ): Promise<{ email: string; events: Record<string, boolean>; digest: 'off' | 'weekly' }> {
    const current = await this.getNotificationSettings(userId);
    const next = {
      email: current.email,
      events: { ...current.events, ...update.events } as Record<string, boolean>,
      digest: update.digest ?? current.digest,
    };
    await this.pool.query("INSERT INTO platform_state (key, value) VALUES ('notifications', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(next)]);
    return next;
  }

  // ── sessions ─────────────────────────────────────────────────────────────────

  async createSession(userId: string, info: SessionInfo): Promise<string> {
    const { sign } = await import('jsonwebtoken');
    const jti = newId('sess');
    const token = sign({ sub: userId, jti }, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      issuer: 'deplogram',
    });
    const now = isoNow();
    await this.pool.query(
      `INSERT INTO sessions (id, token, user_id, browser, os, device, location, ip, last_active_at, created_at, current, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,TRUE,NULL)
       ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, current = TRUE, revoked_at = NULL`,
      [jti, token, userId, info.browser, info.os, info.device, info.location, info.ip, now],
    );
    await this.pool.query("UPDATE sessions SET current = FALSE WHERE user_id = $1 AND id <> $2", [userId, jti]);
    return token;
  }

  async getSession(token: string): Promise<{ userId: string } | undefined> {
    const { verify } = await import('jsonwebtoken');
    let payload: any;
    try {
      payload = verify(token, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', { issuer: 'deplogram' });
    } catch {
      return undefined;
    }
    const { rows } = await this.pool.query(
      'SELECT user_id, revoked_at, token FROM sessions WHERE id = $1 LIMIT 1',
      [payload.jti],
    );
    if (rows.length === 0) return undefined;
    const session = rows[0];
    if (session.revoked_at || session.token !== token) return undefined;
    return { userId: session.user_id };
  }

  async touchSession(token: string): Promise<void> {
    const { verify } = await import('jsonwebtoken');
    let payload: any;
    try {
      payload = verify(token, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', { issuer: 'deplogram' });
    } catch {
      return;
    }
    await this.pool.query('UPDATE sessions SET last_active_at = $1 WHERE id = $2 AND revoked_at IS NULL', [isoNow(), payload.jti]);
  }

  async getSessions(userId: string): Promise<SessionDto[]> {
    const { rows } = await this.pool.query(
      'SELECT id, browser, os, device, location, ip, last_active_at, created_at, current FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      browser: r.browser,
      os: r.os,
      device: r.device,
      location: r.location ?? null,
      ip: r.ip,
      lastActiveAt: r.last_active_at,
      createdAt: r.created_at,
      current: r.current,
    }));
  }

  async endSession(token: string): Promise<boolean> {
    const { verify } = await import('jsonwebtoken');
    let payload: any;
    try {
      payload = verify(token, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', { issuer: 'deplogram' });
    } catch {
      return false;
    }
    const res = await this.pool.query('DELETE FROM sessions WHERE id = $1 AND revoked_at IS NULL', [payload.jti]);
    return (res.rowCount ?? 0) > 0;
  }

  async endOtherSessions(currentSessionToken: string): Promise<void> {
    const { verify } = await import('jsonwebtoken');
    let payload: any;
    try {
      payload = verify(currentSessionToken, process.env.JWT_SECRET ?? 'deplogram-dev-secret-do-not-use-in-production', { issuer: 'deplogram' });
    } catch {
      return;
    }
    await this.pool.query('DELETE FROM sessions WHERE id <> $1 AND revoked_at IS NULL', [payload.jti]);
  }

  // ── workspaces ───────────────────────────────────────────────────────────────

  private async ensurePersonalWorkspaceTx(userId: string, _txUserId: string, now: string): Promise<void> {
    const { rows } = await this.pool.query('SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1', [userId]);
    if (rows.length > 0) return;
    const id = newId('ws');
    await this.pool.query(
      'INSERT INTO workspaces (id, name, kind, plan, owner_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, 'Personal', 'personal', 'free', userId, now],
    );
    await this.pool.query('INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1,$2)', [id, userId]);
  }

  async currentWorkspace(userId: string): Promise<Workspace> {
    const { rows } = await this.pool.query('SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1', [userId]);
    if (rows.length === 0) {
      const id = newId('ws');
      const now = isoNow();
      await this.pool.query('INSERT INTO workspaces (id, name, kind, plan, owner_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, 'Personal', 'personal', 'free', userId, now]);
      await this.pool.query('INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1,$2)', [id, userId]);
      return { id, name: 'Personal', kind: 'personal', plan: 'free' };
    }
    const row = rows[0];
    const { rows: p } = await this.pool.query('SELECT name, kind, plan FROM workspaces WHERE id = $1 LIMIT 1', [row.id]);
    return { id: row.id, name: p[0].name, kind: p[0].kind, plan: p[0].plan };
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query('SELECT name, kind, plan FROM workspaces WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    return { id, name: rows[0].name, kind: rows[0].kind, plan: rows[0].plan };
  }

  // ── projects ─────────────────────────────────────────────────────────────────

  private defaultRuntimeVersion(runtime: string): string {
    switch (runtime) {
      case 'nextjs': return '22.14.0';
      case 'node': return '22.x';
      case 'python': return '3.12';
      case 'php': return '8.3';
      case 'go': return '1.23';
      default: return 'latest';
    }
  }

  async createProject(
    userId: string,
    input: {
      name: string;
      repositoryId: string;
      branch: string;
      runtime: string;
      config: { buildCommand: string | null; startCommand: string | null; port: number | null; rootDirectory: string | null };
      env: { key: string; value: string }[],
    },
    id?: string,
  ): Promise<Project> {
    const workspace = await this.currentWorkspace(userId);
    const { rows } = await this.pool.query('SELECT full_name FROM git_repositories WHERE id = $1 LIMIT 1', [input.repositoryId]);
    const repository = rows[0]?.full_name ?? '';
    const projectId = id ?? newId('proj');
    const now = isoNow();
    const config = {
      runtimeVersion: this.defaultRuntimeVersion(input.runtime),
      buildCommand: input.config.buildCommand,
      startCommand: input.config.startCommand,
      port: input.config.port,
      rootDirectory: input.config.rootDirectory,
    };
    const env = this.applyEnv(input.env);
    await this.pool.query(
      `INSERT INTO projects (id, workspace_id, name, runtime, state, url, repository, branch, updated_at, created_at, env_count, config, env)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$8,0,$9,$10)`,
      [projectId, workspace.id, input.name, input.runtime, 'QUEUED', repository, input.branch, now, JSON.stringify(config), JSON.stringify(env)],
    );
    const user = await this.getUser(userId);
    await this.recordActivity(user ?? null, 'project.created', input.name, projectId, null, 'created project');
    return {
      id: projectId,
      name: input.name,
      runtime: input.runtime,
      state: 'QUEUED',
      url: null,
      repository,
      branch: input.branch,
      updatedAt: now,
      latest: null,
      recent: [],
      createdAt: now,
      liveDeploymentId: null,
      envCount: 0,
      config,
      env,
    };
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
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    return this.projectRowToProject(rows[0]);
  }

  async listProjects(workspaceId: string): Promise<Project[]> {
    const { rows } = await this.pool.query('SELECT * FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC', [workspaceId]);
    const projects: Project[] = [];
    for (const row of rows) {
      projects.push(await this.projectRowToProject(row));
    }
    return projects;
  }

  private async projectRowToProject(row: any): Promise<Project> {
    const deployments = await this.deploymentsOfProject(row.id);
    const latest = deployments[0];
    const state: DeploymentState = latest ? latest.state : 'QUEUED';
    const env: ProjectEnvVar[] = Array.isArray(row.env) ? row.env : [];
    return {
      id: row.id,
      name: row.name,
      runtime: row.runtime,
      state,
      url: state === 'RUNNING' && latest ? row.url ?? null : null,
      repository: row.repository,
      branch: row.branch,
      updatedAt: row.updated_at,
      latest: latest
        ? { id: latest.id, state: latest.state, live: latest.live, sha: latest.commit.sha, message: latest.commit.message, createdAt: latest.createdAt }
        : null,
      recent: deployments.slice(0, 10).map((d) => d.state),
      createdAt: row.created_at,
      liveDeploymentId: row.live_deployment_id ?? null,
      envCount: env.length,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      env,
    };
  }

  async updateProject(
    id: string,
    update: { name?: string; branch?: string; config?: { buildCommand?: string | null; startCommand?: string | null; port?: number | null; rootDirectory?: string | null } },
  ): Promise<Project | undefined> {
    const project = await this.getProject(id);
    if (!project) return undefined;
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (update.name !== undefined) { sets.push(`name = $${i++}`); params.push(update.name); }
    if (update.branch !== undefined) { sets.push(`branch = $${i++}`); params.push(update.branch); }
    if (update.config) {
      const config = { ...project.config, ...update.config };
      sets.push(`config = $${i++}`); params.push(JSON.stringify(config));
    }
    sets.push(`updated_at = $${i++}`); params.push(isoNow());
    params.push(id);
    await this.pool.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${i}`, params);
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<void> {
    const project = await this.getProject(id);
    await this.pool.query('DELETE FROM deployments WHERE project_id = $1', [id]);
    await this.pool.query('DELETE FROM projects WHERE id = $1', [id]);
    const user = project ? await this.getUser(project.workspaceId!) : undefined;
    await this.recordActivity(user ?? null, 'project.deleted', project?.name ?? '', id, null, 'deleted project');
  }

  async getEnvVars(projectId: string): Promise<EnvVarRecord[]> {
    const project = await this.getProject(projectId);
    if (!project) return [];
    return project.env.map((v) => ({ key: v.key, updatedAt: v.updatedAt }));
  }

  async saveEnvVars(projectId: string, values: { key: string; value: string | null }[]): Promise<EnvVarRecord[]> {
    const project = await this.getProject(projectId);
    if (!project) return [];
    const saved = new Map<string, { value: string | null; updatedAt: string }>();
    for (const variable of project.env) {
      const entry = values.find((v) => v.key === variable.key);
      if (!entry) continue;
      saved.set(variable.key, entry.value === null ? { value: variable.value, updatedAt: variable.updatedAt } : { value: entry.value, updatedAt: isoNow() });
    }
    for (const value of values) {
      if (value.value === null) continue;
      if (saved.has(value.key)) continue;
      saved.set(value.key, { value: value.value, updatedAt: isoNow() });
    }
    const env = [...saved.entries()].map(([key, variable]) => ({ key, value: variable.value, updatedAt: variable.updatedAt })).sort((a, b) => a.key.localeCompare(b.key));
    await this.pool.query('UPDATE projects SET env = $1, env_count = $2, updated_at = $3 WHERE id = $4', [JSON.stringify(env), env.length, isoNow(), projectId]);
    const user = await this.getUser(project.workspaceId!);
    await this.recordActivity(user ?? null, 'env.updated', project.name, projectId, null, `saved ${env.length} variables`);
    return env.map((v) => ({ key: v.key, updatedAt: v.updatedAt }));
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
    const project = await this.getProject(projectId);
    if (!project) throw new Error('Unknown project');
    const previous = await this.latestDeployment(projectId);
    const deploymentId = id ?? newId('dep');
    const createdAt = options.createdAt ?? isoNow();
    const deployment: Deployment = {
      id: deploymentId,
      projectId,
      projectName: project.name,
      runtime: project.runtime,
      state: 'QUEUED',
      live: false,
      commit: { sha: options.commitSha, message: options.commitMessage, branch: project.branch, author: options.author },
      trigger: options.trigger,
      createdAt,
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
    await this.pool.query(
      `INSERT INTO deployments (id, project_id, project_name, runtime, state, live, commit, trigger, created_at, duration_seconds, url, config, previous_live_id)
       VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,$8,NULL,NULL,$9,$10)`,
      [deploymentId, projectId, project.name, project.runtime, 'QUEUED', JSON.stringify(deployment.commit), options.trigger, createdAt, JSON.stringify(deployment.config), deployment.previousLiveId],
    );
    await this.pool.query('UPDATE projects SET state = $1, updated_at = $2 WHERE id = $3', ['QUEUED', isoNow(), projectId]);
    const user = await this.getUser(project.workspaceId!);
    await this.recordActivity(user ?? null, 'deployment.started', project.name, projectId, deploymentId, `started by ${options.trigger}`);
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM deployments WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    return this.deploymentRowToDeployment(rows[0]);
  }

  async deploymentsOfProject(projectId: string): Promise<Deployment[]> {
    const { rows } = await this.pool.query('SELECT * FROM deployments WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    const result: Deployment[] = [];
    for (const row of rows) result.push(this.deploymentRowToDeployment(row));
    return result;
  }

  private deploymentRowToDeployment(row: any): Deployment {
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      runtime: row.runtime,
      state: row.state,
      live: Boolean(row.live),
      commit: typeof row.commit === 'string' ? JSON.parse(row.commit) : row.commit,
      trigger: row.trigger,
      createdAt: row.created_at,
      durationSeconds: row.duration_seconds ?? null,
      url: row.url ?? null,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      previousLiveId: row.previous_live_id ?? null,
    };
  }

  async allDeployments(workspaceId: string): Promise<Deployment[]> {
    const { rows } = await this.pool.query(
      `SELECT d.* FROM deployments d JOIN projects p ON p.id = d.project_id WHERE p.workspace_id = $1 ORDER BY d.created_at DESC`,
      [workspaceId],
    );
    return rows.map((row) => this.deploymentRowToDeployment(row));
  }

  async latestDeployment(projectId: string): Promise<Deployment | undefined> {
    const deps = await this.deploymentsOfProject(projectId);
    return deps[0];
  }

  async markLive(projectId: string, deploymentId: string): Promise<void> {
    await this.client(async (client) => {
      await client.query('UPDATE deployments SET live = FALSE WHERE project_id = $1', [projectId]);
      const { rows } = await client.query('SELECT name FROM projects WHERE id = $1 LIMIT 1', [projectId]);
      const name = rows[0]?.name ?? '';
      const url = `${name}.deplogram.app`;
      await client.query('UPDATE deployments SET live = TRUE, state = $1, url = $2 WHERE id = $3', ['RUNNING', url, deploymentId]);
      await client.query('UPDATE projects SET live_deployment_id = $1, state = $2, updated_at = $3 WHERE id = $4', [deploymentId, 'RUNNING', isoNow(), projectId]);
    });
  }

  async rollbackTo(projectId: string, deploymentId: string): Promise<Deployment | undefined> {
    const deployment = await this.getDeployment(deploymentId);
    const project = await this.getProject(projectId);
    if (!deployment || !project) return undefined;
    const targetId = deployment.previousLiveId;
    if (!targetId) return undefined;
    const target = await this.getDeployment(targetId);
    if (!target) return undefined;
    await this.markLive(projectId, targetId);
    deployment.live = false;
    const user = await this.getUser(project.workspaceId!);
    await this.recordActivity(user ?? null, 'deployment.rolled_back', project.name, projectId, deploymentId, `rolled back to ${target.id}`);
    return target;
  }

  async finishDeployment(deploymentId: string, state: DeploymentState): Promise<void> {
    const row = await this.pool.query('SELECT created_at FROM deployments WHERE id = $1 LIMIT 1', [deploymentId]);
    let durationSeconds = null;
    if (row.rows.length > 0) {
      durationSeconds = Math.max(0, Math.round((Date.now() - new Date(row.rows[0].created_at).getTime()) / 1000));
    }
    await this.pool.query('UPDATE deployments SET state = $1, duration_seconds = $2 WHERE id = $3', [state, durationSeconds, deploymentId]);
  }

  // ── logs ─────────────────────────────────────────────────────────────────────

  async appendBuildLog(deploymentId: string, entries: [BuildStepId, 'stdout' | 'stderr', string][]): Promise<void> {
    const client = await this.pool.connect();
    try {
      let n = 0;
      const existing = await client.query('SELECT COALESCE(MAX(n), 0) AS max_n FROM deployment_build_logs WHERE deployment_id = $1', [deploymentId]);
      n = Number(existing.rows[0].max_n);
      for (const [step, stream, text] of entries) {
        n += 1;
        await client.query('INSERT INTO deployment_build_logs (deployment_id, n, at, step, stream, text) VALUES ($1,$2,$3,$4,$5,$6)', [deploymentId, n, isoNow(), step, stream, text]);
      }
    } finally {
      client.release();
    }
  }

  async appendRuntimeLog(deploymentId: string, entries: [RuntimeLogLevel, RuntimeLogSource, string][]): Promise<void> {
    const client = await this.pool.connect();
    try {
      let n = 0;
      const existing = await client.query('SELECT COALESCE(MAX(n), 0) AS max_n FROM deployment_runtime_logs WHERE deployment_id = $1', [deploymentId]);
      n = Number(existing.rows[0].max_n);
      for (const [level, source, text] of entries) {
        n += 1;
        await client.query('INSERT INTO deployment_runtime_logs (deployment_id, n, at, level, source, text) VALUES ($1,$2,$3,$4,$5,$6)', [deploymentId, n, isoNow(), level, source, text]);
      }
    } finally {
      client.release();
    }
  }

  async getBuildLog(deploymentId: string, after: number): Promise<{ lines: BuildLogLine[]; end: number }> {
    const { rows } = await this.pool.query('SELECT n, at, step, stream, text FROM deployment_build_logs WHERE deployment_id = $1 AND n > $2 ORDER BY n ASC', [deploymentId, after]);
    let end = after;
    for (const row of rows) end = row.n;
    return { lines: rows.map((r) => ({ n: r.n, at: r.at, step: r.step, stream: r.stream, text: r.text })), end };
  }

  async getRuntimeLog(deploymentId: string, after: number): Promise<{ lines: RuntimeLogLine[]; end: number }> {
    const { rows } = await this.pool.query('SELECT n, at, level, source, text FROM deployment_runtime_logs WHERE deployment_id = $1 AND n > $2 ORDER BY n ASC', [deploymentId, after]);
    let end = after;
    for (const row of rows) end = row.n;
    return { lines: rows.map((r) => ({ n: r.n, at: r.at, level: r.level, source: r.source, text: r.text })), end };
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
    if (actor) {
      const { rows } = await this.pool.query('SELECT id FROM workspaces WHERE owner_id = $1 LIMIT 1', [actor.id]);
      workspaceId = rows[0]?.id ?? null;
    }
    const id = newId('evt');
    const at = isoNow();
    await this.pool.query(
      'INSERT INTO activity (id, at, type, actor_name, workspace_id, project_id, project_name, deployment_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, at, type, actor ? actor.name : 'system', workspaceId, projectId, projectName, deploymentId, detail],
    );
    await this.pool.query('INSERT INTO activity_order (event_id) VALUES ($1)', [id]);
  }

  async activityPage(afterCursor: string | null, limit: number, workspaceId?: string): Promise<ActivityPage> {
    let startPosition = 0;
    if (afterCursor) {
      const { rows } = await this.pool.query('SELECT position FROM activity_order WHERE event_id = $1 LIMIT 1', [afterCursor]);
      if (rows.length > 0) startPosition = Number(rows[0].position) + 1;
    }
    const params: any[] = [startPosition, limit];
    let workspaceFilter = '';
    if (workspaceId) {
      params.push(workspaceId);
      workspaceFilter = `AND a.workspace_id = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT a.id, a.at, a.type, a.actor_name, a.workspace_id, a.project_id, a.project_name, a.deployment_id, a.detail
       FROM activity a JOIN activity_order o ON o.event_id = a.id
       WHERE o.position >= $1 ${workspaceFilter}
       ORDER BY o.position ASC LIMIT $2`,
      params,
    );
    const items: ActivityEvent[] = rows.map((r) => ({
      id: r.id,
      at: r.at,
      type: r.type as ActivityType,
      actor: { name: r.actor_name },
      workspaceId: r.workspace_id ?? null,
      project: r.project_id ? { id: r.project_id, name: r.project_name ?? '' } : null,
      deployment: null,
      detail: r.detail ?? null,
    }));
    let nextCursor: string | null = null;
    if (rows.length === limit) {
      nextCursor = rows[rows.length - 1].id;
    }
    return { items, nextCursor };
  }

  async recentActivity(limit: number): Promise<ActivityEvent[]> {
    const page = await this.activityPage(null, limit);
    return page.items;
  }

  // ── traffic / access log ─────────────────────────────────────────────────────

  async appendRequest(
    deployment: Deployment,
    error: boolean,
    city: string,
    status: number,
    latencyMs: number,
    path: string,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO traffic (id, at, project_id, error, city, status, latency_ms, path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [newId('tr'), isoNow(), deployment.projectId, error, city, status, latencyMs, path],
    );
  }

  async getRequests(): Promise<TrafficPoint[]> {
    const { rows } = await this.pool.query('SELECT at, project_id, error, city, status, latency_ms, path FROM traffic ORDER BY at DESC LIMIT 1000');
    return rows.map((r) => ({ at: r.at, projectId: r.project_id, error: r.error, city: r.city, status: r.status, latencyMs: r.latency_ms, path: r.path }));
  }

  async requestsOfProject(projectId: string): Promise<TrafficPoint[]> {
    const { rows } = await this.pool.query('SELECT at, project_id, error, city, status, latency_ms, path FROM traffic WHERE project_id = $1 ORDER BY at DESC LIMIT 1000', [projectId]);
    return rows.map((r) => ({ at: r.at, projectId: r.project_id, error: r.error, city: r.city, status: r.status, latencyMs: r.latency_ms, path: r.path }));
  }

  async getLiveDeployments(): Promise<Deployment[]> {
    const { rows } = await this.pool.query('SELECT * FROM deployments WHERE live = TRUE');
    return rows.map((row) => this.deploymentRowToDeployment(row));
  }

  // ── git ──────────────────────────────────────────────────────────────────────

  async getConnection(userId: string): Promise<GitConnection> {
    const { rows } = await this.pool.query('SELECT connected, account FROM git_connections WHERE user_id = $1 LIMIT 1', [userId]);
    const connected = Boolean(rows[0]?.connected);
    return { provider: 'github', connected, account: connected ? (rows[0].account ?? null) : null };
  }

  async getRepositories(userId: string, q?: string): Promise<GitRepository[]> {
    if (q) {
      const { rows } = await this.pool.query('SELECT * FROM git_repositories WHERE user_id = $1 AND full_name ILIKE $2 ORDER BY updated_at DESC', [userId, `%${q}%`]);
      return rows.map((r) => this.gitRepositoryRowToDto(r));
    }
    const { rows } = await this.pool.query('SELECT * FROM git_repositories WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return rows.map((r) => this.gitRepositoryRowToDto(r));
  }

  private gitRepositoryRowToDto(row: any): GitRepository {
    return { id: row.id, fullName: row.full_name, private: Boolean(row.private), defaultBranch: row.default_branch, updatedAt: row.updated_at, projectId: row.project_id ?? null };
  }

  async getBranches(repositoryId: string): Promise<GitBranch[]> {
    const { rows } = await this.pool.query('SELECT name, commit_sha, commit_message FROM git_branches WHERE repository_id = $1 ORDER BY name', [repositoryId]);
    return rows.map((r) => ({ name: r.name, commit: { sha: r.commit_sha, message: r.commit_message } }));
  }

  async detect(repositoryId: string, _branch: string): Promise<GitDetection> {
    const { rows } = await this.pool.query('SELECT * FROM git_repositories WHERE id = $1 LIMIT 1', [repositoryId]);
    if (rows.length === 0) return { runtime: null, evidence: null, buildCommand: null, startCommand: null, port: null, envExample: [] };
    return { runtime: null, evidence: null, buildCommand: null, startCommand: null, port: null, envExample: [] };
  }

  async connectGit(userId: string): Promise<{ url: string }> {
    const callback = this.githubCallbackUrl();
    const params = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID ?? '', redirect_uri: callback, scope: 'read:user,user:email,repo', state: userId });
    return { url: `https://github.com/login/oauth/authorize?${params.toString()}` };
  }

  async disconnectGit(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM git_connections WHERE user_id = $1', [userId]);
  }

  async getGitInstallations(userId: string): Promise<{ id: number; account: string; type: 'user' | 'organization'; repositorySelection: 'all' | 'selected'; repositories: number; installedAt: string; settingsUrl: string }[]> {
    const { rows } = await this.pool.query('SELECT connected, account FROM git_connections WHERE user_id = $1 LIMIT 1', [userId]);
    if (!rows[0]?.connected) return [];
    const { rows: repos } = await this.pool.query('SELECT id FROM git_repositories WHERE user_id = $1', [userId]);
    return [{ id: 1, account: rows[0].account ?? userId, type: 'user', repositorySelection: 'all', repositories: repos.length, installedAt: isoNow(), settingsUrl: 'https://github.com/settings/installations/1' }];
  }

  async githubAuthCallback(code: string, state: string): Promise<{ userId: string; account: string }> {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    let accessToken: string | null = null;
    if (clientId && clientSecret) {
      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
    await this.pool.query(
      'INSERT INTO git_connections (user_id, provider, connected, account, access_token) VALUES ($1,$2,TRUE,$3,$4) ON CONFLICT (user_id) DO UPDATE SET connected = TRUE, account = $3, access_token = $4',
      [userId, 'github', account, accessToken],
    );
    const repoId = `repo_${userId}`;
    const { rows } = await this.pool.query('SELECT id FROM git_repositories WHERE id = $1 LIMIT 1', [repoId]);
    if (rows.length === 0) {
      await this.pool.query('INSERT INTO git_repositories (id, user_id, full_name, private, default_branch, updated_at, project_id) VALUES ($1,$2,$3,TRUE,$4,$5,NULL)', [repoId, userId, `${account}/demo-repo`, 'main', isoNow()]);
      await this.pool.query('INSERT INTO git_branches (repository_id, name, commit_sha, commit_message) VALUES ($1,$2,$3,$4)', [repoId, 'main', 'a1b2c3d', 'Initial commit']);
    }
    return { userId, account };
  }

  private githubCallbackUrl(): string {
    const configured = process.env.GITHUB_CALLBACK_URL;
    if (configured) return configured;
    const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    return `${host}/v1/git/callback`;
  }

  private async fetchGitHubAccount(accessToken: string): Promise<string> {
    try {
      const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'deplogram-backend' } });
      if (res.ok) {
        const json = await res.json();
        if (typeof json.login === 'string') return json.login;
      }
    } catch {
      // ignore
    }
    return 'github';
  }

  // ── CodePad ──────────────────────────────────────────────────────────────────

  async listPads(userId: string): Promise<CodePadSummary[]> {
    const { rows } = await this.pool.query('SELECT * FROM codepads ORDER BY updated_at DESC');
    return rows.map((r) => {
      const files: CodePadFile[] = Array.isArray(r.files) ? r.files : [];
      return { id: r.id, name: r.name, runtime: r.runtime, fileCount: files.length, paths: files.map((f) => f.path), updatedAt: r.updated_at, projectId: r.project_id ?? null };
    });
  }

  async getPad(id: string): Promise<CodePad | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM codepads WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return { id: r.id, name: r.name, runtime: r.runtime, entry: r.entry, projectId: r.project_id ?? null, updatedAt: r.updated_at, files: Array.isArray(r.files) ? r.files : [] };
  }

  async createPad(userId: string, name: string, template: 'static' | 'node' | 'python'): Promise<CodePad> {
    const runtime = template;
    const entry = runtime === 'static' ? 'index.html' : runtime === 'node' ? 'index.js' : 'main.py';
    const files = this.initialPadFiles(runtime, entry);
    const id = newId('pad');
    const now = isoNow();
    await this.pool.query('INSERT INTO codepads (id, name, runtime, entry, project_id, updated_at, files) VALUES ($1,$2,$3,$4,NULL,$5,$6)', [id, name, runtime, entry, now, JSON.stringify(files)]);
    return { id, name, runtime, entry, projectId: null, updatedAt: now, files };
  }

  private initialPadFiles(runtime: string, entry: string): CodePadFile[] {
    const now = isoNow();
    if (runtime === 'static') return [
      { path: 'index.html', content: '<h1>Hello from CodePad</h1>\n', updatedAt: now },
      { path: 'style.css', content: 'body { margin: 0; }\n', updatedAt: now },
      { path: 'script.js', content: 'console.log("hello");\n', updatedAt: now },
    ];
    if (runtime === 'node') return [
      { path: 'index.js', content: 'console.log("hello from Node");\n', updatedAt: now },
      { path: 'package.json', content: '{"name":"hello-node","version":"1.0.0"}\n', updatedAt: now },
    ];
    return [
      { path: 'main.py', content: 'print("Hello from Python")\n', updatedAt: now },
      { path: 'requirements.txt', content: '', updatedAt: now },
    ];
  }

  async updatePad(id: string, name: string): Promise<CodePad | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    await this.pool.query('UPDATE codepads SET name = $1, updated_at = $2 WHERE id = $3', [name, isoNow(), id]);
    return { ...pad, name, updatedAt: isoNow() };
  }

  async deletePad(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM codepads WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async savePadFile(id: string, path: string, content: string): Promise<CodePadFile | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    const saved: CodePadFile = { path, content, updatedAt: isoNow() };
    const files = pad.files.map((f) => f.path === path ? saved : f);
    if (!files.some((f) => f.path === path)) files.push(saved);
    files.sort((a, b) => a.path.localeCompare(b.path));
    await this.pool.query('UPDATE codepads SET files = $1, updated_at = $2 WHERE id = $3', [JSON.stringify(files), isoNow(), id]);
    return saved;
  }

  async renamePadFile(id: string, from: string, to: string): Promise<CodePad | 'exists' | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    if (pad.files.some((f) => f.path === to)) return 'exists';
    const file = pad.files.find((f) => f.path === from);
    if (!file) return undefined;
    file.path = to;
    if (pad.entry === from) pad.entry = to;
    pad.files.sort((a, b) => a.path.localeCompare(b.path));
    await this.pool.query('UPDATE codepads SET files = $1, entry = $2, updated_at = $3 WHERE id = $4', [JSON.stringify(pad.files), pad.entry, isoNow(), id]);
    return pad;
  }

  async deletePadFile(id: string, path: string): Promise<CodePad | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    pad.files = pad.files.filter((f) => f.path !== path);
    if (pad.entry === path) pad.entry = pad.files[0]?.path ?? '';
    await this.pool.query('UPDATE codepads SET files = $1, entry = $2, updated_at = $3 WHERE id = $4', [JSON.stringify(pad.files), pad.entry, isoNow(), id]);
    return pad;
  }

  async startPadRun(id: string): Promise<string | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    const runId = newId('run');
    const script = padScript(pad);
    await this.pool.query('INSERT INTO codepad_runs (id, started_at, script, exit_code) VALUES ($1,$2,$3,$4)', [runId, Date.now(), JSON.stringify(script), 0]);
    return runId;
  }

  async getRunLogs(id: string, after: number): Promise<{ lines: CodePadRunLogLine[]; done: boolean; exitCode: number | null } | undefined> {
    const { rows } = await this.pool.query('SELECT script, started_at, exit_code FROM codepad_runs WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    const run = rows[0];
    const script: { text: string; stream?: 'stdout' | 'stderr'; delay: number }[] = Array.isArray(run.script) ? run.script : [];
    const elapsed = Date.now() - Number(run.started_at);
    let t = 0;
    const due = script.flatMap((line, i) => {
      t += line.delay;
      return t <= elapsed ? [{ n: i + 1, at: new Date(Number(run.started_at) + t).toISOString(), text: line.text, stream: line.stream ?? 'stdout' }] : [];
    });
    const done = due.length === script.length;
    return { lines: due.filter((l) => l.n > after), done, exitCode: done ? run.exit_code : null };
  }

  async deployPad(id: string): Promise<{ project: ProjectSummary; deployment: Deployment } | undefined> {
    const pad = await this.getPad(id);
    if (!pad) return undefined;
    if (pad.projectId) {
      const project = await this.getProject(pad.projectId);
      if (!project) return undefined;
      const latest = await this.latestDeployment(pad.projectId);
      if (!latest) return undefined;
      const fresh = await this.createDeployment(pad.projectId, { trigger: 'manual', commitSha: Math.random().toString(16).slice(2, 9), commitMessage: 'Deployed from CodePad', author: { name: 'You', avatarUrl: null } });
      return { project: this.summarizeProject(project), deployment: fresh };
    }
    const repoId = `codepad_${pad.name}`;
    const { rows } = await this.pool.query('SELECT id FROM git_repositories WHERE id = $1 LIMIT 1', [repoId]);
    if (rows.length === 0) {
      await this.pool.query('INSERT INTO git_repositories (id, user_id, full_name, private, default_branch, updated_at, project_id) VALUES ($1,$2,$3,TRUE,$4,$5,NULL)', [repoId, 'system', `codepad/${pad.name}`, 'codepad', isoNow()]);
    }
    const config = { runtimeVersion: 'latest', buildCommand: null, startCommand: pad.runtime === 'static' ? null : pad.runtime === 'node' ? `node ${pad.entry}` : `python ${pad.entry}`, port: pad.runtime === 'static' ? null : pad.runtime === 'node' ? 3000 : 8000, rootDirectory: null };
    const project = await this.createProject('system', { name: pad.name, repositoryId: repoId, branch: 'codepad', runtime: pad.runtime, config, env: [] }, newId('proj'));
    const deployment = await this.createDeployment(project.id, { trigger: 'manual', commitSha: Math.random().toString(16).slice(2, 9), commitMessage: 'Deployed from CodePad', author: { name: 'You', avatarUrl: null } });
    await this.pool.query('UPDATE codepads SET project_id = $1 WHERE id = $2', [project.id, id]);
    return { project: this.summarizeProject(project), deployment };
  }

  private summarizeProject(project: Project): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      runtime: project.runtime,
      state: project.state,
      url: project.state === 'RUNNING' ? project.url : null,
      repository: project.repository,
      branch: project.branch,
      updatedAt: project.updatedAt,
      latest: project.latest,
      recent: project.recent,
    };
  }

  // ── storage ──────────────────────────────────────────────────────────────────

  async getStorageList(path: string): Promise<{ path: string; items: StorageItem[]; public: boolean; publicFrom: string | null } | undefined> {
    const exists = path === '' || (await this.pool.query('SELECT 1 FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1', [path, 'folder'])).rows.length > 0;
    if (!exists) return undefined;
    const { rows } = await this.pool.query('SELECT * FROM storage_items WHERE path LIKE $1 AND kind = $2', [path === '' ? '%' : path + '/%', 'folder']);
    // direct children only
    const prefix = path === '' ? '' : `${path}/`;
    const items: StorageItem[] = [];
    for (const row of rows) {
      const rel = row.path.slice(prefix.length);
      if (rel.includes('/')) continue;
      items.push(this.storageItemRowToDto(row));
    }
    const publicFrom = await this.storagePublicFrom(path);
    return { path, items, public: publicFrom != null, publicFrom };
  }

  async searchStorage(q: string): Promise<StorageItem[]> {
    const { rows } = await this.pool.query("SELECT * FROM storage_items WHERE name ILIKE $1 LIMIT 50", [`%${q}%`]);
    return rows.map((r) => this.storageItemRowToDto(r));
  }

  async getStorageFolders(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT path FROM storage_items WHERE kind = 'folder' ORDER BY path");
    return rows.map((r) => r.path);
  }

  async createStorageFolder(path: string): Promise<StorageItem | 'exists' | 'no-parent'> {
    const existing = await this.pool.query('SELECT 1 FROM storage_items WHERE path = $1 LIMIT 1', [path]);
    if (existing.rows.length > 0) return 'exists';
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && (await this.pool.query('SELECT 1 FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1', [parent, 'folder'])).rows.length === 0) return 'no-parent';
    const now = isoNow();
    const folder = {
      path,
      kind: 'folder' as const,
      name: path.split('/').pop()!,
      size: 0,
      content_type: null,
      items: 0,
      created_at: now,
      updated_at: now,
      thumbnail_url: null,
      public: false,
      public_url: null,
    };
    await this.pool.query('INSERT INTO storage_items (path, kind, name, size, content_type, items, created_at, updated_at, thumbnail_url, public, public_url) VALUES ($1,$2,$3,0,NULL,0,$4,$4,NULL,FALSE,NULL)', [path, 'folder', path.split('/').pop()!, now]);
    return this.storageItemRowToDto(folder);
  }

  async completeStorageUpload(token: string, bytes: ArrayBuffer | null): Promise<StorageItem | undefined> {
    const { rows } = await this.pool.query('SELECT path, size, content_type FROM storage_links WHERE token = $1 LIMIT 1', [token]);
    if (rows.length === 0) return undefined;
    const { path, size, content_type } = rows[0];
    await this.pool.query('DELETE FROM storage_links WHERE token = $1', [token]);
    return this.addStorageFile(path, size, content_type, bytes);
  }

  async createStorageUpload(path: string, size: number, contentType: string): Promise<{ uploadUrl: string } | undefined> {
    const used = await this.storageUsedBytes();
    if (used + size > 256 * 1024 * 1024) return undefined;
    const token = newId('upt');
    await this.pool.query('INSERT INTO storage_links (token, path, size, content_type) VALUES ($1,$2,$3,$4)', [token, path, size, contentType]);
    return { uploadUrl: `/v1/storage/uploads/${token}` };
  }

  async renameStorageItem(path: string, name: string, makePublic?: boolean): Promise<StorageItem | null | 'exists' | 'missing'> {
    if (makePublic !== undefined) {
      const item = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1', [path, 'folder']);
      if (item.rows.length === 0) return null;
      await this.pool.query('UPDATE storage_items SET public = $1, updated_at = $2 WHERE path = $3', [makePublic, isoNow(), path]);
      const updated = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 LIMIT 1', [path]);
      return this.storageItemRowToDto(updated.rows[0]);
    }
    if (!name) return 'missing';
    const item = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 LIMIT 1', [path]);
    if (item.rows.length === 0) return 'missing';
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const to = parent ? `${parent}/${name}` : name;
    if (to !== path && (await this.pool.query('SELECT 1 FROM storage_items WHERE path = $1 LIMIT 1', [to])).rows.length > 0) return 'exists';
    await this.storageRelocate(path, to);
    const updated = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 LIMIT 1', [to]);
    return this.storageItemRowToDto(updated.rows[0]);
  }

  async moveStorageItems(paths: string[], to: string): Promise<number | 'bad-target'> {
    const target = await this.pool.query("SELECT 1 FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1", [to, 'folder']);
    if (target.rows.length === 0) return 'bad-target';
    if (paths.some((p) => to === p || to.startsWith(`${p}/`))) return 'bad-target';
    let moved = 0;
    for (const path of paths) {
      const item = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 LIMIT 1', [path]);
      if (item.rows.length === 0) continue;
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent === to) continue;
      const taken = new Set((await this.getStorageListSync(to)).items.map((i) => i.name));
      let itemName = item.rows[0].name;
      for (let n = 1; taken.has(itemName); n += 1) itemName = `${item.rows[0].name} (${n})`;
      await this.storageRelocate(path, to ? `${to}/${itemName}` : itemName);
      moved += 1;
    }
    return moved;
  }

  async deleteStorageItems(paths: string[]): Promise<{ deleted: number; freed: number }> {
    let freed = 0;
    let deleted = 0;
    for (const path of paths) {
      const { rows } = await this.pool.query("SELECT path, kind, size FROM storage_items WHERE path = $1 OR path LIKE $2", [path, `${path}/%`]);
      for (const row of rows) {
        if (row.kind === 'file') freed += row.size;
        await this.pool.query('DELETE FROM storage_items WHERE path = $1', [row.path]);
        await this.pool.query('DELETE FROM storage_contents WHERE path = $1', [row.path]);
        if (row.path === path) deleted += 1;
      }
    }
    return { deleted, freed };
  }

  async previewStorage(path: string): Promise<{ url: string | null; text: string | null; truncated: boolean } | undefined> {
    const item = await this.pool.query('SELECT * FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1', [path, 'file']);
    if (item.rows.length === 0) return undefined;
    const row = item.rows[0];
    const content = await this.pool.query('SELECT bytes, text FROM storage_contents WHERE path = $1 LIMIT 1', [path]);
    const isTextLike = this.storageItemIsTextLike({ name: row.name, contentType: row.content_type });
    if (isTextLike) {
      const text = content.rows[0]?.text ?? null;
      const limit = 200_000;
      return { url: null, text: text && text.length > limit ? text.slice(0, limit) : text, truncated: Boolean(text && text.length > limit) };
    }
    const contentRow = content.rows[0];
    return { url: contentRow?.url ?? row.public_url ?? null, text: null, truncated: false };
  }

  async createStorageLink(path: string, expiresIn: '1h' | '1d' | '7d'): Promise<{ url: string; expiresAt: string } | undefined> {
    const { rows } = await this.pool.query('SELECT 1 FROM storage_items WHERE path = $1 LIMIT 1', [path]);
    if (rows.length === 0) return undefined;
    const ms = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000 }[expiresIn];
    const token = newId('lnk');
    const url = `https://files.dpl.app/${encodeURI(path)}?token=${token}`;
    await this.pool.query('INSERT INTO storage_links (token, path, size, content_type) VALUES ($1,$2,0,$3)', [token, path, 'application/octet-stream']);
    return { url, expiresAt: new Date(Date.now() + ms).toISOString() };
  }

  private storageItemRowToDto(row: any): StorageItem {
    return {
      kind: row.kind,
      name: row.name,
      path: row.path,
      size: row.size,
      contentType: row.content_type ?? null,
      items: row.items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      thumbnailUrl: row.thumbnail_url ?? null,
      public: Boolean(row.public),
      publicUrl: row.public_url ?? null,
    };
  }

  private async storagePublicFrom(path: string): Promise<string | null> {
    let p = path;
    while (p) {
      const row = await this.pool.query('SELECT public FROM storage_items WHERE path = $1 AND kind = $2 LIMIT 1', [p, 'folder']);
      if (row.rows[0]?.public) return p;
      p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    }
    return null;
  }

  private async storageUsedBytes(): Promise<number> {
    const { rows } = await this.pool.query("SELECT COALESCE(SUM(size), 0) AS total FROM storage_items WHERE kind = 'file'");
    return Number(rows[0].total);
  }

  private async storageRelocate(from: string, to: string) {
    const rows = await this.pool.query("SELECT path FROM storage_items WHERE path = $1 OR path LIKE $2", [from, `${from}/%`]);
    for (const row of rows.rows) {
      const next = to + row.path.slice(from.length);
      await this.pool.query('UPDATE storage_items SET path = $1, name = $2, updated_at = $3 WHERE path = $4', [next, next.split('/').pop()!, isoNow(), row.path]);
      await this.pool.query('UPDATE storage_contents SET path = $1 WHERE path = $2', [next, row.path]);
    }
  }

  private async getStorageListSync(path: string): Promise<{ path: string; items: StorageItem[]; public: boolean; publicFrom: string | null }> {
    const { rows } = await this.pool.query("SELECT * FROM storage_items WHERE path LIKE $1 AND kind = $2", [path === '' ? '%' : path + '/%', 'folder']);
    const prefix = path === '' ? '' : `${path}/`;
    const items: StorageItem[] = [];
    for (const row of rows) {
      const rel = row.path.slice(prefix.length);
      if (rel.includes('/')) continue;
      items.push(this.storageItemRowToDto(row));
    }
    return { path, items, public: false, publicFrom: null };
  }

  private storageItemIsTextLike(item: { name: string; contentType: string | null }): boolean {
    const type = item.contentType ?? '';
    const ext = item.name.split('.').pop()?.toLowerCase() ?? '';
    return type.startsWith('text/') || /json|xml|javascript|yaml/.test(type) || ['md','txt','csv','json','js','ts','py','html','css','sql','yml','yaml','env'].includes(ext);
  }

  private addStorageFile(path: string, size: number, contentType: string, bytes: ArrayBuffer | null): Promise<StorageItem> {
    throw new Error('addStorageFile not implemented in PostgresDatabase');
  }

  // ── webhooks ─────────────────────────────────────────────────────────────────

  async getWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint | null> {
    const { rows } = await this.pool.query('SELECT url, created_at FROM webhooks ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) return null;
    return { url: rows[0].url, createdAt: rows[0].created_at };
  }

  async rotateWebhookEndpoint(workspaceId: string): Promise<WebhookEndpoint> {
    const token = () => Math.random().toString(36).slice(2, 10);
    const url = `https://hooks.dpl.app/h/${token()}`;
    await this.pool.query('DELETE FROM webhooks');
    await this.pool.query('INSERT INTO webhooks (url, created_at) VALUES ($1,$2)', [url, isoNow()]);
    await this.pool.query('DELETE FROM webhook_requests');
    return { url, createdAt: isoNow() };
  }

  async listWebhookRequests(workspaceId: string): Promise<WebhookRequest[]> {
    const { rows } = await this.pool.query('SELECT * FROM webhook_requests ORDER BY received_at DESC LIMIT 50');
    return rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      query: Array.isArray(r.query) ? r.query : [],
      headers: Array.isArray(r.headers) ? r.headers : [],
      body: r.body,
      contentType: r.content_type ?? null,
      size: r.size,
      ip: r.ip,
      receivedAt: r.received_at,
    }));
  }

  async clearWebhookRequests(workspaceId: string): Promise<void> {
    await this.pool.query('DELETE FROM webhook_requests');
  }

  async captureWebhookRequest(workspaceId: string, request: Omit<WebhookRequest, 'id' | 'receivedAt'>): Promise<WebhookRequest> {
    const id = `wh_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const receivedAt = isoNow();
    await this.pool.query(
      'INSERT INTO webhook_requests (id, method, path, query, headers, body, content_type, size, ip, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, request.method, request.path, JSON.stringify(request.query), JSON.stringify(request.headers), request.body, request.contentType ?? null, request.size, request.ip, receivedAt],
    );
    return { ...request, id, receivedAt };
  }

  async getWebhookRequest(id: string): Promise<WebhookRequest | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM webhook_requests WHERE id = $1 LIMIT 1', [id]);
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return { id: r.id, method: r.method, path: r.path, query: r.query, headers: r.headers, body: r.body, contentType: r.content_type ?? null, size: r.size, ip: r.ip, receivedAt: r.received_at };
  }

  // ── APIs ─────────────────────────────────────────────────────────────────────

  async listApiKeys(userId: string): Promise<ApiKey[]> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, mode: r.mode, access: Array.isArray(r.access) ? r.access : [], createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null, createdBy: r.created_by }));
  }

  async createApiKey(userId: string, input: NewApiKey): Promise<CreatedApiKey> {
    const secret = `dpl_${input.mode}_${Math.random().toString(16).slice(2, 42)}`;
    const id = newId('key');
    const user = await this.getUser(userId);
    const now = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO api_keys (id, user_id, name, prefix, mode, access, created_at, last_used_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)',
      [id, userId, input.name, secret.slice(0, 13), input.mode, JSON.stringify(input.access), now, user ? user.name : 'you'],
    );
    return { id, name: input.name, prefix: secret.slice(0, 13), mode: input.mode, access: input.access, createdAt: now, lastUsedAt: null, createdBy: user ? user.name : 'you', secret };
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
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
    if (api) {
      const { rows } = await this.pool.query('SELECT * FROM api_requests WHERE api = $1 ORDER BY at DESC LIMIT 50', [api]);
      return rows.map((r) => ({ id: r.id, api: r.api, method: r.method, path: r.path, status: r.status, durationMs: r.duration_ms, keyPrefix: r.key_prefix, mode: r.mode, at: r.at }));
    }
    const { rows } = await this.pool.query('SELECT * FROM api_requests ORDER BY at DESC LIMIT 50');
    return rows.map((r) => ({ id: r.id, api: r.api, method: r.method, path: r.path, status: r.status, durationMs: r.duration_ms, keyPrefix: r.key_prefix, mode: r.mode, at: r.at }));
  }

  async tryApi(request: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }): Promise<{ status: number; durationMs: number; body: unknown }> {
    const started = Date.now();
    const api = this.apiOfPath(request.path);
    const status = api ? 200 : 404;
    const body = api ? { id: `t_${Math.random().toString(16).slice(2, 10)}`, ok: true } : { error: { code: 'not_found', message: `No endpoint ${request.method} ${request.path}.` } };
    const durationMs = Math.max(1, Date.now() - started);
    const entry = { id: `req_${Math.random().toString(16).slice(2, 10)}`, api: api ?? 'otp', method: request.method, path: request.path, status, durationMs, keyPrefix: 'dpl_test_9c1e', mode: 'test', at: new Date().toISOString() };
    await this.pool.query(
      'INSERT INTO api_requests (id, api, method, path, status, duration_ms, key_prefix, mode, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [entry.id, entry.api, entry.method, entry.path, entry.status, entry.durationMs, entry.keyPrefix, entry.mode, entry.at],
    );
    return { status, durationMs, body };
  }

  private apiOfPath(path: string): ApiId | undefined {
    const segment = path.split('/')[2];
    return API_IDS.includes(segment as ApiId) ? (segment as ApiId) : undefined;
  }
}

function padScript(pad: {
  runtime: string;
  entry: string;
  files: { path: string; content?: string }[];
}): { text: string; stream?: 'stdout' | 'stderr'; delay: number }[] {
  const { runtime, entry, files } = pad;
  if (runtime === 'static') {
    return [
      { text: `$ serve . (${files.length} files)`, delay: 150 },
      { text: `Serving ${entry} with ${files.filter((f) => f.path.endsWith('.css')).length} stylesheet(s) and ${files.filter((f) => f.path.endsWith('.js')).length} script(s)`, delay: 350 },
      { text: "Preview is live in the panel on the right.", delay: 150 },
    ];
  }
  if (runtime === 'python') {
    const entryFile = files.find((f) => f.path === entry);
    const names = entryFile?.content?.match(/\["([^\]]+)"\]/)?.[1]?.split(/",\s*"/) ?? [];
    const day = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
    return [
      { text: `$ python ${entry}`, delay: 200 },
      ...(names.length ? names.map((n, i) => ({ text: `Hello, ${n}! Today is ${day}.`, delay: i === 0 ? 600 : 80 })) : [{ text: '(no output)', delay: 600 }]),
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
