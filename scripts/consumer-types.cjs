// Declaration emit from a real pnpm consumer of the packed tarball (gatherly hit TS2883 on 0.1.1:
// TS 6 with `module: commonjs` defaults to `bundler` resolution and could not name
// `PaginatedResult` without a condition-free `types` fallback in `exports`).
// Run after `pnpm build`: node scripts/consumer-types.cjs
const { execSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'nest-common-consumer-'));
const sh = (cmd, cwd = dir) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
try {
  const tgz = sh(`pnpm pack --pack-destination ${dir}`, root).trim().split('\n').pop();
  const peers = require(join(root, 'package.json')).peerDependencies;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'consumer', private: true,
    dependencies: { '@heyatom/nest-common': `file:${tgz}`, ...peers, typescript: '^6.0.0' },
  }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'svc.ts'), [
    "import { paginate, PageParams, loggerParams } from '@heyatom/nest-common';",
    "import { MetricsService } from '@heyatom/nest-common/metrics';",
    "import { signStandardWebhook } from '@heyatom/nest-common/webhooks';",
    'export class Svc {',
    '  async list(q: PageParams) { return paginate([1], 1, q); }',
    "  logger() { return loggerParams({ service: 's', level: 'info' }); }",
    "  sign() { return signStandardWebhook({ id: 'a', timestamp: 1, body: '', secrets: ['s'] }); }",
    '  metrics(m: MetricsService) { return m.registry; }',
    '}',
  ].join('\n'));
  sh('pnpm install --silent --config.auto-install-peers=false');
  const base = '--ignoreConfig --declaration --emitDeclarationOnly --strict --skipLibCheck --experimentalDecorators --rootDir src --outDir out src/svc.ts';
  for (const mode of [
    '--module commonjs', // TS 6 default resolution: bundler
    '--module commonjs --moduleResolution node10 --ignoreDeprecations 6.0',
    '--module node16 --moduleResolution node16',
    '--module nodenext --moduleResolution nodenext',
  ]) {
    try {
      sh(`./node_modules/.bin/tsc ${base} ${mode}`);
      console.log(`ok   ${mode}`);
    } catch (err) {
      console.error(`FAIL ${mode}\n${err.stdout}`);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
