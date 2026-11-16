import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import type { CodePad, CodePadFile, CodePadSummary } from '../database/database.js';
import type { Deployment, ProjectSummary } from '../types.js';

@Injectable()
export class CodePadService {
  constructor(private readonly store: DatabaseService) {}

  // ── pads ──────────────────────────────────────────────────────────────────────

  async listPads(userId: string): Promise<CodePadSummary[]> {
    return this.store.listPads(userId);
  }

  async getPad(userId: string, id: string): Promise<CodePad> {
    const pad = await this.store.getPad(id);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  async createPad(
    userId: string,
    name: string,
    template: 'static' | 'node' | 'python',
  ): Promise<CodePad> {
    return this.store.createPad(userId, name, template);
  }

  async updatePad(userId: string, id: string, name: string): Promise<CodePad> {
    const pad = await this.store.updatePad(id, name);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  async deletePad(userId: string, id: string): Promise<void> {
    const deleted = await this.store.deletePad(id);
    if (!deleted) throw new NotFoundException('That pad does not exist.');
  }

  async savePadFile(
    userId: string,
    id: string,
    path: string,
    content: string,
  ): Promise<CodePadFile> {
    const saved = await this.store.savePadFile(id, path, content);
    if (!saved) throw new NotFoundException('That pad does not exist.');
    return saved;
  }

  async renamePadFile(
    userId: string,
    id: string,
    from: string,
    to: string,
  ): Promise<CodePad> {
    const result = await this.store.renamePadFile(id, from, to);
    if (result === 'exists') {
      throw new ConflictException(`There's already a file called ${to}.`);
    }
    if (!result) throw new NotFoundException('That pad does not exist.');
    return result;
  }

  async deletePadFile(userId: string, id: string, path: string): Promise<CodePad> {
    const pad = await this.store.deletePadFile(id, path);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  // ── runs ──────────────────────────────────────────────────────────────────────

  async startRun(userId: string, padId: string): Promise<{ id: string }> {
    const id = await this.store.startPadRun(padId);
    if (!id) throw new NotFoundException('That pad does not exist.');
    return { id };
  }

  async getRunLogs(
    userId: string,
    runId: string,
    after: number,
  ): Promise<{
    lines: { n: number; at: string; text: string; stream: 'stdout' | 'stderr' }[];
    done: boolean;
    exitCode: number | null;
  }> {
    const logs = await this.store.getRunLogs(runId, after);
    if (!logs) throw new NotFoundException('That run does not exist.');
    return logs;
  }

  // ── deploy ────────────────────────────────────────────────────────────────────

  async deployPad(userId: string, padId: string): Promise<{ project: ProjectSummary; deployment: Deployment }> {
    const result = await this.store.deployPad(padId);
    if (!result) throw new NotFoundException('That pad does not exist.');
    return result;
  }
}
