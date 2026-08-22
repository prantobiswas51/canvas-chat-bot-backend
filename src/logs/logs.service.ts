import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { open, stat } from 'fs/promises';

const execFileAsync = promisify(execFile);

// Only the fields we actually read out of `pm2 jlist`'s (much larger) JSON.
interface Pm2ProcessEnv {
  status?: string;
  pm_out_log_path?: string;
  pm_err_log_path?: string;
  pm_uptime?: number;
  restart_time?: number;
}

interface Pm2Process {
  name: string;
  pm_id: number;
  pid?: number;
  pm2_env: Pm2ProcessEnv;
}

export interface LogProcessSummary {
  name: string;
  pmId: number;
  status: string;
  pid?: number;
  restarts: number;
}

// Cap how much of a log file we ever pull into memory — logs can grow to
// hundreds of MB over time, but the frontend only ever wants the last
// couple thousand lines, so there's no reason to read more than the tail.
const MAX_TAIL_BYTES = 512 * 1024;

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  async listProcesses(): Promise<LogProcessSummary[]> {
    const processes = await this.pm2List();
    return processes.map((p) => ({
      name: p.name,
      pmId: p.pm_id,
      status: p.pm2_env.status ?? 'unknown',
      pid: p.pid,
      restarts: p.pm2_env.restart_time ?? 0,
    }));
  }

  async tail(processName: string, type: 'out' | 'error', maxLines: number): Promise<{ path: string; lines: string[] }> {
    const processes = await this.pm2List();
    const proc = processes.find((p) => p.name === processName);
    if (!proc) {
      const available = processes.map((p) => p.name).join(', ') || '(none running)';
      throw new NotFoundException(`No PM2 process named "${processName}" — currently running: ${available}`);
    }

    const path = type === 'error' ? proc.pm2_env.pm_err_log_path : proc.pm2_env.pm_out_log_path;
    if (!path) {
      throw new NotFoundException(`PM2 process "${processName}" has no ${type} log path configured`);
    }

    const lines = await this.readTail(path, maxLines);
    return { path, lines };
  }

  // Shells out to the pm2 CLI rather than the `pm2` npm package's
  // programmatic API — no extra dependency, and this only ever needs a
  // point-in-time snapshot (not a persistent RPC connection to the daemon).
  // Requires the backend process to run as the same user (or otherwise have
  // permission) as whatever `pm2` daemon is managing these processes.
  private async pm2List(): Promise<Pm2Process[]> {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], { maxBuffer: 10 * 1024 * 1024 });
      return JSON.parse(stdout) as Pm2Process[];
    } catch (err) {
      this.logger.error(`pm2 jlist failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'Could not reach PM2 — make sure the pm2 CLI is installed and this backend is running as the same user as the PM2 daemon.',
      );
    }
  }

  private async readTail(filePath: string, maxLines: number): Promise<string[]> {
    try {
      const info = await stat(filePath);
      const start = Math.max(0, info.size - MAX_TAIL_BYTES);
      const length = info.size - start;

      const handle = await open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        let text = buffer.toString('utf-8').split('\n');
        // When we didn't start at byte 0, the first line is almost
        // certainly a mid-line fragment — drop it rather than show garbage.
        if (start > 0) text = text.slice(1);
        return text.filter((line) => line.length > 0).slice(-maxLines);
      } finally {
        await handle.close();
      }
    } catch (err) {
      this.logger.warn(`Could not read log file ${filePath}: ${(err as Error).message}`);
      return [`[Could not read log file at ${filePath}: ${(err as Error).message}]`];
    }
  }
}
