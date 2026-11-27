// Runs under plain node, outside jest: jest maps @nestjs/throttler to a test double and cannot
// load the real package. Takes the directory with the compiled API sources, boots AuthController
// behind the real ThrottlerGuard with the ThrottlerModule configuration declared by AppModule,
// and prints the observed HTTP status codes as one JSON line.
import 'reflect-metadata';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

const dist = process.argv[2];
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const { AppModule } = await load('app.module.js');
const { AuthController } = await load('auth/auth.controller.js');
const { AuthService } = await load('auth/auth.service.js');

const configured = Reflect.getMetadata('imports', AppModule)
  .find((entry) => entry?.module === ThrottlerModule);

class ControlController {
  ping() {
    return { ok: true };
  }
}
Controller('control')(ControlController);
Get()(ControlController.prototype, 'ping', Object.getOwnPropertyDescriptor(ControlController.prototype, 'ping'));

class ProbeModule {}
Module({
  imports: [configured],
  controllers: [AuthController, ControlController],
  providers: [
    { provide: AuthService, useValue: { refreshAccess: async () => 'probe-access' } },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})(ProbeModule);

const app = await NestFactory.create(ProbeModule, { logger: false });
await app.listen(0, '127.0.0.1');
const base = await app.getUrl();

async function statuses(count, url, init) {
  const seen = [];
  for (let i = 0; i < count; i += 1) {
    const response = await fetch(`${base}${url}`, init);
    await response.arrayBuffer();
    seen.push(response.status);
  }
  return seen;
}

const auth = await statuses(7, '/auth/refresh', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ refresh_token: 'probe' }),
});
const control = await statuses(10, '/control');

await app.close();
process.stdout.write(`${JSON.stringify({ auth, control })}\n`);
