const { buildSync } = require('esbuild');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { metafile } = buildSync({
  entryPoints: ['src/main.cjs'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/main.js',
  external: ['bufferutil', 'utf-8-validate'],
  metafile: true,
});

const packageRoots = new Set();
for (const path of Object.keys(metafile.inputs)) {
  const root = path.match(/^node_modules\/(?:@[^/]+\/)?[^/]+/);
  if (root) packageRoots.add(root[0]);
}
const licenses = [...packageRoots].sort().map((path) => {
  const { name, version } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const files = readdirSync(path).filter((file) => /^(LICENSE|COPYING|NOTICE)/i.test(file));
  if (!files.length) throw new Error(`找不到 ${name} 的许可文件`);
  const notices = files.map((file) => readFileSync(join(path, file), 'utf8').trim());
  return `${name} ${version}\n${notices.join('\n\n')}`;
});
writeFileSync('dist/THIRD-PARTY-NOTICES.txt', licenses.join('\n\n-----\n\n') + '\n');
