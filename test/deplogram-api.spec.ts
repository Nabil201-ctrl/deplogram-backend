import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app-config.js';

describe('Deplogram dashboard API surface (frontend contract)', () => {
  let app: any;
  let agent: any;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    agent = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  // ── unauthenticated ─────────────────────────────────────────────────────────

  it('GET /v1/me is 401 when signed out', async () => {
    await agent.get('/v1/me').expect(401);
  });

  it('GET /v1/workspace is 401 when signed out', async () => {
    await agent.get('/v1/workspace').expect(401);
  });

  it('GET /v1/projects is 401 when signed out', async () => {
    await agent.get('/v1/projects').expect(401);
  });

  it('GET /v1/traffic is 401 when signed out', async () => {
    await agent.get('/v1/traffic').expect(401);
  });

  it('GET /v1/usage is 401 when signed out', async () => {
    await agent.get('/v1/usage').expect(401);
  });

  it('GET /v1/activity is 401 when signed out', async () => {
    await agent.get('/v1/activity').expect(401);
  });

  it('GET /v1/git/connection is 401 when signed out', async () => {
    await agent.get('/v1/git/connection').expect(401);
  });

  it('GET /v1/pads is 401 when signed out', async () => {
    await agent.get('/v1/pads').expect(401);
  });

  it('GET /v1/storage/list is 401 when signed out', async () => {
    await agent.get('/v1/storage/list').expect(401);
  });

  it('GET /v1/apis/usage is 401 when signed out', async () => {
    await agent.get('/v1/apis/usage').expect(401);
  });

  it('GET /v1/api-keys is 401 when signed out', async () => {
    await agent.get('/v1/api-keys').expect(401);
  });

  it('GET /v1/settings is 401 when signed out', async () => {
    await agent.get('/v1/me/settings').expect(401);
  });

  // ── auth ────────────────────────────────────────────────────────────────────

  it('POST /v1/auth/sign-up creates the account, starts a session and returns the viewer', async () => {
    const res = await agent
      .post('/v1/auth/sign-up')
      .send({
        name: 'Ada Lovelace',
        email: 'Ada@Example.com',
        password: 'analytical-engine',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(String),
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      image: null,
    });
    const cookies = res.headers['set-cookie'] ?? [];
    const cookieList = Array.isArray(cookies) ? cookies : [cookies];
    expect(
      cookieList.some((c: string) => c.startsWith('deplogram_session=')),
    ).toBe(true);

    const me = await agent.get('/v1/me').expect(200);
    expect(me.body.email).toBe('ada@example.com');
  });

  it('POST /v1/auth/sign-up creates an empty personal workspace with no projects', async () => {
    await agent
      .post('/v1/auth/sign-up')
      .send({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'hopper-1906',
      })
      .expect(201);

    const workspace = await agent.get('/v1/workspace').expect(200);
    expect(workspace.body).toMatchObject({
      kind: 'personal',
      plan: expect.stringMatching(/^(free|plus|pro|enterprise)$/),
    });

    const projects = await agent.get('/v1/projects').expect(200);
    expect(projects.body).toEqual([]);

    const usage = await agent.get('/v1/usage').expect(200);
    expect(usage.body.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'active_deployments', used: 0 }),
      ]),
    );
  });

  it('POST /v1/auth/sign-up rejects a duplicate email with 409', async () => {
    await agent
      .post('/v1/auth/sign-up')
      .send({
        name: 'Ada Again',
        email: 'ada@example.com',
        password: 'analytical-engine',
      })
      .expect(409);
  });

  it('POST /v1/auth/sign-up validates the sign-up form', async () => {
    await agent
      .post('/v1/auth/sign-up')
      .send({ name: 'Grace', email: 'grace@example.com', password: 'short' })
      .expect(400);
    await agent
      .post('/v1/auth/sign-up')
      .send({ name: 'Grace', email: 'not-an-email', password: 'hopper-1906' })
      .expect(400);
  });

  it('POST /v1/auth/sign-in sets the session cookie and returns the viewer', async () => {
    const res = await agent
      .post('/v1/auth/sign-in')
      .send({ email: 'ada@example.com', password: 'analytical-engine' })
      .expect(200);
    expect(res.body.email).toBe('ada@example.com');
    const cookies = res.headers['set-cookie'] ?? [];
    const cookieList = Array.isArray(cookies) ? cookies : [cookies];
    expect(
      cookieList.some((c: string) => c.startsWith('deplogram_session=')),
    ).toBe(true);
  });

  it('POST /v1/auth/sign-in rejects bad credentials with 401', async () => {
    await agent
      .post('/v1/auth/sign-in')
      .send({ email: 'ada@example.com', password: 'wrong-password' })
      .expect(401);
  });

  it('session persists across requests after sign-in', async () => {
    await agent
      .post('/v1/auth/sign-in')
      .send({ email: 'ada@example.com', password: 'analytical-engine' })
      .expect(200);
    await agent.get('/v1/me').expect(200);
    await agent.get('/v1/workspace').expect(200);
  });

  it('POST /v1/auth/sign-out clears the session', async () => {
    await agent.post('/v1/auth/sign-out').expect(204);
    await agent.get('/v1/me').expect(401);
  });

  // ── github oauth ────────────────────────────────────────────────────────────

  it('POST /v1/git/connection returns the GitHub authorization URL', async () => {
    await agent
      .post('/v1/auth/sign-in')
      .send({ email: 'ada@example.com', password: 'analytical-engine' })
      .expect(200);
    const res = await agent.post('/v1/git/connection').expect(200);
    expect(res.body.url).toContain('github.com/login/oauth/authorize');
    expect(res.body.url).toContain('client_id=');
  });

  // ── cors ────────────────────────────────────────────────────────────────────

  it('reflects the frontend Origin for credentialed CORS requests', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/workspace')
      .set('Origin', 'https://deplogram.app')
      .expect(401);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://deplogram.app',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
