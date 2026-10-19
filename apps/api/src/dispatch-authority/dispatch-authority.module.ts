import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthModule } from '../auth/auth.module.js';
import { DispatchAuthorityController } from './dispatch-authority.controller.js';
import { DispatchPrincipalGuard } from './dispatch-principal.guard.js';
import {
  DISPATCH_ID_SOURCE,
  DispatchAuthorityService,
  TERMINAL_DECLARATION_AUTHORITY,
  UnavailableTerminalDeclarationAuthority,
} from './dispatch-authority.service.js';

@Module({
  imports: [AuthModule],
  controllers: [DispatchAuthorityController],
  providers: [
    DispatchAuthorityService,
    DispatchPrincipalGuard,
    { provide: DISPATCH_ID_SOURCE, useValue: { generate: () => randomUUID() } },
    { provide: TERMINAL_DECLARATION_AUTHORITY, useClass: UnavailableTerminalDeclarationAuthority },
  ],
})
export class DispatchAuthorityModule {}
