import { Module } from '@nestjs/common';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

// Reads PM2's own log files for whatever it's currently managing on this
// machine — no DB involved, nothing persisted here. Behind the same global
// JwtAuthGuard as everything else (see main.ts) — dev phase has no
// per-route role gating yet (see DashboardLayout's nav comment), so any
// logged-in non-member user can view this, same as every other page.
@Module({
  controllers: [LogsController],
  providers: [LogsService],
})
export class LogsModule {}
