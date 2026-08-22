import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { LogsService } from './logs.service';

@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @Get('processes')
  listProcesses() {
    return this.logsService.listProcesses();
  }

  @Get()
  tail(@Query('process') process?: string, @Query('type') type?: string, @Query('lines') lines?: string) {
    if (!process?.trim()) {
      throw new BadRequestException('Query param "process" is required — GET /logs/processes to see what\'s running');
    }

    const safeType = type === 'error' ? 'error' : 'out';
    const parsedLines = parseInt(lines ?? '300', 10);
    const safeLines = Number.isFinite(parsedLines) ? Math.min(2000, Math.max(10, parsedLines)) : 300;

    return this.logsService.tail(process.trim(), safeType, safeLines);
  }
}
