import { Global, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';
import { AccountController } from './account/account.controller.js';
import { SecurityController } from './account/security.controller.js';
import { NotificationsController } from './account/notifications.controller.js';
import { ActivityModule } from './activity/activity.module.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionMiddleware } from './auth/session.middleware.js';
import { DatabaseService } from './database/database.service.js';
import { DeploymentController } from './deployments/deployments.controller.js';
import { DeploymentService } from './deployments/deployments.service.js';
import { GitModule } from './git/git.module.js';
import { ProjectsController } from './projects/projects.controller.js';
import { ProjectsService } from './projects/projects.service.js';
import { TrafficController } from './traffic/traffic.controller.js';
import { TrafficService } from './traffic/traffic.service.js';
import { UsageController } from './usage/usage.controller.js';
import { UsageService } from './usage/usage.service.js';
import { WorkspaceController } from './workspace/workspace.controller.js';
import { CodePadController } from './codepad/codepad.controller.js';
import { CodePadService } from './codepad/codepad.service.js';
import { RunsController } from './codepad/codepad.controller.js';
import { StorageController } from './storage/storage.controller.js';
import { StorageService } from './storage/storage.service.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { WebhooksService } from './webhooks/webhooks.service.js';
import { ApisController } from './apis/apis.controller.js';
import { ApisService } from './apis/apis.service.js';
import { ApiKeysController } from './apis/apis.controller.js';

/**
 * Everything the web frontend needs under `/v1/*` — the product's API.
 *
 * The controllers of the feature modules live next to their services, and the
 * DatabaseService is shared by all of them so every feature sees the same
 * persisted records. Every read/write is scoped to the requesting user's
 * workspace; there is no shared singleton current user.
 */
@Global()
@Module({
  imports: [ActivityModule, GitModule],
  controllers: [
    AuthController,
    AccountController,
    SecurityController,
    NotificationsController,
    HealthController,
    WorkspaceController,
    TrafficController,
    UsageController,
    ProjectsController,
    DeploymentController,
    CodePadController,
    RunsController,
    StorageController,
    WebhooksController,
    ApisController,
    ApiKeysController,
  ],
  providers: [
    AuthService,
    SessionMiddleware,
    DeploymentService,
    ProjectsService,
    TrafficService,
    UsageService,
    CodePadService,
    StorageService,
    WebhooksService,
    ApisService,
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DeplogramModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
