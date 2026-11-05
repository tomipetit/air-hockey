import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

// artifact モード: 1ファイルにまとめ、three は CDN から importmap で読み込む
const THREE_CDN = `https://cdn.jsdelivr.net/npm/three@${pkg.dependencies.three}`;

function threeImportMap(): Plugin {
  return {
    name: 'three-importmap',
    transformIndexHtml(html) {
      const map = JSON.stringify({
        imports: {
          three: `${THREE_CDN}/build/three.module.js`,
          'three/addons/': `${THREE_CDN}/examples/jsm/`,
        },
      });
      return html.replace('<head>', `<head>\n<script type="importmap">${map}</script>`);
    },
  };
}

export default defineConfig(({ mode }) =>
  mode === 'artifact'
    ? {
        base: './',
        plugins: [threeImportMap(), viteSingleFile()],
        build: {
          outDir: 'dist-artifact',
          rollupOptions: { external: [/^three(\/.*)?$/] },
        },
      }
    : {
        base: './',
        server: { host: true },
        build: { chunkSizeWarningLimit: 900 },
      },
);
