import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { StandardResponseInterceptor } from './core/interceptors/standard-response.interceptor';
import { AllExceptionsFilter } from './core/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './core/interceptors/idempotency.interceptor';
import helmet from 'helmet';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';

async function bootstrap() {
  const logger = WinstonModule.createLogger({
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.ms(),
          nestWinstonModuleUtilities.format.nestLike('BusinessApp', { colors: true }),
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

  // 1. API Versioning (Disabled because controllers already use /api/v1 prefix)
  /*
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1', // Routes will be prefixed with /v1
  });
  */

  // 2. Security Headers
  app.use(helmet());

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
  app.enableCors({
    origin: process.env.FRONTEND_URL || '*', // Update with specific origins in production
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Server is running on port: ${port}`);
}
bootstrap();
