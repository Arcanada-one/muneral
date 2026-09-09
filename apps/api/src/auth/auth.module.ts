import { Module, Provider, Logger } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GithubStrategy } from './strategies/github.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { JwtOrApiKeyGuard } from './guards/jwt-or-api-key.guard';
import { AgentTaskScopeGuard } from './guards/agent-task-scope.guard';

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
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    ...optionalProviders,
    JwtAuthGuard,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    AgentTaskScopeGuard,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    AgentTaskScopeGuard,
  ],
})
export class AuthModule {}
