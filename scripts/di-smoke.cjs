// Proves the tsc build resolves from dist/cjs in a real Nest container: the
// metrics module (ConfigurableModuleBuilder + forRootAsync) and the
// APP_INTERCEPTOR / APP_FILTER classes.
require('reflect-metadata');
const { NestFactory, APP_FILTER, APP_INTERCEPTOR } = require('@nestjs/core');
const { Module } = require('@nestjs/common');
const common = require('../dist/cjs/index.js');
const metrics = require('../dist/cjs/metrics/index.js');

class Root {}
Module({
  imports: [metrics.MetricsModule.forRootAsync({ useFactory: async () => ({ app: 'smoke', port: 0, host: '127.0.0.1' }) })],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: common.TransformInterceptor },
    { provide: APP_FILTER, useClass: common.AllExceptionsFilter },
  ],
})(Root);

NestFactory.create(Root, { logger: false })
  .then(async (app) => {
    await app.init();
    for (const p of [metrics.MetricsService, metrics.MetricsServer]) {
      if (!app.get(p)) throw new Error(`unresolved ${p.name}`);
    }
    if (!app.get(metrics.MetricsServer).port) throw new Error('metrics server not listening');
    console.log('DI smoke ok: metrics module + global interceptor/filter resolved from dist/cjs');
    return app.close();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
