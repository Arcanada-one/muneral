import { Module, Provider, Logger } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { GithubStrategy } from './strategies/github.strategy.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { JwtOrApiKeyGuard } from './guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from './guards/agent-task-scope.guard.js';
import { PROJECT_READ_GRANTS, PROJECT_READ_GRANT_LIST } from './project-read-grants.js';
import {
  WORKSPACE_DIGEST_GRANTS,
  WORKSPACE_DIGEST_GRANT_LIST,
} from './workspace-digest-grants.js';

const optionalProviders: Provider[] = [];

if (process.env.GITHUB_CLIENT_ID) {
  optionalProviders.push(GithubStrategy);
} else {
  new Logger('AuthModule').warn('GITHUB_CLIENT_ID not set — GitHub OAuth disabled');
}

@Module({
  imports: [
    // `.register()`, not the bare module: AuthModuleOptions is provided and
    // exported only by the dynamic form, and JwtAuthGuard injects it. NestJS 11
    // tolerated the bare import; 12 does not, and CI reported
    // `Nest can't resolve dependencies of the JwtAuthGuard (?)` 80 times.
    PassportModule.register({}),
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
    // MUN-0052: the task-index grant list, as a provider so the guard reads it
    // through DI (a test module overrides it) — see project-read-grants.ts.
    { provide: PROJECT_READ_GRANTS, useValue: PROJECT_READ_GRANT_LIST },
    { provide: WORKSPACE_DIGEST_GRANTS, useValue: WORKSPACE_DIGEST_GRANT_LIST },
  ],
  exports: [
    // Re-exported so AuthModuleOptions reaches the modules that USE the guards.
    // `@UseGuards(JwtAuthGuard)` instantiates the guard in the consuming module's
    // container (AgentsModule, TasksModule, …), not in AuthModule, and Nest reads
    // the guard's dependency asymmetrically: PARAMTYPES through the prototype
    // chain (injector.js:221, getMetadata) but OPTIONAL_DEPS own-only
    // (injector.js:228, getOwnMetadata). `class JwtAuthGuard extends
    // AuthGuard('jwt') {}` declares no constructor, so it inherits the TYPE
    // AuthModuleOptions while the `Optional()` mark stays on the mixin —
    // measured: own OPTIONAL undefined, inherited [0]. Nest therefore treats a
    // deliberately optional dependency as required and reports
    // `Nest can't resolve dependencies of the JwtAuthGuard (?) … in the
    // AgentsModule module`. Exporting the provider satisfies it for real.
    PassportModule,
    AuthService,
    JwtAuthGuard,
    ApiKeyGuard,
    JwtOrApiKeyGuard,
    AgentTaskScopeGuard,
    PROJECT_READ_GRANTS,
    WORKSPACE_DIGEST_GRANTS,
  ],
})
export class AuthModule {}
