import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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

  const port = parseInt(process.env.PORT ?? '3500', 10);
  await app.listen(port);
  console.log(`Muneral API running on port ${port}`);
}

void bootstrap();
