const { mkdtempSync, mkdirSync, rmSync, readFileSync, copyFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { name, version } = require('../package.json');
const { stage } = require('./stage.cjs');

const root = resolve(__dirname, '..');
const release = join(root, 'release');
mkdirSync(release, { recursive: true });
const staging = mkdtempSync(join(release, '.stage-'));
const archive = join(release, `${name}-${version}.zip`);
try {
  const extension = join(staging, name);
  stage(extension);
  copyFileSync(join(root, 'README.md'), join(extension, 'README.md'));
  mkdirSync(join(extension, 'docs'));
  for (const file of ['development-plan.md', 'acceptance.md']) {
    copyFileSync(join(root, 'docs', file), join(extension, 'docs', file));
  }
  const manifest = JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8'));
  const main = require(join(extension, manifest.main));
  for (const entry of Object.values(manifest.contributions.messages)) {
    for (const method of entry.methods) {
      if (typeof main.methods[method] !== 'function') throw new Error(`未导出 IPC 方法 ${method}`);
    }
  }
  const zip = spawnSync('tar.exe', ['-a', '-cf', archive, '-C', staging, name], { stdio: 'inherit' });
  if (zip.status !== 0) throw zip.error || new Error('ZIP 打包失败');
  process.stdout.write(`${archive}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
