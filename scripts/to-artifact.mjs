// dist-artifact/index.html（単一ファイル）を、claude.ai Artifact 用のページ断片に変換する。
// Artifact 側が <!doctype>/<html>/<head>/<body> と viewport を付けるため、それらを取り除く。
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('dist-artifact/index.html', 'utf8');
const head = src.match(/<head>([\s\S]*?)<\/head>/i)[1];
const body = src.match(/<body>([\s\S]*?)<\/body>/i)[1];

const keepHead = head
  .replace(/<meta[^>]*>\s*/gi, '')
  .replace(/<link rel="preconnect"[^>]*>\s*/gi, '');

const out = `${keepHead.trim()}\n${body.trim()}\n`;
writeFileSync('dist-artifact/neon-air-hockey.html', out);
console.log(`dist-artifact/neon-air-hockey.html (${(out.length / 1024).toFixed(1)} KB)`);
