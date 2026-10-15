import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Fail-closed Swagger gate (api.md §4): an explicit `ENABLE_SWAGGER` wins; otherwise
 * on only when `NODE_ENV` is explicitly `development` or `test`. Unset or unexpected
 * `NODE_ENV` → off. Call it in the config `validate()` to resolve the default once.
 */
export function swaggerEnabled(env: { ENABLE_SWAGGER?: string | boolean; NODE_ENV?: string }): boolean {
  const explicit = env.ENABLE_SWAGGER;
  if (explicit !== undefined && explicit !== '') return explicit === true || explicit === 'true';
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

export interface SwaggerOptions {
  /** Service name. */
  title: string;
  /** `APP_VERSION`, read from the service's package.json at runtime. */
  version: string;
  description?: string;
  /** Declare the auth schemes the service really uses: `b => b.addBearerAuth()`. */
  configure?: (builder: DocumentBuilder) => DocumentBuilder;
}

/** The OpenAPI document — shared by `setupSwagger()` and the service's `openapi:dump` script. */
export function createOpenApiDocument(app: INestApplication, opts: SwaggerOptions): OpenAPIObject {
  let builder = new DocumentBuilder().setTitle(opts.title).setVersion(opts.version);
  if (opts.description) builder = builder.setDescription(opts.description);
  if (opts.configure) builder = opts.configure(builder);
  return SwaggerModule.createDocument(app, builder.build());
}

/** Serves the UI on `/docs` and the JSON on `/docs-json`. Gate the call with `swaggerEnabled()`. */
export function setupSwagger(app: INestApplication, opts: SwaggerOptions): void {
  SwaggerModule.setup('docs', app, () => createOpenApiDocument(app, opts), { jsonDocumentUrl: 'docs-json' });
}
