import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Logs one structured line per HTTP request with method, path, status and
 * duration. Errors are handled by the exception filter, so this only records
 * the successful completion timing.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const { method, url } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse<{ statusCode: number }>();
        this.logger.log(`${method} ${url} ${response.statusCode}`, {
          method,
          path: url,
          statusCode: response.statusCode,
          durationMs: Date.now() - start,
        });
      }),
    );
  }
}
