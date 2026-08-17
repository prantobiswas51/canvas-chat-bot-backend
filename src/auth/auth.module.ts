import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    UsersModule,
    // Secrets/expiry are passed explicitly per sign()/verify() call in AuthService,
    // since access and refresh tokens use different secrets.
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Global guard: every route requires a valid access token unless
    // decorated with @Public(). Declared here (not AppModule) so it can
    // resolve JwtService from this module's JwtModule import.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
