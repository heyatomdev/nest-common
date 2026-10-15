import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

export const NO_TRANSFORM_KEY = 'heyatom:no-transform';

/**
 * Opts a handler (or a whole controller) out of the `{ data }` envelope and of the
 * error-body normalization (api.md §2–§3): files, streams, redirects, JWKS/OAuth,
 * health checks, inbound webhook replies.
 */
export const NoTransform = () => SetMetadata(NO_TRANSFORM_KEY, true);

/**
 * Set on the request by `TransformInterceptor` for `@NoTransform()` handlers: exception
 * filters get no handler/class from Nest, so this is how the filter learns about it.
 */
export const NO_TRANSFORM_REQUEST = Symbol('heyatom:no-transform');

/**
 * Wraps every 2xx JSON body in `{ data }` (api.md §2). Passes through:
 * `null`/`undefined` (no body), and an already-built `{ data, meta }` from `paginate()`.
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
        if (typeof body === 'object' && 'data' in body && 'meta' in body) return body;
        return { data: body };
      }),
    );
  }
}
