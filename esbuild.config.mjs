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

// The detail panel is a separate editor-area webview (createWebviewPanel), so it
// ships as its own IIFE bundle alongside panel.js. Source-keyed: serves
// workflow / team / subagents drill-ins.
const detailViewConfig = {
  ...webviewConfig,
  entryPoints: ['src/detailView.ts'],
  outfile: 'media/detailView.js',
};

if (watch) {
  const [extCtx, webCtx, wfCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
    esbuild.context(detailViewConfig),
  ]);
  await Promise.all([extCtx.watch(), webCtx.watch(), wfCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
    esbuild.build(detailViewConfig),
  ]);
  console.log(production ? 'Production build complete.' : 'Build complete.');
}
