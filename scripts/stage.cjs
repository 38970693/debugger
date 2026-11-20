const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { resolve, join } = require('node:path');

const root = resolve(__dirname, '..');

function stage(destination) {
  const files = [
    'dist/main.js', 'dist/THIRD-PARTY-NOTICES.txt',
    'panels/browser/index.js', 'panels/browser/index.html', 'panels/browser/index.css',
  ];
  for (const file of files) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(root, file)));
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'private', 'scripts']) delete manifest[field];
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

if (require.main === module) {
  stage(join(root, '.local', 'creator-extension', 'cocos-browser-bridge'));
}

module.exports = { stage };
