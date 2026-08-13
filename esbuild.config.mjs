import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  // 生产不出 sourcemap：.vscodeignore 会剥掉 **/*.map，留下的只是悬空引用。
  sourcemap: watch,
  minify: !watch
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/nacos-instance-form/index.ts'],
    outfile: 'dist/webview/nacos-instance-form.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/nacos-cluster-status/index.ts'],
    outfile: 'dist/webview/nacos-cluster-status.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/nacos-config-history/index.ts'],
    outfile: 'dist/webview/nacos-config-history.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  }),
  // 一个 bundle 供两个面板用：配置的监听者与服务的订阅者，页面行为完全一致。
  esbuild.context({
    ...common,
    entryPoints: ['webview/nacos-consumers/index.ts'],
    outfile: 'dist/webview/nacos-consumers.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  })
];

const contexts = await Promise.all(contextConfigs);
if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
