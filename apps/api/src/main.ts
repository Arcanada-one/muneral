import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { bindsEveryInterface, resolveBindHost } from './bind-host.js';
import helmet from 'helmet';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Express 5 (shipped with NestJS 11) changed the default query parser to
  // 'simple'; set it back to 'extended' (qs) to preserve NestJS 10 behaviour.
  app.getHttpAdapter().getInstance().set('query parser', 'extended');

  // Security headers
  app.use(helmet());

  // CORS — only allow the Muneral web app
  app.enableCors({
    origin: process.env.WEB_URL ?? 'https://app.muneral.com',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global validation pipe — validates all DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global API prefix; health check is excluded (served at /health)
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  // The bind host is explicit and defaults to loopback — see bind-host.ts. Before A2-255 this was
  // `app.listen(port)`, which binds every interface; on a mesh host that published the API to every
  // peer, and production was narrow only because compose maps 127.0.0.1:3500:3500. The container
  // sets HOST=0.0.0.0, where binding every interface is what a published port needs.
  const port = parseInt(process.env.PORT ?? '3500', 10);
  const host = resolveBindHost();
  await app.listen(port, host);
  // The address is logged, not just the port: "running on port 3500" was true of both the old
  // behaviour and the new one, which is exactly the distinction an operator needs to read here.
  console.log(
    `Muneral API listening on ${host}:${port}` +
      (bindsEveryInterface(host) ? ' (every interface — expected inside a container)' : ''),
  );
}

void bootstrap();
