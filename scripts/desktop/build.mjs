import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(repo, 'apps/desktop');
const runtime = join(desktop, 'stage/runtime');
const cache = resolve(process.env.QI_DESKTOP_CACHE || join(repo, '.cache/desktop'));
const cli = join(desktop, '.tools/bin/cargo-tauri');
const mode = process.argv[2] || 'build';
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const sources = JSON.parse(await readFile(join(desktop, 'runtime-sources.json'), 'utf8'));
const target = 'aarch64-apple-darwin';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const shellConfig = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
const buildHome = join(desktop, '.cache/build-home');
await mkdir(buildHome, { recursive: true, mode: 0o700 });
// In particular do not inherit APPLE_*, TAURI_SIGNING_*, Node injection or
// registry credentials. Local packaging must never import a signing key or
// start notarization just because the user's shell happens to configure it.
const env = { PATH: `${dirname(cli)}:/opt/homebrew/bin:/Users/geb/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  TMPDIR: '/tmp', NPM_CONFIG_USERCONFIG: '/dev/null', CARGO_NET_OFFLINE: 'true',
  HOME: buildHome, CODEX_HOME: join(buildHome, '.codex'), NPM_CONFIG_CACHE: join(desktop, '.cache/npm'),
  MACOSX_DEPLOYMENT_TARGET: shellConfig.bundle.macOS.minimumSystemVersion,
  CARGO_HOME: process.env.CARGO_HOME || join(desktop, '.cache/cargo') };
if (shellConfig.version !== pkg.version) throw new Error('Core and desktop versions must match');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only macOS arm64 is supported; other platform packages are NOT_BUILT');
if (!['prepare', 'build', 'dev', 'verify'].includes(mode)) throw new Error('Unknown desktop build mode');

function run(command, args, cwd = repo, binary = false) {
  const report = !binary && ((command === 'cargo' && ['build', 'tauri'].includes(args[0]))
    || (command === 'node' && args[0] === 'scripts/desktop/web-build.mjs')
    || ['/usr/bin/codesign', '/usr/bin/hdiutil'].includes(command));
  if (report) console.log(JSON.stringify({ command, args, cwd, phase: 'STARTED' }));
  const result = spawnSync(command, args, { cwd, env, encoding: binary ? undefined : 'utf8', maxBuffer: 300_000_000 });
  if (report) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.log(JSON.stringify({ command, phase: 'EXITED', exit_code: result.status }));
  }
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${String(result.stderr || result.error || '').slice(-4000)}`);
  return result.stdout;
}
async function source() {
  const entries = {};
  const paths = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean).sort();
  for (const path of paths) {
    const info = await lstat(join(repo, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Non-regular source entry: ${path}`);
    entries[path] = hash(await readFile(join(repo, path)));
  }
  return { source_sha: run('git', ['rev-parse', 'HEAD']).trim(),
    dirty: Boolean(run('git', ['status', '--porcelain']).trim()), source_fingerprint: hash(JSON.stringify(entries)) };
}
const frozenSource = await source();
async function assertSource() {
  if (JSON.stringify(await source()) !== JSON.stringify(frozenSource)) throw new Error('Source changed during the build; candidate rejected');
}

async function copyTracked(paths) {
  const entries = run('git', ['ls-files', '-z', '--', ...paths]).split('\0').filter(Boolean);
  for (const path of entries) {
    const parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe tracked resource path');
    for (let index = 1; index <= parts.length; index++) {
      const info = await lstat(join(repo, ...parts.slice(0, index)));
      if (info.isSymbolicLink() || (index === parts.length ? !info.isFile() : !info.isDirectory())) {
        throw new Error(`Non-regular tracked resource: ${path}`);
      }
    }
    await mkdir(dirname(join(runtime, path)), { recursive: true });
    await copyFile(join(repo, path), join(runtime, path));
  }
}

async function files(root, prefix = '') {
  const result = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(root, entry.name); const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not accepted in runtime resources: ${name}`);
    if (entry.isDirectory()) Object.assign(result, await files(path, `${name}/`));
    else if (entry.isFile() && name !== 'runtime-manifest.json') result[name] = hash(await readFile(path));
  }
  return result;
}

async function manifest(root) {
  const record = { schema: 1, architecture: 'aarch64', target, version: pkg.version,
    ...frozenSource, node_version: sources.node.version, babashka_version: sources.babashka.version,
    reference_sha: '687f282e8625c6b8d11ff58211a90524be2e4317', files: await files(root) };
  await writeFile(join(root, 'runtime-manifest.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function licenses(root) {
  const targetRoot = join(root, 'licenses'); await mkdir(targetRoot, { recursive: true });
  const supplementalRoot = join(targetRoot, 'supplemental');
  const supplemental = JSON.parse(await readFile(join(desktop, 'notices/sources.json'), 'utf8'));
  await mkdir(supplementalRoot, { recursive: true });
  for (const notice of supplemental.notices) {
    if (!/^[a-f0-9]{64}\.txt$/.test(notice.file)) throw new Error('Invalid supplemental notice path');
    const text = await readFile(join(desktop, 'notices', notice.file));
    if (hash(text) !== notice.sha256) throw new Error('Supplemental notice checksum mismatch');
    await writeFile(join(supplementalRoot, notice.file), text);
  }
  await copyFile(join(desktop, 'notices/sources.json'), join(supplementalRoot, 'sources.json'));
  const records = []; const missing = [];
  async function collect(name, version, directory, license, sourceUrl) {
    const id = `${name.replaceAll('/', '_')}@${version}`;
    const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice|copyright)(\.|$|-)/i.test(name));
    const copied = [];
    for (const name of names) {
      const path = join(directory, name); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) continue;
      await mkdir(join(targetRoot, id), { recursive: true });
      await copyFile(path, join(targetRoot, id, name)); copied.push(`${id}/${name}`);
    }
    if (!copied.length) {
      for (const notice of supplemental.notices.filter(item => item.package === `${name}@${version}`)) {
        copied.push(`supplemental/${notice.file}`);
        if (notice.license_identifier === 'NOASSERTION') {
          const standard = supplemental.notices.find(item => item.package === 'MIT-standard-text');
          copied.push(`supplemental/${standard.file}`);
        }
      }
      // These two native build-tool packages publish their notice with the
      // same-version parent npm package. Neither native builder is shipped.
      const parent = name.startsWith('@esbuild/') ? 'esbuild' : name.startsWith('@rolldown/binding-') ? 'rolldown' : null;
      if (parent) {
        const matching = records.find(item => item.name === parent && item.version === version);
        if (matching) copied.push(...matching.notices);
        else {
          const parentRoot = join(repo, 'node_modules', parent);
          const metadata = JSON.parse(await readFile(join(parentRoot, 'package.json'), 'utf8'));
          if (metadata.version !== version) throw new Error('Native npm notice parent version mismatch');
          for (const name of (await readdir(parentRoot)).filter(name => /^licen[cs]e(\.|$|-)/i.test(name))) {
            const path = join(parentRoot, name); const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) continue;
            await mkdir(join(targetRoot, id), { recursive: true });
            await copyFile(path, join(targetRoot, id, name)); copied.push(`${id}/${name}`);
          }
        }
      }
    }
    records.push({ name, version, license: license || 'SEE_PACKAGE_LICENSE', source_url: sourceUrl, notices: copied });
    if (!copied.length) missing.push(id);
  }
  const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'));
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || path.split('/').includes('..')) continue;
    const directory = join(repo, path);
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      await collect(metadata.name || path, metadata.version || value.version, directory, metadata.license,
        `https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const project of ['apps/tui-rs/Cargo.toml', 'apps/desktop/src-tauri/Cargo.toml']) {
    const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', target, '--manifest-path', project]));
    for (const value of metadata.packages) {
      if (!value.source || records.some(item => item.name === value.name && item.version === value.version)) continue;
      await collect(value.name, value.version, dirname(value.manifest_path), value.license,
        `https://crates.io/crates/${value.name}/${value.version}`);
    }
  }
  await copyFile(join(repo, 'LICENSE'), join(targetRoot, 'qi-agent-LICENSE'));
  await copyFile(join(cache, 'babashka-LICENSE'), join(targetRoot, 'babashka-LICENSE'));
  await writeFile(join(targetRoot, 'packages.json'), `${JSON.stringify({ notice_paths_relative_to: 'licenses', packages: records, missing_package_notice_files: missing }, null, 2)}\n`);
  if (missing.length) throw new Error(`Missing third-party notices: ${missing.join(', ')}`);
}

async function prepare() {
  await assertSource();
  const archive = join(cache, sources.node.archive);
  if (hash(await readFile(archive)) !== sources.node.sha256) throw new Error('Missing/mismatched official Node archive; run desktop:bootstrap explicitly');
  if (hash(await readFile(join(cache, 'babashka-LICENSE'))) !== sources.babashka.license_sha256) throw new Error('Babashka license mismatch');
  const bb = process.env.QI_DESKTOP_BB || run('/usr/bin/which', ['bb']).trim();
  if (hash(await readFile(bb)) !== sources.babashka.installed_binary_sha256) throw new Error('Installed Babashka differs from the pinned macOS arm64 runtime');
  if (!run(cli, ['--version']).includes('2.12.3')) throw new Error('Expected project-local Tauri CLI 2.12.3');
  // Both builds use the normal sources and locked dependencies. No app or
  // model is run and no user config/credentials enter the staging directory.
  run('cargo', ['build', '--locked', '--offline', '--release', '--manifest-path', 'apps/tui-rs/Cargo.toml', '--bin', 'qi-agent']);
  await assertSource();
  run('node', ['scripts/desktop/web-build.mjs']);
  await assertSource();
  await rm(runtime, { recursive: true, force: true }); // fixed ignored build-owned directory only
  await mkdir(join(runtime, 'bin'), { recursive: true });
  await copyTracked(['src', 'plugins', 'presets', 'assets', 'protocol', 'scripts/lcu', 'bb.edn', 'LICENSE']);
  await copyFile(join(repo, 'presets/standard/agent.edn'), join(runtime, 'agent.edn'));
  const profiles = [join(runtime, 'agent.edn'), join(runtime, 'presets/standard/agent.edn'), join(runtime, 'presets/creator/agent.edn')];
  run(bb, [join(repo, 'scripts/desktop/profile.clj'), ...profiles]);
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'qi-agent-desktop-runtime', version: pkg.version, type: 'module' }));
  await copyFile(bb, join(runtime, 'bin/bb'));
  await copyFile(join(repo, 'apps/tui-rs/target/release/qi-agent'), join(runtime, 'bin/qi-agent'));
  const prefix = sources.node.archive.replace(/\.tar\.gz$/, '');
  const node = run('/usr/bin/tar', ['-xOf', archive, `${prefix}/bin/node`], repo, true);
  await writeFile(join(runtime, 'bin/node'), node, { mode: 0o755 });
  for (const name of ['node', 'bb', 'qi-agent']) await chmod(join(runtime, 'bin', name), 0o755);
  await mkdir(join(runtime, 'licenses'), { recursive: true });
  await writeFile(join(runtime, 'licenses/node-LICENSE'), run('/usr/bin/tar', ['-xOf', archive, `${prefix}/LICENSE`], repo, true));
  await cp(join(repo, 'apps/web/dist'), join(runtime, 'apps/web/dist'), { recursive: true });
  await build({ entryPoints: [join(repo, 'apps/web-host/server.ts')], outfile: join(runtime, 'apps/web-host/server.js'), bundle: true,
    platform: 'node', format: 'esm', target: 'node24', sourcemap: false });
  await build({ entryPoints: [join(desktop, 'host.ts')], outfile: join(runtime, 'apps/desktop/host.mjs'), bundle: true,
    external: ['../web-host/server.js'], platform: 'node', format: 'esm', target: 'node24', sourcemap: false });
  await licenses(runtime);
  await assertSource();
  await manifest(runtime);
  run('cargo', ['tauri', 'icon', join(desktop, 'icon.svg'), '--output', join(desktop, 'src-tauri/icons')], desktop);
  await assertSource();
  console.log(`Prepared ${runtime}. No desktop/Host/model E2E was run.`);
}

async function verify(app) {
  const root = join(app, 'Contents/Resources/runtime');
  const manifestPath = join(root, 'runtime-manifest.json');
  const record = JSON.parse(await readFile(manifestPath, 'utf8'));
  const actual = await files(root);
  if (JSON.stringify(actual) !== JSON.stringify(record.files)) throw new Error('Packaged runtime files differ from final manifest');
  for (const binary of ['node', 'bb', 'qi-agent']) {
    const path = join(root, 'bin', binary);
    const dependencies = run('/usr/bin/otool', ['-L', path]);
    for (const line of dependencies.split('\n').slice(1).filter(Boolean)) {
      const dependency = line.trim().split(' (')[0];
      if (!dependency.startsWith('/usr/lib/') && !dependency.startsWith('/System/Library/')) throw new Error(`Non-system dependency in packaged ${binary}: ${dependency}`);
    }
    if (!run('/usr/bin/lipo', ['-archs', path]).includes('arm64')) throw new Error(`Wrong architecture: ${binary}`);
  }
  const info = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents/Info.plist')]).trim();
  if (!run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS', info)]).includes('arm64')) throw new Error('Wrong shell architecture');
  console.log('Static package resource/architecture/linkage verification passed; runtime and real E2E remain unverified.');
  return record;
}

const app = join(desktop, 'src-tauri/target/release/bundle/macos/qi-agent.app');
if (mode === 'verify') { await verify(process.argv[3] ? resolve(process.argv[3]) : app); }
else {
  if (mode === 'build' && frozenSource.dirty) throw new Error('Release packaging requires a clean committed candidate; use prepare/check while implementing');
  await prepare();
  if (mode === 'dev') { run('cargo', ['tauri', 'dev'], desktop); }
  if (mode === 'build') {
    run('cargo', ['tauri', 'build', '--bundles', 'app', '--', '--locked', '--offline'], desktop);
    await assertSource();
    // Tauri may re-sign native resources during bundling. Freeze FINAL bytes,
    // then seal the app locally with an ad-hoc identity (no key or notary).
    await manifest(join(app, 'Contents/Resources/runtime'));
    run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    await assertSource();
    await verify(app);
    const output = join(repo, 'out/desktop', `${pkg.version}-${target}-${frozenSource.source_sha.slice(0, 12)}`);
    await mkdir(output, { recursive: true });
    const copied = join(output, 'qi-agent.app');
    await rm(copied, { recursive: true, force: true });
    await cp(app, copied, { recursive: true, dereference: false });
    const imageRoot = join(output, 'dmg-content');
    await rm(imageRoot, { recursive: true, force: true });
    await mkdir(imageRoot, { recursive: true });
    await cp(copied, join(imageRoot, 'qi-agent.app'), { recursive: true });
    await symlink('/Applications', join(imageRoot, 'Applications'));
    const dmg = join(output, `qi-agent-${pkg.version}-${target}-adhoc.dmg`);
    const result = { version: pkg.version, target, ...frozenSource, app: copied, dmg,
      dmg_sha256: null, dmg_status: 'NOT_BUILT', app_files_sha256: hash(JSON.stringify(await files(copied))),
      manifest_sha256: hash(await readFile(join(copied, 'Contents/Resources/runtime/runtime-manifest.json'))),
      signature: 'ad-hoc; no signing key/notarization/publication', package_verification: 'STATIC_ONLY', actual_e2e: 'NOT_RUN' };
    await writeFile(join(output, 'build-receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
    try {
      run('/usr/bin/hdiutil', ['create', '-volname', 'qi-agent', '-srcfolder', imageRoot, '-format', 'UDZO', '-ov', dmg]);
      await assertSource();
      result.dmg_sha256 = hash(await readFile(dmg)); result.dmg_status = 'BUILT_NOT_LAUNCHED';
    } catch (error) {
      result.dmg_status = 'FAILED_STOPPED'; result.dmg_error = error.message;
      await writeFile(join(output, 'build-receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
      throw error; // no alternate packager or retry after a denial
    }
    await writeFile(join(output, 'build-receipt.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  }
}
