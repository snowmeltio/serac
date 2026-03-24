import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Note: media/panel.css is maintained directly (not built by esbuild).

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: !production,
  minify: production,
  target: 'node20',
};

const webviewConfig = {
  entryPoints: ['src/panel.ts'],
  bundle: true,
  outfile: 'media/panel.js',
  format: 'iife',
  platform: 'browser',
  sourcemap: !production,
  minify: production,
  target: 'es2022',
};

if (watch) {
  const [extCtx, webCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  console.log(production ? 'Production build complete.' : 'Build complete.');
}
