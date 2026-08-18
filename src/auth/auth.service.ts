import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { User, UserRole } from '../users/entities/user.entity';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // Never log the password itself — email + outcome only.
  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.usersService.findByEmailWithPassword(email);
    if (!user) {
      this.logger.warn(`Login failed — no user for email="${email}"`);
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      this.logger.warn(`Login failed — wrong password for email="${email}"`);
      throw new UnauthorizedException('Invalid email or password');
    }

    return user;
  }

  async login(email: string, password: string) {
    const user = await this.validateUser(email, password);
    const tokens = this.signTokens(user);
    this.logger.log(`Login succeeded — email="${email}" role=${user.role}`);
    return { user, tokens };
  }

  // Public self-signup — always MEMBER, regardless of anything the client
  // sends. Real role assignment only happens via an authenticated admin
  // using POST /users (UsersService.create) from the Users page.
  async signup(name: string, email: string, password: string): Promise<User> {
    this.logger.log(`Signup — email="${email}" (assigned role=member)`);
    return this.usersService.create({ name, email, password, role: UserRole.MEMBER });
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.usersService.findOne(payload.sub);
    return this.signTokens(user);
  }

  private signTokens(user: User) {
    const accessExpiresInSeconds = this.parseExpiresInSeconds(
      this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
    );
    const refreshExpiresInSeconds = this.parseExpiresInSeconds(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
    );

    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email, role: user.role, name: user.name },
      {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessExpiresInSeconds,
      },
    );

    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresInSeconds,
      },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: accessExpiresInSeconds,
    };
  }

  // Converts a JWT "expiresIn" string (e.g. '15m', '1h') to seconds for the client.
  private parseExpiresInSeconds(expiresIn: string): number {
    const match = /^(\d+)([smhd])$/.exec(expiresIn);
    if (!match) return 900; // fallback: 15 minutes

    const value = Number(match[1]);
    const unit = match[2];
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
    return value * multiplier;
  }
}
