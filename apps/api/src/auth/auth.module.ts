import { Module, Provider, Logger } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GithubStrategy } from './strategies/github.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { User } from '../common/entities/user.entity';
import { ApiKey } from '../agents/entities/api-key.entity';

const optionalProviders: Provider[] = [];

if (process.env.GITHUB_CLIENT_ID) {
  optionalProviders.push(GithubStrategy);
} else {
  new Logger('AuthModule').warn('GITHUB_CLIENT_ID not set — GitHub OAuth disabled');
}

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      signOptions: { expiresIn: '15m' },
    }),
    TypeOrmModule.forFeature([User, ApiKey]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    ...optionalProviders,
    JwtAuthGuard,
    ApiKeyGuard,
  ],
  exports: [AuthService, JwtAuthGuard, ApiKeyGuard],
})
export class AuthModule {}
