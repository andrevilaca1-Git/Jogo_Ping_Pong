// Gera dist/ com um único script clássico (IIFE) compatível com navegadores antigos de TV.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome56'],
  outfile: 'dist/game.js',
});
const html = readFileSync('index.html', 'utf8')
  .replace(/<script[^>]*type="module"[^>]*src="src\/main\.js"[^>]*><\/script>/, '<script src="game.js"></script>');
if (!html.includes('src="game.js"')) throw new Error('Tag <script type="module" src="src/main.js"> não encontrada em index.html');
writeFileSync('dist/index.html', html);
for (const f of ['styles.css', 'config.xml', 'icon.png']) if (existsSync(f)) copyFileSync(f, 'dist/' + f);
console.log('Build OK -> dist/');
