import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { CodePadService } from './codepad.service.js';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import {
  PadDto,
  PadSummaryDto,
  CreatePadDto,
  UpdatePadDto,
  SavePadFileDto,
  RenamePadFileDto,
  RunLogsDto,
  StartRunDto,
} from './dto.js';

/**
 * CodePad: small standalone projects ("pads") edited in the browser — a few files
 * and a runtime — that can be run, previewed and deployed as a real project.
 */
@ApiTags('codepad')
@Controller('v1/pads')
export class CodePadController {
  constructor(private readonly pads: CodePadService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List all CodePad pads, newest first' })
  @ApiResponse({ status: 200, description: 'Pad summaries', type: [PadSummaryDto] })
  list() {
    return this.pads.listPads();
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a pad from a template' })
  @ApiBody({ type: CreatePadDto })
  @ApiResponse({ status: 201, description: 'The new pad', type: PadDto })
  @ApiResponse({ status: 409, description: 'A pad with that name already exists' })
  create(@Body() body: CreatePadDto) {
    return this.pads.createPad(body.name, body.template);
  }

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get one pad with all of its files' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiResponse({ status: 200, description: 'The pad', type: PadDto })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  get(@Param('id') id: string) {
    return this.pads.getPad(id);
  }

  @Patch(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename a pad' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiBody({ type: UpdatePadDto })
  @ApiResponse({ status: 200, description: 'The renamed pad', type: PadDto })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  rename(@Param('id') id: string, @Body() body: UpdatePadDto) {
    return this.pads.updatePad(id, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a pad' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiResponse({ status: 204, description: 'Pad deleted' })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  remove(@Param('id') id: string): void {
    this.pads.deletePad(id);
  }

  @Put(':id/files')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or save one file in a pad' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiBody({ type: SavePadFileDto })
  @ApiResponse({ status: 200, description: 'The saved file', type: Object })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  saveFile(@Param('id') id: string, @Body() body: SavePadFileDto) {
    return this.pads.savePadFile(id, body.path, body.content);
  }

  @Post(':id/files/rename')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename one file in a pad' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiBody({ type: RenamePadFileDto })
  @ApiResponse({ status: 200, description: 'The pad with the file renamed', type: PadDto })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  @ApiResponse({ status: 409, description: 'A file with that name already exists' })
  renameFile(@Param('id') id: string, @Body() body: RenamePadFileDto) {
    return this.pads.renamePadFile(id, body.from, body.to);
  }

  @Delete(':id/files')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete one file from a pad' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiQuery({ name: 'path', type: String, required: true, example: 'index.html' })
  @ApiResponse({ status: 200, description: 'The pad with the file removed', type: PadDto })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  deleteFile(@Param('id') id: string, @Query('path') path: string) {
    if (!path) throw new NotFoundException('No file path given.');
    return this.pads.deletePadFile(id, path);
  }

  @Post(':id/runs')
  @HttpCode(201)
  @ApiOperation({ summary: "Start a run of the pad's saved files" })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiResponse({ status: 201, description: 'The run that was started', type: StartRunDto })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  startRun(@Param('id') id: string) {
    return this.pads.startRun(id);
  }

  @Post(':id/deploy')
  @HttpCode(201)
  @ApiOperation({ summary: 'Deploy a pad as a project (first time: creates the project)' })
  @ApiParam({ name: 'id', type: String, example: 'pad_1' })
  @ApiResponse({ status: 201, description: 'The project and its first deployment', type: Object })
  @ApiResponse({ status: 404, description: 'Pad not found' })
  deploy(@Param('id') id: string) {
    return this.pads.deployPad(id);
  }
}

/** Runs live under /v1/runs. */
@ApiTags('codepad')
@Controller('v1/runs')
export class RunsController {
  constructor(private readonly pads: CodePadService) {}

  @Get(':id/logs')
  @HttpCode(200)
  @ApiOperation({ summary: 'Get a run\'s log, lines after the given cursor' })
  @ApiParam({ name: 'id', type: String, example: 'run_1' })
  @ApiQuery({ name: 'after', type: Number, required: false, example: 0 })
  @ApiResponse({ status: 200, description: 'Run log lines', type: RunLogsDto })
  @ApiResponse({ status: 404, description: 'Run not found' })
  logs(@Param('id') id: string, @Query('after') after?: string) {
    return this.pads.getRunLogs(id, Number(after ?? 0));
  }
}
