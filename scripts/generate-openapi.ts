import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';

import { AppModule } from '../src/app.module.js';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const config = new DocumentBuilder()
    .setTitle('Deplogram API')
    .setDescription(
      'Backend API for the Deplogram deployment platform. Contract defined by deplogram-web.',
    )
    .setVersion('1.0.0')
    .addTag('auth', 'Sign-up / sign-in / sign-out and current viewer')
    .addTag('me', 'Account settings and deletion')
    .addTag('workspace', 'Workspace and plan')
    .addTag('traffic', 'Live workspace traffic')
    .addTag('usage', 'Plan usage and limits')
    .addTag('projects', 'Projects, environment variables, logs and metrics')
    .addTag('deployments', 'Deployment list, detail, build logs, redeploy and rollback')
    .addTag('git', 'Git connection, repositories, branches and runtime detection')
    .addTag('activity', 'Audit / activity feed')
    .addTag('codepad', 'CodePad pads, runs and deploys')
    .addTag('storage', 'Workspace drive: folders, files, uploads, previews and links')
    .addTag('webhooks', 'Webhook capture endpoint and requests')
    .addTag('apis', 'Platform APIs: usage, requests and try')
    .addTag('api-keys', 'Platform API keys')
    .addServer('http://localhost:3000', 'Local development')
    .addServer(
      'https://deplogram-backend.vercel.app',
      'Production',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  (document.components ??= {} as any).securitySchemes = {
    ...(document.components?.securitySchemes ?? {}),
    deplogram_session: {
      type: 'apiKey',
      in: 'cookie',
      name: 'deplogram_session',
      description:
        'Signed session cookie. Obtain it by signing in at POST /v1/auth/sign-in or signing up at POST /v1/auth/sign-up.',
    },
  };
  writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');

  await app.close();
}

void main();
