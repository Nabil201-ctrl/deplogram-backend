import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DeplogramStore } from '../store.js';
import type { CodePad, CodePadFile, CodePadSummary } from '../store.js';
import type { Deployment, ProjectSummary } from '../types.js';

@Injectable()
export class CodePadService {
  constructor(private readonly store: DeplogramStore) {}

  // ── pads ──────────────────────────────────────────────────────────────────────

  listPads(): CodePadSummary[] {
    return this.store.listPads();
  }

  getPad(id: string): CodePad {
    const pad = this.store.getPad(id);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  createPad(name: string, template: 'static' | 'node' | 'python'): CodePad {
    return this.store.createPad(name, template);
  }

  updatePad(id: string, name: string): CodePad {
    const pad = this.store.updatePad(id, name);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  deletePad(id: string): void {
    const deleted = this.store.deletePad(id);
    if (!deleted) throw new NotFoundException('That pad does not exist.');
  }

  savePadFile(id: string, path: string, content: string): CodePadFile {
    const saved = this.store.savePadFile(id, path, content);
    if (!saved) throw new NotFoundException('That pad does not exist.');
    return saved;
  }

  renamePadFile(id: string, from: string, to: string): CodePad {
    const result = this.store.renamePadFile(id, from, to);
    if (result === 'exists') {
      throw new ConflictException(`There's already a file called ${to}.`);
    }
    if (!result) throw new NotFoundException('That pad does not exist.');
    return result;
  }

  deletePadFile(id: string, path: string): CodePad {
    const pad = this.store.deletePadFile(id, path);
    if (!pad) throw new NotFoundException('That pad does not exist.');
    return pad;
  }

  // ── runs ──────────────────────────────────────────────────────────────────────

  startRun(padId: string): { id: string } {
    const id = this.store.startPadRun(padId);
    if (!id) throw new NotFoundException('That pad does not exist.');
    return { id };
  }

  getRunLogs(
    runId: string,
    after: number,
  ): { lines: { n: number; at: string; text: string; stream: 'stdout' | 'stderr' }[]; done: boolean; exitCode: number | null } {
    const logs = this.store.getRunLogs(runId, after);
    if (!logs) throw new NotFoundException('That run does not exist.');
    return logs;
  }

  // ── deploy ────────────────────────────────────────────────────────────────────

  deployPad(padId: string): { project: ProjectSummary; deployment: Deployment } {
    const result = this.store.deployPad(padId);
    if (!result) throw new NotFoundException('That pad does not exist.');
    return result;
  }
}
