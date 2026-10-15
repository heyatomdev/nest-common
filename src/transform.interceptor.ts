import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { NO_TRANSFORM_KEY, NO_TRANSFORM_REQUEST } from './exception.filter.js';
import { isPaginated } from './pagination.js';

/**
 * Wraps every 2xx JSON body in `{ data }` (api.md §2). Passes through:
 * `null`/`undefined` (no body), and a `paginate()` result (recognized by its marker, not by
 * shape: an entity with `data` and `meta` fields is still wrapped).
 * Register as `APP_INTERCEPTOR`.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  // Explicit @Inject: bundlers without decorator metadata (esbuild, vitest) still resolve it.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    if (this.reflector.getAllAndOverride<boolean>(NO_TRANSFORM_KEY, [ctx.getHandler(), ctx.getClass()])) {
      ctx.switchToHttp().getRequest<Record<symbol, unknown>>()[NO_TRANSFORM_REQUEST] = true;
      return next.handle();
    }
    return next.handle().pipe(
      map((body: unknown) => {
        if (body == null) return body;
        if (isPaginated(body)) return body;
        return { data: body };
      }),
    );
  }
}
