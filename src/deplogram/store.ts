/**
 * The Deplogram database — an in-memory store, seeded on boot.
 *
 * The web frontend talks to these modules over HTTP; nothing here touches the
 * network. Keeping the store in one place lets every feature read and write the
 * same records (projects, deployments, the activity log, the access log…) without
 * pulling in a database dependency.
 */
import { Injectable } from '@nestjs/common';

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
  TryRequest,
  User,
  Viewer,
  WebhookEndpoint,
  WebhookRequest,
  WebhookSample,
  Workspace,
} from './types.js';

// ── CodePad domain types (distinct from the backend Deployment "Pad") ───────────

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
import type { SecurityOverviewDto, SessionDto, TwoFactorSetupDto, NotificationEvent } from './account/dto.js';

const MAX_REQUEST_LOG = 5000;
const MAX_ACTIVITY_LOG = 500;

function isoNow(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** The subset of a project's configuration a caller may change. */
interface ProjectConfigInput {
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  rootDirectory: string | null;
}

@Injectable()
export class DeplogramStore {
  readonly users = new Map<string, User>();
  readonly workspaces = new Map<string, Workspace>();
  readonly projects = new Map<string, Project>();
  readonly deployments = new Map<string, Deployment>();
  readonly repositories = new Map<string, GitRepository>();
  readonly branches = new Map<string, GitBranch[]>();
  readonly activity = new Map<string, ActivityEvent>();
  /** Most recent activity first. */
  readonly activityOrder: ActivityEvent[] = [];
  /** Access log — powers `/v1/traffic` and `/v1/projects/:id/metrics`. */
  readonly requests: TrafficPoint[] = [];
  /** Variables per user, keyed like the account settings they configure. */
  private readonly preferences = new Map<string, AccountPreferences>();
  /** The workspace drive: path → item. Folders carry totals; files carry their bytes. */
  readonly storage = new Map<string, StorageItem>();
  /** Uploaded file contents: path → the bytes (for previews). */
  private readonly storageContents = new Map<string, { bytes: ArrayBuffer | null; text: string | null; url: string | null }>();
  /** Public folder tokens: path → permanent base URL. */
  private readonly storagePublic = new Map<string, string>();
  /** Short-lived signed links: token → { path, expiresAt }. */
  private readonly storageLinks = new Map<string, { path: string; size: number; contentType: string }>();
  /** CodePad pads: pad id → pad. */
  readonly pads = new Map<string, CodePad>();
  /** CodePad runs: run id → run state. */
  private readonly runs = new Map<string, { startedAt: number; script: { text: string; stream?: 'stdout' | 'stderr'; delay: number }[]; exitCode: number }>();

  /** The webhook capture endpoint and the requests it has received. */
  private webhookEndpoint: WebhookEndpoint | null = null;
  private webhookRequests: WebhookRequest[] = [];
  private webhookSeq = 0;

  /** Platform API keys and the requests made against them. */
  private apiKeys: ApiKey[] = [];
  private apiRequests: ApiRequest[] = [];

  currentUser: User | null = null;
  connectedAccount: string | null = null;

  // ── Security state ──────────────────────────────────────────────────────────

  twoFactorEnabled = false;
  twoFactorEnabledAt: string | null = null;
  recoveryCodes: string[] = [];
  passwordChangedAt: string | null = null;

  /** Session token → session info (plus the owning user id). */
  private readonly sessions = new Map<string, { id: string; browser: string; os: string; device: 'desktop' | 'mobile'; location: string | null; ip: string; lastActiveAt: string; createdAt: string; current: boolean; userId: string }>();

  notificationSettings: { email: string; events: Record<NotificationEvent, boolean>; digest: 'off' | 'weekly' } = {
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

  constructor() {
    this.seed();
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  seed(): void {
    const now = Date.now();

    // A demo account, so the sign-in flow has something to log in with.
    const owner: User = {
      id: 'user_owner',
      email: 'owner@deplogram.app',
      name: 'Sam Rivera',
      image: null,
      password: 'password',
      createdAt: new Date(now - 1000 * 60 * 60 * 24 * 90).toISOString(),
    };
    this.users.set(owner.id, owner);
    this.currentUser = owner;

    this.workspaces.set('ws_personal', {
      id: 'ws_personal',
      name: 'Personal Galley',
      kind: 'personal',
      plan: 'free',
    });

    // Git: the connected account and the importable repositories.
    this.connectedAccount = 'princeion';
    const storefrontRepository: GitRepository = {
      id: 'repo_storefront',
      fullName: 'acme/storefront',
      private: false,
      defaultBranch: 'main',
      updatedAt: new Date(now - 1000 * 60 * 60 * 24 * 21).toISOString(),
      projectId: null,
    };
    const apiRepository: GitRepository = {
      id: 'repo_api',
      fullName: 'acme/api',
      private: true,
      defaultBranch: 'main',
      updatedAt: new Date(now - 1000 * 60 * 60 * 24 * 6).toISOString(),
      projectId: null,
    };
    this.repositories.set(storefrontRepository.id, storefrontRepository);
    this.repositories.set(apiRepository.id, apiRepository);
    this.branches.set(storefrontRepository.id, [
      {
        name: 'main',
        commit: { sha: 'a1b2c3d', message: 'feat: live traffic dashboard' },
      },
      {
        name: 'feature/logs',
        commit: { sha: 'b2c3d4e', message: 'feat: runtime logs' },
      },
    ]);
    this.branches.set(apiRepository.id, [
      {
        name: 'main',
        commit: { sha: '5d4c3b2', message: 'feat: usage endpoints' },
      },
    ]);

    // Projects — the running one keeps the dashboard alive.
    const storefrontProject = this.createProject(
      {
        name: 'storefront',
        repositoryId: storefrontRepository.id,
        branch: storefrontRepository.defaultBranch,
        runtime: 'nextjs',
        config: {
          buildCommand: null,
          startCommand: null,
          port: null,
          rootDirectory: null,
        },
        env: [],
      },
      'proj_storefront',
    );
    storefrontRepository.projectId = storefrontProject.id;
    const apiProject = this.createProject(
      {
        name: 'api',
        repositoryId: apiRepository.id,
        branch: apiRepository.defaultBranch,
        runtime: 'node',
        config: {
          buildCommand: null,
          startCommand: null,
          port: null,
          rootDirectory: null,
        },
        env: [],
      },
      'proj_api',
    );
    apiRepository.projectId = apiProject.id;
    this.createProject(
      {
        name: 'docs',
        repositoryId: storefrontRepository.id,
        branch: 'gh-pages',
        runtime: 'static',
        config: {
          buildCommand: null,
          startCommand: null,
          port: null,
          rootDirectory: null,
        },
        env: [],
      },
      'proj_docs',
    );

    // Deployments of the storefront, oldest first — the last one is what a rollback rolls
    // forward to (`previousLiveId` of the live deployment).
    const olderStillLive = this.createDeployment(
      storefrontProject.id,
      {
        trigger: 'git',
        commitSha: '6e5d4c3',
        commitMessage: 'chore: initial commit',
        author: { name: 'Ada Lovelace', avatarUrl: null },
        createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      },
      'dep_old_2',
    );
    this.markLive(storefrontProject.id, olderStillLive.id);
    this.appendBuildLog(olderStillLive.id, [
      ['clone', 'stdout', 'Cloning into "storefront"…'],
      ['build', 'stdout', 'no build needed'],
    ]);

    const older = this.createDeployment(
      storefrontProject.id,
      {
        trigger: 'git',
        commitSha: '8f7e6d5',
        commitMessage: 'feat: cart',
        author: { name: 'Ada Lovelace', avatarUrl: null },
        createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      },
      'dep_old_1',
    );
    this.markLive(storefrontProject.id, older.id);
    this.appendBuildLog(older.id, [
      ['clone', 'stdout', 'Cloning into "storefront"…'],
      ['install', 'stdout', 'added 400 packages in 8s'],
      ['build', 'stdout', '✓ built in 3s'],
      ['deploy', 'stdout', 'Deployment ready'],
    ]);

    const live = this.createDeployment(
      storefrontProject.id,
      {
        trigger: 'git',
        commitSha: 'a1b2c3d',
        commitMessage: 'feat: live traffic dashboard',
        author: { name: 'Ada Lovelace', avatarUrl: null },
        createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
      },
      'dep_live',
    );
    this.markLive(storefrontProject.id, live.id);
    this.appendBuildLog(live.id, [
      ['clone', 'stdout', 'Cloning into "storefront"…'],
      ['install', 'stdout', 'added 412 packages in 9s'],
      ['build', 'stdout', '✓ built in 4s'],
      ['deploy', 'stdout', 'Deployment ready'],
    ]);
    this.appendRuntimeLog(live.id, [
      ['info', 'app', 'listening on http://localhost:3000'],
    ]);

    // The api service runs too, so the workspace has more than one live project.
    const apiDeployment = this.createDeployment(
      apiProject.id,
      {
        trigger: 'git',
        commitSha: '5d4c3b2',
        commitMessage: 'feat: usage endpoints',
        author: { name: 'Grace Hopper', avatarUrl: null },
        createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
      },
      'dep_api_live',
    );
    this.markLive(apiProject.id, apiDeployment.id);
    this.appendBuildLog(apiDeployment.id, [
      ['clone', 'stdout', 'Cloning into "api"…'],
      ['install', 'stdout', 'added 120 packages in 6s'],
      ['build', 'stdout', '✓ built in 2s'],
      ['deploy', 'stdout', 'Deployment ready'],
    ]);
    this.appendRuntimeLog(apiDeployment.id, [
      ['info', 'app', 'listening on http://localhost:8080'],
    ]);

    this.recordActivity(
      owner,
      'project.created',
      'storefront',
      'proj_storefront',
      null,
      'connected repository',
    );
    this.recordActivity(
      owner,
      'deployment.started',
      'storefront',
      'proj_storefront',
      'dep_live',
      null,
    );
    this.recordActivity(
      owner,
      'env.updated',
      'storefront',
      'proj_storefront',
      null,
      'added SENTRY_DSN',
    );

    // ── Additional mock data: more projects, repos, deployments, traffic ─────────
    this.seedMockProjects();

    // ── Storage: the workspace drive, seeded with a plausible folder tree ────────
    this.seedStorage();

    // ── CodePad: a couple of starter pads so the editor has something to open ─────
    this.seedPads();

    // ── Webhooks: a capture endpoint plus a few captured requests ─────────────────
    this.seedWebhooks();

    // ── APIs: a set of platform API keys ──────────────────────────────────────────
    this.seedApiKeys();
  }

  private seedStorage(): void {
    const now = isoNow();
    const folders: [string, string][] = [
      ['', 'assets'],
      ['assets', 'logos'],
      ['', 'docs'],
    ];
    for (const [parentPath, name] of folders) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      this.storage.set(path, {
        kind: 'folder',
        name,
        path,
        size: 0,
        contentType: null,
        items: 0,
        createdAt: now,
        updatedAt: now,
        thumbnailUrl: null,
        public: false,
        publicUrl: null,
      });
    }
    this.storage.set('assets/logos/deplogram.svg', {
      kind: 'file',
      name: 'deplogram.svg',
      path: 'assets/logos/deplogram.svg',
      size: 4096,
      contentType: 'image/svg+xml',
      items: null,
      createdAt: now,
      updatedAt: now,
      thumbnailUrl: null,
      public: false,
      publicUrl: null,
    });
    this.storage.set('docs/readme.md', {
      kind: 'file',
      name: 'readme.md',
      path: 'docs/readme.md',
      size: 2048,
      contentType: 'text/markdown',
      items: null,
      createdAt: now,
      updatedAt: now,
      thumbnailUrl: null,
      public: false,
      publicUrl: null,
    });
  }

  private seedPads(): void {
    const now = isoNow();
    const nodePad: CodePad = {
      id: 'pad_node',
      name: 'hello-node',
      runtime: 'node',
      updatedAt: now,
      projectId: null,
      files: [
        { path: 'server.js', content: 'console.log("hello from Node");\n', updatedAt: now },
        { path: 'package.json', content: '{"name":"hello-node","version":"1.0.0"}\n', updatedAt: now },
      ],
      entry: 'server.js',
    };
    const staticPad: CodePad = {
      id: 'pad_static',
      name: 'landing-page',
      runtime: 'static',
      updatedAt: now,
      projectId: null,
      files: [
        { path: 'index.html', content: '<h1>Hello</h1>\n', updatedAt: now },
        { path: 'style.css', content: 'body { margin: 0; }\n', updatedAt: now },
      ],
      entry: 'index.html',
    };
    this.pads.set(nodePad.id, nodePad);
    this.pads.set(staticPad.id, staticPad);
  }

  private seedWebhooks(): void {
    const token = () => Math.random().toString(36).slice(2, 10);
    this.webhookEndpoint = {
      url: `https://hooks.dpl.app/h/${token()}`,
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    };
    const now = new Date();
    const sample = (kind: WebhookSample, at: Date): WebhookRequest => {
      const id = `wh_${++this.webhookSeq}${token().slice(0, 4)}`;
      const body =
        kind === 'github-push'
          ? JSON.stringify({
              ref: 'refs/heads/main',
              repository: { name: 'orders-api', full_name: 'ada-obi/orders-api', private: true },
              head_commit: { id: '72c32b8', message: 'feat: add order filters', timestamp: at.toISOString() },
            })
          : kind === 'paystack-charge'
            ? JSON.stringify({ event: 'charge.success', data: { id: 4127730154, amount: 4850000, currency: 'NGN' } })
            : 'name=Funke+Adebayo&email=funke@example.com&plan=plus';
      return {
        id,
        method: 'POST',
        path: kind === 'form' ? '/signup' : '/',
        query: kind === 'form' ? [['ref', 'newsletter']] : [],
        headers: kind === 'form' ? [['content-type', 'application/x-www-form-urlencoded']] : [['content-type', 'application/json']],
        body,
        contentType: kind === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
        size: body.length,
        ip: '102.89.1.2',
        receivedAt: at.toISOString(),
      };
    };
    this.webhookRequests = [
      sample('paystack-charge', new Date(now.getTime() - 4 * 60_000)),
      sample('github-push', new Date(now.getTime() - 26 * 60_000)),
      sample('form', new Date(now.getTime() - 3 * 3_600_000)),
    ];
  }

  private seedApiKeys(): void {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const owner = this.currentUser;
    this.apiKeys = [
      {
        id: 'key_1',
        name: 'orders-api production',
        prefix: 'dpl_live_3fk2',
        mode: 'live',
        access: [],
        createdAt: ago(41),
        lastUsedAt: new Date(now - 2 * 60_000).toISOString(),
        createdBy: owner ? owner.name : 'you',
      },
      {
        id: 'key_2',
        name: 'Signup flow',
        prefix: 'dpl_live_8qwm',
        mode: 'live',
        access: ['otp', 'email'],
        createdAt: ago(18),
        lastUsedAt: new Date(now - 3 * 86_400_000).toISOString(),
        createdBy: owner ? owner.name : 'you',
      },
      {
        id: 'key_3',
        name: 'Local and CI',
        prefix: 'dpl_test_9c1e',
        mode: 'test',
        access: [],
        createdAt: ago(40),
        lastUsedAt: new Date(now - 5 * 60 * 60_000).toISOString(),
        createdBy: owner ? owner.name : 'you',
      },
    ];
  }

  /** Seed additional mock data mirroring the frontend mock API so the backend has
   *  realistic data when the frontend switches from MSW mocking to the real API.
   *  Existing seeded data (proj_storefront, dep_live, etc.) is left untouched so
   *  existing tests keep passing. */
  private seedMockProjects(): void {
    const owner = this.currentUser;

    // ── Additional git repositories (frontend mock: git.ts) ──────────────────────
    const repos: GitRepository[] = [
      {
        id: 'repo_orders',
        fullName: 'ada/orders-api',
        private: true,
        defaultBranch: 'main',
        updatedAt: daysAgo(0),
        projectId: null,
      },
      {
        id: 'repo_admin',
        fullName: 'ada/admin-dashboard',
        private: true,
        defaultBranch: 'main',
        updatedAt: daysAgo(28),
        projectId: null,
      },
      {
        id: 'repo_payments',
        fullName: 'ada/payments-service',
        private: true,
        defaultBranch: 'main',
        updatedAt: daysAgo(20),
        projectId: null,
      },
      {
        id: 'repo_ml',
        fullName: 'ada/recommendations-api',
        private: true,
        defaultBranch: 'main',
        updatedAt: daysAgo(50),
        projectId: null,
      },
      {
        id: 'repo_marketing',
        fullName: 'ada/marketing-site',
        private: false,
        defaultBranch: 'main',
        updatedAt: daysAgo(76),
        projectId: null,
      },
      {
        id: 'repo_crm',
        fullName: 'ada/legacy-crm',
        private: true,
        defaultBranch: 'master',
        updatedAt: daysAgo(400),
        projectId: null,
      },
      {
        id: 'repo_worker',
        fullName: 'ada/queue-worker',
        private: true,
        defaultBranch: 'main',
        updatedAt: daysAgo(130),
        projectId: null,
      },
      {
        id: 'repo_notes',
        fullName: 'ada/scratch-notes',
        private: false,
        defaultBranch: 'main',
        updatedAt: daysAgo(900),
        projectId: null,
      },
    ];
    for (const repo of repos) this.repositories.set(repo.id, repo);

    const branchesFor: Record<string, GitBranch[]> = {
      repo_orders: [{ name: 'main', commit: { sha: '72c32b8', message: 'feat: add order filters' } }],
      repo_admin: [{ name: 'main', commit: { sha: 'f3a1c9e', message: 'feat: dark mode toggle' } }],
      repo_payments: [
        { name: 'main', commit: { sha: '4b7c9e1', message: 'fix: idempotency on retries' } },
        { name: 'release/1.2', commit: { sha: 'a3f0c88', message: 'chore: release 1.2.0' } },
      ],
      repo_ml: [{ name: 'main', commit: { sha: 'c2d81f4', message: 'feat: cold-start fallback' } }],
      repo_marketing: [{ name: 'main', commit: { sha: '5e6a1b9', message: 'content: pricing FAQ' } }],
      repo_crm: [{ name: 'master', commit: { sha: '9f12d0e', message: 'fix: invoice rounding' } }],
      repo_worker: [{ name: 'main', commit: { sha: '0aa4e57', message: 'feat: dead-letter queue' } }],
      repo_notes: [{ name: 'main', commit: { sha: '77b3c21', message: 'notes' } }],
    };
    for (const [repoId, branches] of Object.entries(branchesFor)) {
      this.branches.set(repoId, branches);
    }

    const detectionFor: Record<string, GitDetection | null> = {
      repo_orders: { runtime: 'node', evidence: 'package.json (express)', buildCommand: 'npm run build', startCommand: 'node dist/server.js', port: 8080, envExample: ['DATABASE_URL'] },
      repo_admin: { runtime: 'nextjs', evidence: 'package.json (next)', buildCommand: 'next build', startCommand: 'next start', port: 3000, envExample: ['NEXT_PUBLIC_API_URL'] },
      repo_payments: { runtime: 'go', evidence: 'go.mod', buildCommand: 'go build -o app ./cmd/server', startCommand: './app', port: 8080, envExample: ['DATABASE_URL', 'PAYSTACK_SECRET_KEY', 'WEBHOOK_SECRET'] },
      repo_ml: { runtime: 'python', evidence: 'requirements.txt (fastapi)', buildCommand: 'pip install -r requirements.txt', startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', port: 8000, envExample: ['MODEL_PATH', 'REDIS_URL'] },
      repo_marketing: { runtime: 'nextjs', evidence: 'package.json (next)', buildCommand: 'next build', startCommand: 'next start', port: 3000, envExample: ['NEXT_PUBLIC_SITE_URL'] },
      repo_crm: { runtime: 'php', evidence: 'composer.json (laravel)', buildCommand: 'composer install --no-dev', startCommand: 'php artisan serve --host 0.0.0.0 --port 8000', port: 8000, envExample: ['APP_KEY', 'DB_HOST', 'DB_PASSWORD'] },
      repo_worker: { runtime: 'docker', evidence: 'Dockerfile', buildCommand: 'docker build .', startCommand: null, port: 9000, envExample: ['QUEUE_URL'] },
      repo_notes: null,
    };
    for (const [repoId, detection] of Object.entries(detectionFor)) {
      // detection computed inline by detect(); kept for reference if needed later
      void detection;
      void repoId;
    }

    // ── Additional projects (frontend mock: projects.ts) ──────────────────────────
    const projects: Project[] = [
      {
        id: 'proj_orders',
        name: 'orders-api',
        runtime: 'node',
        state: 'RUNNING',
        url: 'orders-api.deplogram.app',
        repository: 'ada/orders-api',
        branch: 'main',
        updatedAt: daysAgo(41),
        latest: { id: 'dep_orders_001', state: 'RUNNING', live: true, sha: 'a1b2c3d', message: 'feat: add order filters', createdAt: daysAgo(2) },
        recent: ['RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING'],
        createdAt: daysAgo(41),
        liveDeploymentId: 'dep_orders_001',
        envCount: 4,
        config: { runtimeVersion: 'Node.js 22', buildCommand: 'npm run build', startCommand: 'node dist/server.js', port: 8080, rootDirectory: null },
        env: [
          { key: 'DATABASE_URL', value: 'postgres://…', updatedAt: daysAgo(41) },
          { key: 'JWT_SECRET', value: '…', updatedAt: daysAgo(20) },
          { key: 'REDIS_URL', value: 'redis://…', updatedAt: daysAgo(6) },
          { key: 'PAYSTACK_SECRET_KEY', value: 'sk_…', updatedAt: daysAgo(2) },
        ],
      },
      {
        id: 'proj_admin',
        name: 'admin-dashboard',
        runtime: 'nextjs',
        state: 'BUILDING',
        url: 'admin-dashboard.deplogram.app',
        repository: 'ada/admin-dashboard',
        branch: 'main',
        updatedAt: daysAgo(28),
        latest: { id: 'dep_admin_016', state: 'BUILDING', live: false, sha: 'f3a1c9e', message: 'feat: dark mode toggle', createdAt: daysAgo(28) },
        recent: ['BUILDING', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING'],
        createdAt: daysAgo(28),
        liveDeploymentId: null,
        envCount: 2,
        config: { runtimeVersion: 'Next.js 16', buildCommand: 'next build', startCommand: 'next start', port: 3000, rootDirectory: null },
        env: [
          { key: 'NEXT_PUBLIC_API_URL', value: 'https://orders-api.deplogram.app', updatedAt: daysAgo(28) },
          { key: 'AUTH_SECRET', value: '…', updatedAt: daysAgo(9) },
        ],
      },
      {
        id: 'proj_docs2',
        name: 'docs-site',
        runtime: 'static',
        state: 'BUILD_FAILED',
        url: 'docs-site.deplogram.app',
        repository: 'ada/docs-site',
        branch: 'main',
        updatedAt: daysAgo(60),
        latest: { id: 'dep_docs2_008', state: 'BUILD_FAILED', live: false, sha: 'e4f5a6b', message: 'docs: storage guide', createdAt: daysAgo(60) },
        recent: ['BUILD_FAILED', 'RUNNING', 'RUNNING', 'BUILD_FAILED', 'RUNNING'],
        createdAt: daysAgo(60),
        liveDeploymentId: null,
        envCount: 0,
        config: { runtimeVersion: 'Static site', buildCommand: 'npx docusaurus build', startCommand: null, port: null, rootDirectory: 'website' },
        env: [],
      },
    ];

    for (const project of projects) {
      this.projects.set(project.id, project);
      const repoId = project.name === 'orders-api' ? 'repo_orders' : project.name === 'admin-dashboard' ? 'repo_admin' : null;
      if (repoId) {
        const repo = this.repositories.get(repoId);
        if (repo) repo.projectId = project.id;
      }
    }

    // ── Additional deployments (frontend mock: deployments.ts ~46 deployments) ──
    const messagesFor: Record<string, string[]> = {
      proj_orders: [
        'feat: add order filters', 'fix: pagination cursor on large accounts', 'chore: bump hono to 4.6',
        'feat: retry failed webhooks with backoff', 'perf: cache order totals per day',
      ],
      proj_admin: [
        'fix: table pagination', 'feat: audit log page', 'feat: role management for staff',
        'fix: chart tooltip overflow', 'feat: dark mode toggle',
      ],
      proj_docs2: ['docs: storage guide', 'docs: runtime versions table', 'fix: broken links in API reference'],
    };
    const configFor: Record<string, DeploymentConfigSnapshot> = {
      proj_orders: { runtimeVersion: 'Node.js 22', buildCommand: 'npm run build', startCommand: 'node dist/server.js', port: 8080 },
      proj_admin: { runtimeVersion: 'Next.js 16', buildCommand: 'next build', startCommand: 'next start', port: 3000 },
      proj_docs2: { runtimeVersion: 'Static site', buildCommand: 'npx docusaurus build', startCommand: null, port: null },
    };

    const ordersDeployments = this.generateMockDeploymentsFor('proj_orders', 'orders-api', 'node', 22, 'RUNNING', configFor['proj_orders'], messagesFor['proj_orders']);
    const adminDeployments = this.generateMockDeploymentsFor('proj_admin', 'admin-dashboard', 'nextjs', 16, 'BUILDING', configFor['proj_admin'], messagesFor['proj_admin']);
    const docsDeployments = this.generateMockDeploymentsFor('proj_docs2', 'docs-site', 'static', 8, 'BUILD_FAILED', configFor['proj_docs2'], messagesFor['proj_docs2']);

    for (const d of [...ordersDeployments, ...adminDeployments, ...docsDeployments]) {
      this.deployments.set(d.id, d);
      this.recordActivity(
        owner,
        d.state === 'RUNNING' || ['BUILD_FAILED', 'DEPLOY_FAILED', 'CRASHED'].includes(d.state)
          ? 'deployment.succeeded'
          : 'deployment.started',
        d.projectName,
        d.projectId,
        d.id,
        d.trigger === 'git' ? `pushed to ${d.commit.branch}` : d.trigger === 'redeploy' ? 'redeployed' : 'deployed from the dashboard',
      );
    }

    // ── Traffic: seed recent requests so /v1/traffic and metrics have data ───────
    const cities = ['LOS', 'ABV', 'ACC', 'NBO', 'JNB', 'CAI', 'LON', 'FRA', 'NYC', 'SFO', 'TOR', 'GRU', 'DXB', 'BOM', 'SIN', 'TYO', 'SYD'];
    const pathsByRuntime: Record<string, string[]> = {
      node: ['/api/orders', '/api/orders/:id', '/api/customers', '/api/webhooks/paystack', '/healthz'],
      nextjs: ['/', '/orders', '/settings', '/api/auth/session', '/_next/data/build/orders.json'],
      static: ['/', '/docs/getting-started', '/docs/storage', '/assets/main.css', '/img/logo.svg'],
    };
    const liveProjectIds = ['proj_storefront', 'proj_orders'];
    const rand = () => Math.random();
    for (const projectId of liveProjectIds) {
      const project = this.projects.get(projectId);
      const runtime = project?.runtime ?? 'node';
      const paths = pathsByRuntime[runtime] ?? pathsByRuntime['node'];
      const latestDeployments = [...this.deployments.values()]
        .filter((d) => d.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latestDeployment = latestDeployments[0];
      if (!latestDeployment) continue;
      for (let i = 0; i < 60; i++) {
        const path = paths[Math.floor(rand() * paths.length)];
        const method = path.startsWith('/api/') && rand() < 0.25 ? 'POST' : 'GET';
        const roll = rand();
        const status = roll < 0.02 ? 500 : roll < 0.07 ? 404 : roll < 0.1 ? 304 : 200;
        const latencyMs = Math.round(8 + rand() * 600);
        this.appendRequest(latestDeployment, status >= 500, cities[Math.floor(rand() * cities.length)], status, latencyMs, `${method} ${path}`);
      }
    }
  }

  /** Generates a deterministic set of historical deployments for a project, newest first. */
  private generateMockDeploymentsFor(
    projectId: string,
    projectName: string,
    runtime: string,
    count: number,
    latestState: DeploymentState,
    config: DeploymentConfigSnapshot,
    messages: string[],
  ): Deployment[] {
    const now = Date.now();
    const rand = () => Math.random();
    const hex = () => Math.floor(rand() * 0xfffffff).toString(16).padStart(7, '0').slice(0, 7);
    const authors = ['Ada Obi', 'Tobi Adeyemi', 'Ngozi Eze'];
    const branches = ['main', 'main', 'main', 'feat/webhooks', 'fix/reports'];
    const triggers: DeploymentTrigger[] = ['git', 'manual', 'redeploy', 'rollback'];
    const deployments: Deployment[] = [];

    let minutesAgo = projectId === 'proj_admin' ? 1 : projectId === 'proj_orders' ? 2 : 72;
    for (let i = 0; i < count; i++) {
      const state: DeploymentState =
        i === 0 ? latestState : rand() < 0.12 ? (rand() < 0.5 ? 'BUILD_FAILED' : rand() < 0.8 ? 'DEPLOY_FAILED' : 'CRASHED') : 'RUNNING';
      const failed = ['BUILD_FAILED', 'DEPLOY_FAILED', 'CRASHED'].includes(state);
      const trigger: DeploymentTrigger = triggers[Math.floor(rand() * triggers.length)];
      const live = state === 'RUNNING' && deployments.every((d) => d.projectId !== projectId || !d.live);
      const id = `dpl_${projectId.slice(4)}_${String(count - i).padStart(3, '0')}`;
      deployments.push({
        id,
        projectId,
        projectName,
        runtime,
        state,
        live,
        commit: {
          sha: hex(),
          message: messages[i % messages.length],
          branch: i === 0 ? 'main' : branches[Math.floor(rand() * branches.length)],
          author: { name: authors[Math.floor(rand() * authors.length)], avatarUrl: null },
        },
        trigger,
        createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
        durationSeconds: state === 'QUEUED' ? null : failed ? 8 + Math.floor(rand() * 60) : 25 + Math.floor(rand() * 140),
        url: live ? `${projectName}.deplogram.app` : null,
        config: { ...config },
        previousLiveId: i > 0 ? deployments[0]?.id ?? null : null,
      });
      minutesAgo += 90 + Math.floor(rand() * 600);
    }
    return deployments;
  }

  // ── workspace ────────────────────────────────────────────────────────────────

  currentWorkspace() {
    const workspace = this.workspaces.get('ws_personal');
    if (!workspace) throw new Error('No current workspace');
    return workspace;
  }

  // ── users, session and account ───────────────────────────────────────────────

  findUserByEmail(email: string): User | undefined {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === needle) return user;
    }
    return undefined;
  }

  signIn(
    email: string,
    password: string,
  ): { viewer: Viewer; sessionToken: string } {
    const user = this.findUserByEmail(email);
    if (!user || user.password !== password) {
      throw new Error('Invalid email or password');
    }
    return this.startSession(user);
  }

  /**
   * Creates an account and signs it in. Mirrors the web sign-up form: name, email and password.
   * Duplicate emails are rejected here so every caller gets the same rule.
   */
  signUp(input: {
    name: string;
    email: string;
    password: string;
  }): { viewer: Viewer; sessionToken: string } {
    const email = input.email.trim().toLowerCase();
    if (this.findUserByEmail(email)) {
      throw new Error('Email already registered');
    }
    const user: User = {
      id: newId('user'),
      email,
      name: input.name.trim(),
      image: null,
      password: input.password,
      createdAt: isoNow(),
    };
    this.users.set(user.id, user);
    return this.startSession(user);
  }

  private startSession(user: User): {
    viewer: Viewer;
    sessionToken: string;
  } {
    const sessionToken = newId('sess');
    const now = new Date().toISOString();
    this.sessions.set(sessionToken, {
      id: sessionToken,
      userId: user.id,
      browser: 'unknown',
      os: 'unknown',
      device: 'desktop',
      location: null,
      ip: '0.0.0.0',
      lastActiveAt: now,
      createdAt: now,
      current: true,
    });
    this.currentUser = user;
    return { viewer: this.toViewer(user), sessionToken };
  }

  signOut(sessionToken: string | null): void {
    if (sessionToken) this.sessions.delete(sessionToken);
    this.currentUser = null;
  }

  /** Restores `currentUser` from a session token — called once per request by middleware. */
  setCurrentUserFromSession(sessionToken: string | null): void {
    this.currentUser = null;
    if (!sessionToken) return;
    const session = this.sessions.get(sessionToken);
    if (session) this.currentUser = this.users.get(session.userId) ?? null;
  }

  getViewer(): Viewer | null {
    const user = this.currentUser;
    return user ? this.toViewer(user) : null;
  }

  private toViewer(user: User): Viewer {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    };
  }

  getAccountSettings(): AccountSettings {
    const user = this.currentUser;
    if (!user) throw new Error('Not signed in');
    const preferences = this.preferencesOf(user.id);
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

  updateAccountSettings(settings: AccountSettings): void {
    const user = this.currentUser;
    if (!user) throw new Error('Not signed in');
    user.name = settings.name;
    const preferences = this.preferencesOf(user.id);
    preferences.defaultRuntime = settings.preferences.defaultRuntime;
    preferences.deploymentEmails = settings.preferences.deploymentEmails;
    preferences.productUpdates = settings.preferences.productUpdates;
  }

  deleteAccount(): void {
    this.currentUser = null;
  }

  private preferencesOf(userId: string): AccountPreferences {
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

  // ── projects ─────────────────────────────────────────────────────────────────

  createProject(
    input: {
      name: string;
      repositoryId: string;
      branch: string;
      runtime: string;
      config: ProjectConfigInput;
      env: { key: string; value: string }[];
    },
    id?: string,
  ): Project {
    const repository = this.repositories.get(input.repositoryId);
    const project: Project = {
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
    };
    this.projects.set(project.id, project);
    this.recordActivity(
      this.currentUser,
      'project.created',
      input.name,
      project.id,
      null,
      'created project',
    );
    return project;
  }

  /** The variables a project was created with, plus every saved one. */
  applyEnv(env: { key: string; value: string }[]): ProjectEnvVar[] {
    const variables = env.map((variable, index) => ({
      key: variable.key,
      value: variable.value,
      updatedAt: new Date(Date.now() + index).toISOString(),
    }));
    variables.sort((a, b) => a.key.localeCompare(b.key));
    return variables;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  updateProject(
    id: string,
    update: {
      name?: string;
      branch?: string;
      config?: Partial<ProjectConfigInput>;
    },
  ): Project | undefined {
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
    if (update.name !== undefined && update.name !== project.name) {
      this.recordActivity(
        this.currentUser,
        'project.renamed',
        project.name,
        project.id,
        null,
        `renamed to ${update.name}`,
      );
    } else if (update.branch !== undefined || update.config !== undefined) {
      this.recordActivity(
        this.currentUser,
        'settings.updated',
        project.name,
        project.id,
        null,
        'changed project settings',
      );
    }
    return project;
  }

  deleteProject(id: string): void {
    const project = this.projects.get(id);
    if (!project) return;
    for (const deployment of this.deployments.values()) {
      if (deployment.projectId === id) this.deployments.delete(deployment.id);
    }
    this.projects.delete(id);
    this.recordActivity(
      this.currentUser,
      'project.deleted',
      project.name,
      id,
      null,
      'deleted project',
    );
  }

  getEnvVars(projectId: string): EnvVarRecord[] {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return project.env.map((variable) => ({
      key: variable.key,
      updatedAt: variable.updatedAt,
    }));
  }

  saveEnvVars(
    projectId: string,
    values: { key: string; value: string | null }[],
  ): EnvVarRecord[] {
    const project = this.projects.get(projectId);
    if (!project) return [];
    const saved = new Map<
      string,
      { value: string | null; updatedAt: string }
    >();
    for (const variable of project.env) {
      const entry = values.find((value) => value.key === variable.key);
      if (!entry) continue; // not part of the set — deleted
      saved.set(
        variable.key,
        entry.value === null
          ? { value: variable.value, updatedAt: variable.updatedAt }
          : { value: entry.value, updatedAt: new Date().toISOString() },
      );
    }
    // Add the variables that are in the submitted set but not yet tracked.
    for (const value of values) {
      if (value.value === null) continue; // null keeps the saved value; we never have it to send back
      if (saved.has(value.key)) continue;
      saved.set(value.key, {
        value: value.value,
        updatedAt: new Date().toISOString(),
      });
    }
    project.env = [...saved.entries()]
      .map(([key, variable]) => ({
        key,
        value: variable.value,
        updatedAt: variable.updatedAt,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const records = project.env.map((variable) => ({
      key: variable.key,
      updatedAt: variable.updatedAt,
    }));
    this.recordActivity(
      this.currentUser,
      'env.updated',
      project.name,
      projectId,
      null,
      `saved ${records.length} variables`,
    );
    return records;
  }

  // ── deployments ──────────────────────────────────────────────────────────────

  createDeployment(
    projectId: string,
    options: {
      trigger: DeploymentTrigger;
      commitSha: string;
      commitMessage: string;
      author: { name: string; avatarUrl: string | null };
      createdAt?: string;
    },
    id?: string,
  ): Deployment {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project');
    const previous = this.latestDeployment(projectId);
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
      },
      previousLiveId: previous ? previous.id : null,
    };
    this.deployments.set(deployment.id, deployment);
    project.state = 'QUEUED';
    project.updatedAt = isoNow();
    this.recordActivity(
      this.currentUser,
      'deployment.started',
      project.name,
      projectId,
      deployment.id,
      `started by ${options.trigger}`,
    );
    return deployment;
  }

  getDeployment(id: string): Deployment | undefined {
    return this.deployments.get(id);
  }

  deploymentsOfProject(projectId: string): Deployment[] {
    return [...this.deployments.values()]
      .filter((deployment) => deployment.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** All deployments, newest first. */
  allDeployments(): Deployment[] {
    return [...this.deployments.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /** The most recent deployment of a project, newest first. */
  latestDeployment(projectId: string): Deployment | undefined {
    const deployments = this.deploymentsOfProject(projectId);
    return deployments[0];
  }

  markLive(projectId: string, deploymentId: string): void {
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

  /** Makes the deployment that was live before `deploymentId` live again. */
  rollbackTo(projectId: string, deploymentId: string): Deployment | undefined {
    const deployment = this.deployments.get(deploymentId);
    const project = this.projects.get(projectId);
    if (!deployment || !project) return undefined;
    const targetId = deployment.previousLiveId;
    if (!targetId) return undefined;
    const target = this.deployments.get(targetId);
    if (!target) return undefined;
    this.markLive(projectId, targetId);
    deployment.live = false;
    this.recordActivity(
      this.currentUser,
      'deployment.rolled_back',
      project.name,
      projectId,
      deploymentId,
      `rolled back to ${target.id}`,
    );
    return target;
  }

  /** Marks a deployment as finished, with how long its build took. */
  finishDeployment(deploymentId: string, state: DeploymentState): void {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return;
    deployment.state = state;
    deployment.durationSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(deployment.createdAt).getTime()) / 1000),
    );
  }

  // ── logs ─────────────────────────────────────────────────────────────────────

  appendBuildLog(
    deploymentId: string,
    entries: [BuildStepId, 'stdout' | 'stderr', string][],
  ): void {
    const lines = this.buildLog.get(deploymentId) ?? [];
    let n = lines.length ? lines[lines.length - 1].n + 1 : 1;
    for (const [step, stream, text] of entries) {
      lines.push({ n, at: isoNow(), step, stream, text });
      n += 1;
    }
    this.buildLog.set(deploymentId, lines);
  }

  appendRuntimeLog(
    deploymentId: string,
    entries: [RuntimeLogLevel, RuntimeLogSource, string][],
  ): void {
    const lines = this.runtimeLog.get(deploymentId) ?? [];
    let n = lines.length ? lines[lines.length - 1].n + 1 : 1;
    for (const [level, source, text] of entries) {
      lines.push({ n, at: isoNow(), level, source, text });
      n += 1;
    }
    this.runtimeLog.set(deploymentId, lines);
  }

  getBuildLog(
    deploymentId: string,
    after: number,
  ): { lines: BuildLogLine[]; end: number } {
    const lines = this.buildLog.get(deploymentId) ?? [];
    const end = lines.length ? lines[lines.length - 1].n : after;
    return { lines: lines.slice(after), end };
  }

  getRuntimeLog(
    deploymentId: string,
    after: number,
  ): { lines: RuntimeLogLine[]; end: number } {
    const lines = this.runtimeLog.get(deploymentId) ?? [];
    const end = lines.length ? lines[lines.length - 1].n : after;
    return { lines: lines.slice(after), end };
  }

  private readonly buildLog = new Map<string, BuildLogLine[]>();
  private readonly runtimeLog = new Map<string, RuntimeLogLine[]>();

  // ── activity ────────────────────────────────────────────────────────────────

  recordActivity(
    actor: User | null,
    type: ActivityType,
    projectName: string,
    projectId: string | null,
    deploymentId: string | null,
    detail: string | null,
  ): void {
    const event: ActivityEvent = {
      id: newId('evt'),
      at: isoNow(),
      type,
      actor: { name: actor ? actor.name : 'system' },
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

  activityPage(afterCursor: string | null, limit: number): ActivityPage {
    const startIndex = afterCursor
      ? this.activityOrder.findIndex((event) => event.id === afterCursor) + 1
      : 0;
    const endIndex = startIndex + limit;
    const window = this.activityOrder.slice(startIndex, endIndex);
    let nextCursor: string | null = null;
    if (endIndex < this.activityOrder.length) {
      nextCursor = window[window.length - 1]?.id ?? null;
    }
    return { items: window, nextCursor };
  }

  recentActivity(limit: number): ActivityEvent[] {
    return this.activityOrder.slice(0, limit);
  }

  // ── access log (traffic & metrics) ──────────────────────────────────────────

  appendRequest(
    deployment: Deployment,
    error: boolean,
    city: string,
    status: number,
    latencyMs: number,
    path: string,
  ): void {
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

  getRequests(): TrafficPoint[] {
    return this.requests;
  }

  requestsOfProject(projectId: string): TrafficPoint[] {
    return this.requests.filter((point) => point.projectId === projectId);
  }

  getLiveDeployments(): Deployment[] {
    const live: Deployment[] = [];
    for (const deployment of this.deployments.values()) {
      if (deployment.live) live.push(deployment);
    }
    return live;
  }

  // ── git ──────────────────────────────────────────────────────────────────────

  getConnection(): GitConnection {
    return {
      provider: 'github',
      connected: this.connectedAccount !== null,
      account: this.connectedAccount,
    };
  }

  getRepositories(q?: string): GitRepository[] {
    const repositories = [...this.repositories.values()];
    if (!q) return repositories;
    const needle = q.toLowerCase();
    return repositories.filter((repository) =>
      repository.fullName.toLowerCase().includes(needle),
    );
  }

  getBranches(repositoryId: string): GitBranch[] {
    return this.branches.get(repositoryId) ?? [];
  }

  detect(repositoryId: string, _branch: string): GitDetection {
    const detectionFor: Record<string, GitDetection | null> = {
      repo_orders: { runtime: 'node', evidence: 'package.json (express)', buildCommand: 'npm run build', startCommand: 'node dist/server.js', port: 8080, envExample: ['DATABASE_URL'] },
      repo_admin: { runtime: 'nextjs', evidence: 'package.json (next)', buildCommand: 'next build', startCommand: 'next start', port: 3000, envExample: ['NEXT_PUBLIC_API_URL'] },
      repo_payments: { runtime: 'go', evidence: 'go.mod', buildCommand: 'go build -o app ./cmd/server', startCommand: './app', port: 8080, envExample: ['DATABASE_URL', 'PAYSTACK_SECRET_KEY', 'WEBHOOK_SECRET'] },
      repo_ml: { runtime: 'python', evidence: 'requirements.txt (fastapi)', buildCommand: 'pip install -r requirements.txt', startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000', port: 8000, envExample: ['MODEL_PATH', 'REDIS_URL'] },
      repo_marketing: { runtime: 'nextjs', evidence: 'package.json (next)', buildCommand: 'next build', startCommand: 'next start', port: 3000, envExample: ['NEXT_PUBLIC_SITE_URL'] },
      repo_crm: { runtime: 'php', evidence: 'composer.json (laravel)', buildCommand: 'composer install --no-dev', startCommand: 'php artisan serve --host 0.0.0.0 --port 8000', port: 8000, envExample: ['APP_KEY', 'DB_HOST', 'DB_PASSWORD'] },
      repo_worker: { runtime: 'docker', evidence: 'Dockerfile', buildCommand: 'docker build .', startCommand: null, port: 9000, envExample: ['QUEUE_URL'] },
      repo_notes: null,
      repo_storefront: { runtime: 'nextjs', evidence: 'package.json (next)', buildCommand: 'npm run build', startCommand: 'npm start', port: 3000, envExample: [] },
      repo_api: { runtime: 'node', evidence: 'package.json (express)', buildCommand: 'npm run build', startCommand: 'node server.js', port: 8080, envExample: [] },
    };
    return detectionFor[repositoryId] ?? { runtime: null, evidence: null, buildCommand: null, startCommand: null, port: null, envExample: [] };
  }

  /** The public host a project's current deployment would serve (no scheme). */
  urlOf(projectName: string): string {
    return `${projectName}.deplogram.app`;
  }

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

  // ── CodePad ───────────────────────────────────────────────────────────────────

  listPads(): CodePadSummary[] {
    return [...this.pads.values()]
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

  getPad(id: string): CodePad | undefined {
    return this.pads.get(id);
  }

  createPad(name: string, template: 'static' | 'node' | 'python'): CodePad {
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

  updatePad(id: string, name: string): CodePad | undefined {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    pad.name = name;
    pad.updatedAt = isoNow();
    return pad;
  }

  deletePad(id: string): boolean {
    return this.pads.delete(id);
  }

  savePadFile(id: string, path: string, content: string): CodePadFile | undefined {
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

  renamePadFile(id: string, from: string, to: string): CodePad | 'exists' | undefined {
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

  deletePadFile(id: string, path: string): CodePad | undefined {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    pad.files = pad.files.filter((f) => f.path !== path);
    if (pad.entry === path) pad.entry = pad.files[0]?.path ?? '';
    pad.updatedAt = isoNow();
    return pad;
  }

  startPadRun(id: string): string | undefined {
    const pad = this.pads.get(id);
    if (!pad) return undefined;
    const runId = newId('run');
    const script = padScript(pad);
    this.runs.set(runId, { startedAt: Date.now(), script, exitCode: 0 });
    return runId;
  }

  getRunLogs(id: string, after: number): { lines: CodePadRunLogLine[]; done: boolean; exitCode: number | null } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const elapsed = Date.now() - run.startedAt;
    let t = 0;
    const due = run.script.flatMap((line, i) => {
      t += line.delay;
      return t <= elapsed ? [{ n: i + 1, at: new Date(run.startedAt + t).toISOString(), text: line.text, stream: line.stream ?? 'stdout' }] : [];
    });
    const done = due.length === run.script.length;
    return {
      lines: done ? due.filter((l) => l.n > after) : due.filter((l) => l.n > after),
      done,
      exitCode: done ? run.exitCode : null,
    };
  }

  /** Deploy a pad: first time it becomes a project; after that it redeploys that project. */
  deployPad(id: string): { project: ProjectSummary; deployment: Deployment } | undefined {
    const pad = this.pads.get(id);
    if (!pad) return undefined;

    if (pad.projectId) {
      const project = this.projects.get(pad.projectId);
      if (!project) return undefined;
      const latest = this.latestDeployment(pad.projectId);
      if (!latest) return undefined;
      const fresh = this.createDeployment(pad.projectId, {
        trigger: 'manual',
        commitSha: Math.random().toString(16).slice(2, 9),
        commitMessage: 'Deployed from CodePad',
        author: { name: 'You', avatarUrl: null },
      });
      return { project: this.summarizePadProject(project), deployment: fresh };
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
      });
    }
    const config: ProjectConfigInput = {
      buildCommand: null,
      startCommand: pad.runtime === 'static' ? null : pad.runtime === 'node' ? `node ${pad.entry}` : `python ${pad.entry}`,
      port: pad.runtime === 'static' ? null : pad.runtime === 'node' ? 3000 : 8000,
      rootDirectory: null,
    };
    const project = this.createProject(
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
    const deployment = this.createDeployment(project.id, {
      trigger: 'manual',
      commitSha: Math.random().toString(16).slice(2, 9),
      commitMessage: 'Deployed from CodePad',
      author: { name: 'You', avatarUrl: null },
    });
    this.pads.get(id)!.projectId = project.id;
    return { project: this.summarizePadProject(project), deployment };
  }

  private summarizePadProject(project: Project): ProjectSummary {
    const deployments = this.deploymentsOfProject(project.id);
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

  // ── Storage ───────────────────────────────────────────────────────────────────

  getStorageList(path: string): { path: string; items: StorageItem[]; public: boolean; publicFrom: string | null } | undefined {
    if (!this.storageExists(path)) return undefined;
    const from = this.storagePublicFrom(path);
    const items = [...this.storage.values()]
      .filter((item) => this.storageParentOf(item.path) === path)
      .map((item) => this.storageView(item));
    return { path, items, public: from != null, publicFrom: from };
  }

  searchStorage(q: string): StorageItem[] {
    const needle = q.toLowerCase();
    return [...this.storage.values()]
      .filter((item) => item.name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((item) => this.storageView(item));
  }

  getStorageFolders(): string[] {
    return [...this.storage.values()].filter((i) => i.kind === 'folder').map((i) => i.path).sort();
  }

  createStorageFolder(path: string): StorageItem | 'exists' | 'no-parent' {
    if (this.storage.has(path)) return 'exists';
    if (!this.storageExists(this.storageParentOf(path))) return 'no-parent';
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

  completeStorageUpload(token: string, bytes: ArrayBuffer | null): StorageItem | undefined {
    const upload = this.storageLinks.get(token);
    if (!upload) return undefined;
    const { path, size, contentType } = upload;
    this.storageLinks.delete(token);
    return this.addStorageFile(path, size, contentType, bytes);
  }

  createStorageUpload(path: string, size: number, contentType: string): { uploadUrl: string } | undefined {
    const limit = this.storageUsedBytes();
    // The free plan storage limit is 256 MB.
    if (limit + size > 256 * 1024 * 1024) return undefined;
    const token = newId('upt');
    this.storageLinks.set(token, { path, size, contentType });
    return { uploadUrl: `/v1/storage/uploads/${token}` };
  }

  renameStorageItem(path: string, name: string, makePublic?: boolean): StorageItem | null | 'exists' | 'missing' {
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

  moveStorageItems(paths: string[], to: string): number | 'bad-target' {
    if (!this.storageExists(to)) return 'bad-target';
    if (paths.some((p) => to === p || to.startsWith(`${p}/`))) return 'bad-target';
    let moved = 0;
    for (const path of paths) {
      const item = this.storage.get(path);
      if (!item || this.storageParentOf(path) === to) continue;
      const taken = new Set(this.getStorageList(to)!.items.map((i) => i.name));
      let name = item.name;
      for (let n = 1; taken.has(name); n += 1) name = `${item.name} (${n})`;
      this.storageRelocate(path, to ? `${to}/${name}` : name);
      moved += 1;
    }
    return moved;
  }

  deleteStorageItems(paths: string[]): { deleted: number; freed: number } {
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

  previewStorage(path: string): { url: string | null; text: string | null; truncated: boolean } | undefined {
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

  createStorageLink(path: string, expiresIn: '1h' | '1d' | '7d'): { url: string; expiresAt: string } | undefined {
    if (!this.storage.get(path)) return undefined;
    const ms = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000 }[expiresIn];
    const token = newId('lnk');
    this.storagePublic.set(path, `https://files.dpl.app/${encodeURI(path)}?token=${token}`);
    return {
      url: `https://files.dpl.app/${encodeURI(path)}?token=${token}`,
      expiresAt: new Date(Date.now() + ms).toISOString(),
    };
  }

  // ── storage helpers ───────────────────────────────────────────────────────────

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

  private addStorageFile(path: string, size: number, contentType: string, bytes: ArrayBuffer | null): StorageItem {
    const folder = this.storageParentOf(path);
    const taken = new Set(this.getStorageList(folder)!.items.map((i) => i.name));
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

  // ── Webhooks ──────────────────────────────────────────────────────────────────

  getWebhookEndpoint(): WebhookEndpoint | null {
    return this.webhookEndpoint;
  }

  rotateWebhookEndpoint(): WebhookEndpoint {
    const token = () => Math.random().toString(36).slice(2, 10);
    this.webhookEndpoint = { url: `https://hooks.dpl.app/h/${token()}`, createdAt: new Date().toISOString() };
    this.webhookRequests = [];
    return this.webhookEndpoint;
  }

  listWebhookRequests(): WebhookRequest[] {
    return this.webhookRequests.slice(0, 50);
  }

  clearWebhookRequests(): void {
    this.webhookRequests = [];
  }

  captureWebhookRequest(request: Omit<WebhookRequest, 'id' | 'receivedAt'>): WebhookRequest {
    const id = `wh_${++this.webhookSeq}${Math.random().toString(36).slice(2, 4)}`;
    const entry: WebhookRequest = { ...request, id, receivedAt: new Date().toISOString() };
    this.webhookRequests = [entry, ...this.webhookRequests];
    return entry;
  }

  getWebhookRequest(id: string): WebhookRequest | undefined {
    return this.webhookRequests.find((r) => r.id === id);
  }

  // ── APIs ──────────────────────────────────────────────────────────────────────

  listApiKeys(): ApiKey[] {
    return [...this.apiKeys];
  }

  createApiKey(input: NewApiKey): CreatedApiKey {
    const secret = `dpl_${input.mode}_${Math.random().toString(16).slice(2, 42)}`;
    const key: ApiKey = {
      id: newId('key'),
      name: input.name,
      prefix: secret.slice(0, 13),
      mode: input.mode,
      access: input.access,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      createdBy: this.currentUser ? this.currentUser.name : 'you',
    };
    this.apiKeys = [key, ...this.apiKeys];
    return { ...key, secret };
  }

  revokeApiKey(id: string): boolean {
    const found = this.apiKeys.some((k) => k.id === id);
    this.apiKeys = this.apiKeys.filter((k) => k.id !== id);
    return found;
  }

  getApiUsage(): ApiUsage {
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

  listApiRequests(api?: ApiId): ApiRequest[] {
    return (api ? this.apiRequests.filter((r) => r.api === api) : this.apiRequests).slice(0, 50);
  }

  tryApi(request: TryRequest): { status: number; durationMs: number; body: unknown } {
    const started = Date.now();
    const api = this.apiOfPath(request.path);
    const status = api ? 200 : 404;
    const body = api ? { id: `t_${Math.random().toString(16).slice(2, 10)}`, ok: true } : { error: { code: 'not_found', message: `No endpoint ${request.method} ${request.path}.` } };
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

  // ── Security ────────────────────────────────────────────────────────────────

  getSecurityOverview(_userId: string): SecurityOverviewDto {
    return {
      passwordChangedAt: this.passwordChangedAt,
      twoFactor: {
        enabled: this.twoFactorEnabled,
        enabledAt: this.twoFactorEnabledAt,
        recoveryCodesLeft: this.recoveryCodes.length,
      },
    };
  }

  changePassword(userId: string, current: string, next: string): void {
    const user = this.users.get(userId);
    if (!user || user.password !== current) {
      throw new Error('Current password is incorrect');
    }
    user.password = next;
    this.passwordChangedAt = new Date().toISOString();
  }

  setupTwoFactor(): TwoFactorSetupDto {
    const secret = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(Math.random() * 32)]).join('');
    return {
      secret,
      otpauthUrl: `otpauth://totp/Deplogram:user@deplogram.app?secret=${secret}`,
    };
  }

  enableTwoFactor(code: string): { recoveryCodes: string[] } {
    if (!/^\d{6}$/.test(code)) {
      throw new Error('Invalid code');
    }
    this.twoFactorEnabled = true;
    this.twoFactorEnabledAt = new Date().toISOString();
    this.recoveryCodes = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join(''));
    return { recoveryCodes: [...this.recoveryCodes] };
  }

  disableTwoFactor(code: string): void {
    if (!/^\d{6}$/.test(code)) {
      throw new Error('Invalid code');
    }
    this.twoFactorEnabled = false;
    this.twoFactorEnabledAt = null;
    this.recoveryCodes = [];
  }

  newRecoveryCodes(): { recoveryCodes: string[] } {
    if (!this.twoFactorEnabled) {
      throw new Error('Two-factor is not enabled');
    }
    this.recoveryCodes = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join(''));
    return { recoveryCodes: [...this.recoveryCodes] };
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  registerSession(sessionToken: string, userId: string, info: { browser: string; os: string; device: 'desktop' | 'mobile'; location: string | null; ip: string }): void {
    const now = new Date().toISOString();
    this.sessions.set(sessionToken, { id: sessionToken, userId, ...info, lastActiveAt: now, createdAt: now, current: true });
    // Mark all other sessions as not current.
    for (const [token, session] of this.sessions.entries()) {
      if (token !== sessionToken) session.current = false;
    }
  }

  touchSession(sessionToken: string): void {
    const session = this.sessions.get(sessionToken);
    if (session) session.lastActiveAt = new Date().toISOString();
  }

  getSessions(userId: string): SessionDto[] {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .map(({ userId: _userId, ...rest }) => rest);
  }

  endSession(sessionToken: string): boolean {
    return this.sessions.delete(sessionToken);
  }

  endOtherSessions(currentSessionToken: string): void {
    for (const [token] of this.sessions.entries()) {
      if (token !== currentSessionToken) this.sessions.delete(token);
    }
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  getNotificationSettings(): { email: string; events: Record<NotificationEvent, boolean>; digest: 'off' | 'weekly' } {
    return { ...this.notificationSettings, events: { ...this.notificationSettings.events } };
  }

  updateNotificationSettings(update: { events?: Partial<Record<NotificationEvent, boolean>>; digest?: 'off' | 'weekly' }): { email: string; events: Record<NotificationEvent, boolean>; digest: 'off' | 'weekly' } {
    if (update.events) {
      this.notificationSettings.events = { ...this.notificationSettings.events, ...update.events } as Record<NotificationEvent, boolean>;
    }
    if (update.digest !== undefined) {
      this.notificationSettings.digest = update.digest;
    }
    return this.getNotificationSettings();
  }

  // ── Git ─────────────────────────────────────────────────────────────────────

  gitConnected = true;
  gitAccount: string | null = 'princeion';

  getGitInstallations(): { id: number; account: string; type: 'user' | 'organization'; repositorySelection: 'all' | 'selected'; repositories: number; installedAt: string; settingsUrl: string }[] {
    return [
      {
        id: 1,
        account: this.gitAccount ?? '',
        type: 'user',
        repositorySelection: 'all',
        repositories: this.repositories.size,
        installedAt: new Date().toISOString(),
        settingsUrl: 'https://github.com/settings/installations/1',
      },
    ];
  }

  connectGit(): { url: string } {
    this.gitConnected = true;
    this.gitAccount = 'princeion';
    return { url: '/dashboard/settings/git?connected=1' };
  }

  disconnectGit(): void {
    this.gitConnected = false;
    this.gitAccount = null;
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** A deterministic script for running a pad, mirroring the CodePad mock. */
function padScript(pad: CodePad): { text: string; stream?: 'stdout' | 'stderr'; delay: number }[] {
  if (pad.runtime === 'static') {
    return [
      { text: `$ serve . (${pad.files.length} files)`, delay: 150 },
      { text: `Serving ${pad.entry} with ${pad.files.filter((f) => f.path.endsWith('.css')).length} stylesheet(s) and ${pad.files.filter((f) => f.path.endsWith('.js')).length} script(s)`, delay: 350 },
      { text: "Preview is live in the panel on the right.", delay: 150 },
    ];
  }
  if (pad.runtime === 'python') {
    const names = pad.files.find((f) => f.path === pad.entry)?.content.match(/\["([^\]]+)"\]/)?.[1]?.split(/",\s*"/) ?? [];
    const day = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
    return [
      { text: `$ python ${pad.entry}`, delay: 200 },
      ...(names.length ? names.map((n, i) => ({ text: `Hello, ${n}! Today is ${day}.`, delay: i === 0 ? 600 : 80 })) : [{ text: '(no output)', delay: 600 }]),
      { text: 'Process finished with exit code 0', delay: 120 },
    ];
  }
  return [
    { text: `$ node ${pad.entry}`, delay: 200 },
    { text: 'Listening on http://localhost:3000', delay: 700 },
    { text: 'GET / 200 3ms', delay: 900 },
    { text: 'Run ended — runs in CodePad are short and time-limited.', delay: 1200 },
  ];
}
