import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import * as express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { join } from 'path';
import { AppModule } from './app.module';
import { StandardResponseInterceptor } from './core/interceptors/standard-response.interceptor';
import { AllExceptionsFilter } from './core/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './core/interceptors/idempotency.interceptor';
import helmet from 'helmet';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';

function resolveCorsOrigins() {
  const configured = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '';
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production' && origins.length === 0) {
    throw new Error('CORS_ORIGINS must be configured in production');
  }

  return origins.length > 0
    ? origins
    : ['http://localhost:5173', 'http://localhost:3000'];
}

async function bootstrap() {
  const logger = WinstonModule.createLogger({
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.ms(),
          nestWinstonModuleUtilities.format.nestLike('BusinessApp', {
            colors: true,
          }),
        ),
      }),
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        format: winston.format.json(),
      }),
      new winston.transports.File({
        filename: 'logs/security.log',
        level: 'warn',
        format: winston.format.json(),
      }),
    ],
  });

  const app = await NestFactory.create(AppModule, { logger });

  // 1. API Versioning & Prefix
  app.setGlobalPrefix('api/v1');

  // 2. Security Headers
  app.use(helmet());
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const hasAuthCookie =
      typeof req.headers.cookie === 'string' &&
      req.headers.cookie.includes('access_token=');
    const csrfHeader = req.headers['x-csrf-protection'];

    if (unsafeMethod && hasAuthCookie && csrfHeader !== '1') {
      return res.status(403).json({
        success: false,
        message: 'CSRF protection header is required',
        error: 'Forbidden',
        data: null,
      });
    }

    return next();
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global Interceptors
  app.useGlobalInterceptors(
    new StandardResponseInterceptor(),
    new IdempotencyInterceptor(),
  );

  // Global Exception Filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Enable Strict CORS
  const allowedOrigins = resolveCorsOrigins();
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS origin denied'), false);
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders:
      'Content-Type,Accept,Authorization,x-idempotency-key,x-csrf-protection',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Server is running on port: ${port}`);
}
bootstrap();
