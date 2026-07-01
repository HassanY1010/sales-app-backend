import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';

// In-memory cache for idempotency.
// Note: For multi-instance deployments (e.g. Kubernetes), replace this with Redis.
const IDEMPOTENCY_CACHE = new Map<string, any>();

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const idempotencyKey = request.headers['x-idempotency-key'];

    // Only apply idempotency to POST and PATCH requests that provide the header
    if (
      idempotencyKey &&
      (request.method === 'POST' || request.method === 'PATCH')
    ) {
      if (IDEMPOTENCY_CACHE.has(idempotencyKey)) {
        console.log(
          `[Idempotency] Returning cached response for key: ${idempotencyKey}`,
        );
        return of(IDEMPOTENCY_CACHE.get(idempotencyKey));
      }

      return next.handle().pipe(
        tap((response) => {
          IDEMPOTENCY_CACHE.set(idempotencyKey, response);
          // Cleanup after 24 hours to prevent memory leaks
          setTimeout(
            () => IDEMPOTENCY_CACHE.delete(idempotencyKey),
            24 * 60 * 60 * 1000,
          );
        }),
      );
    }

    return next.handle();
  }
}
