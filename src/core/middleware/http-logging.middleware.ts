import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly logDir = path.join(process.cwd(), 'logs');
  private readonly logFile = path.join(this.logDir, 'combined.log');

  constructor() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl, ip } = req;
    const userAgent = req.get('user-agent') || '';
    const startTime = Date.now();

    // Filter sensitive fields for safety
    const sanitizeBody = (body: any) => {
      if (!body || typeof body !== 'object') return body;
      const sanitized = { ...body };
      const sensitiveKeys = ['password', 'confirmPassword', 'securityPin', 'newPassword', 'pin'];
      sensitiveKeys.forEach((key) => {
        if (key in sanitized) {
          sanitized[key] = '******';
        }
      });
      return sanitized;
    };

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - startTime;
      const bodyLog = req.body && Object.keys(req.body).length > 0
        ? JSON.stringify(sanitizeBody(req.body))
        : '';

      const logMessage = `[${new Date().toISOString()}] ${method} ${originalUrl} ${statusCode} - ${duration}ms | IP: ${ip} | UA: ${userAgent} | Body: ${bodyLog}`;

      // Print to console using Nest Logger
      if (statusCode >= 400) {
        this.logger.error(`${method} ${originalUrl} ${statusCode} - ${duration}ms`);
      } else {
        this.logger.log(`${method} ${originalUrl} ${statusCode} - ${duration}ms`);
      }

      // Append to file
      fs.appendFileSync(this.logFile, logMessage + '\n', 'utf8');
    });

    next();
  }
}
