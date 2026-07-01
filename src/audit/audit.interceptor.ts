import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const method = request.method;

    if (!this.writeMethods.has(method)) {
      return next.handle();
    }

    const startedAt = Date.now();

    return next.handle().pipe(
      tap(async (result) => {
        const routePath = request.route?.path || request.url;
        await this.auditService.record({
          userId: request.user?.userId || request.user?.sub,
          businessId: request.user?.businessId,
          action: this.resolveAction(method, routePath),
          resource: this.resolveResource(request.baseUrl || request.url),
          resourceId: request.params?.id || result?.id || result?.data?.id,
          method,
          path: request.originalUrl || request.url,
          statusCode: response.statusCode,
          ipAddress: request.ip,
          details: {
            params: request.params,
            query: request.query,
            body: request.body,
            durationMs: Date.now() - startedAt,
          },
        });
      }),
    );
  }

  private resolveAction(method: string, path: string) {
    if (path?.includes('login')) return 'LOGIN';
    if (path?.includes('restore')) return 'RESTORE';
    if (path?.includes('export') || path?.includes('upload')) return 'BACKUP';
    if (method === 'POST') return 'CREATE';
    if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
    if (method === 'DELETE') return 'DELETE';
    return method;
  }

  private resolveResource(path: string) {
    // Strip '/api/v1/' or '/api/' prefix then take first meaningful segment
    const cleaned = path
      .replace(/\/api\/v\d+\//i, '/')
      .replace(/\/api\//i, '/')
      .replace(/^\//, '');
    const segment = cleaned.split('/')[0];
    return (segment || 'SYSTEM').replace(/-/g, '_').toUpperCase();
  }
}
