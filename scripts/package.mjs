import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const stage = join(root, '.package-work', 'vsix');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// Everything except `vscode` is esbuild-bundled into dist/extension.js (see
// esbuild.config.mjs), so the packaged manifest ships with zero runtime
// dependencies and vsce does not need a node_modules install step.
const packagedManifest = { ...manifest, dependencies: {} };

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
await access(join(stage, 'dist', 'hub.js'));
await access(join(stage, 'dist', 'hub-version.json'));

// Entry logos must ship in the VSIX: marketplace PNG + activity-bar SVG.
await cp(join(root, 'media'), join(stage, 'media'), { recursive: true });
for (const asset of ['at-nacos-icon.png', 'at-nacos-icon.svg', 'at-nacos-activity.svg']) {
  await access(join(stage, 'media', asset));
}
if (packagedManifest.icon !== 'media/at-nacos-icon.png') {
  throw new Error(`package.json icon must be media/at-nacos-icon.png (got ${packagedManifest.icon})`);
}
const activityIcon = packagedManifest.contributes?.viewsContainers?.activitybar?.[0]?.icon;
if (activityIcon !== 'media/at-nacos-activity.svg') {
  throw new Error(
    `activitybar icon must be media/at-nacos-activity.svg (got ${activityIcon ?? 'missing'})`
  );
}

// Webview HTML references CSS by extensionUri-relative path (see renderWebviewHtml);
// only the .ts sources are stripped by .vscodeignore at vsce-package time below.
await cp(join(root, 'webview'), join(stage, 'webview'), { recursive: true }).catch(() => {});
await cp(join(root, 'l10n'), join(stage, 'l10n'), { recursive: true }).catch(() => {});
await cp(join(root, 'package.nls.json'), join(stage, 'package.nls.json')).catch(() => {});
await cp(join(root, 'package.nls.zh-cn.json'), join(stage, 'package.nls.zh-cn.json')).catch(() => {});
await cp(join(root, '.vscodeignore'), join(stage, '.vscodeignore'));
await writeFile(join(stage, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8');
await cp(join(root, 'README.md'), join(stage, 'README.md'));
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE')).catch(() => {});

const result = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'npx',
  process.platform === 'win32'
    ? [
        '/c',
        'npx',
        '@vscode/vsce',
        'package',
        '--allow-missing-repository',
        '--no-rewrite-relative-links',
        '--no-dependencies'
      ]
    : ['@vscode/vsce', 'package', '--allow-missing-repository', '--no-rewrite-relative-links', '--no-dependencies'],
  { cwd: stage, stdio: 'inherit' }
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const vsixName = `${manifest.name}-${manifest.version}.vsix`;
await cp(join(stage, vsixName), join(root, vsixName));
console.log(`Successfully created VSIX: ${vsixName}`);
