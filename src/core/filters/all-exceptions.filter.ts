import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const isProduction = process.env.NODE_ENV === 'production';
    const correlationId =
      request.headers['x-request-id']?.toString() ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: any = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      
      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        message = (exceptionResponse as any).message || exceptionResponse;
      } else {
        message = exceptionResponse;
      }
    } else if (exception instanceof Error && !isProduction) {
      message = exception.message;
    }

    if (status >= 500) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} failed: ${error.message}`,
        error.stack,
      );
      if (isProduction) {
        message = 'Internal server error';
      }
    }

    const errorName =
      isProduction && status >= 500
        ? 'InternalServerError'
        : exception instanceof Error
          ? exception.name
          : 'UnknownError';

    response.status(status).json({
      success: false,
      message: Array.isArray(message) ? message[0] : message,
      error: errorName,
      correlationId,
      data: null,
    });
  }
}
