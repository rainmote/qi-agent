// A single bounded Office conversion inside ExecutionWorld. No Host IPC,
// downloads, install scripts, credential discovery or overwrite of user files.
import { constants } from 'node:fs';
import { open, realpath, lstat, mkdtemp, chmod, link, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, relative, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const maxInput = 20_000_000, maxOutput = 40_000_000;
const inside = (root, path) => { const value = relative(root, path); return value !== '..' && !value.startsWith('../') && !isAbsolute(value); };
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => abort.abort(new Error('conversion_cancelled')));
let directory, converter;
try {
  if (process.argv.length !== 5) throw new Error('invalid_conversion_arguments');
  const [root, source, output] = process.argv.slice(2).map(value => resolve(value));
  if (await realpath(root) !== root || !inside(root, await realpath(source)) || !inside(root, await realpath(dirname(output)))
    || extname(output).toLowerCase() !== '.pdf') throw new Error('conversion_path_not_admitted');
  const extension = extname(source).slice(1).toLowerCase();
  if (!['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'].includes(extension)) throw new Error('unsupported_office_format');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxInput)) throw new Error('office_input_limit');
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) { const result = await input.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new Error('office_input_changed'); offset += result.bytesRead; }
    const after = await input.stat({ bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || !inside(root, await realpath(source))) throw new Error('office_input_changed');
  } finally { await input.close(); }
  directory = await mkdtemp(join(dirname(output), '.qi-office-'));
  await chmod(directory, 0o700);
  const inputPath = join(directory, `source.${extension}`), outputPath = join(directory, 'converted.pdf');
  await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 });
  const require = createRequire(new URL('../../workspace/runtime-inputs.json', import.meta.url));
  const metadata = require('@deepseek-ai/libreoffice-kit/package.json');
  if (metadata.version !== '0.1.5' || metadata.optionalDependencies?.['@deepseek-ai/libreoffice-kit-darwin-arm64'] !== '0.1.5') throw new Error('pinned_native_office_engine_missing');
  require.resolve('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json');
  const { createConverter } = await import(pathToFileURL(require.resolve('@deepseek-ai/libreoffice-kit')).href);
  converter = await createConverter({ timeoutMs: 25000, maxInputBytes: maxInput, maxOutputBytes: maxOutput,
    maxArchiveEntries: 10000, maxUncompressedBytes: 200000000, maxFontFiles: 2000, maxLoadedFontBytes: 64000000 });
  abort.signal.throwIfAborted();
  if (converter.backend !== 'native') throw new Error('native_office_backend_required');
  const result = await converter.render({ inputPath, outputPath }, abort.signal);
  abort.signal.throwIfAborted();
  if (result.backend !== 'native') throw new Error('native_office_result_required');
  const file = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let info;
  try {
    info = await file.stat();
    const signature = Buffer.alloc(5); await file.read(signature, 0, 5, 0);
    if (!info.isFile() || info.size < 5 || info.size > maxOutput || signature.toString() !== '%PDF-') throw new Error('invalid_office_pdf');
    await chmod(outputPath, 0o600);
    abort.signal.throwIfAborted();
    await link(outputPath, output); // exclusive publication; never replace a file
    const published = await lstat(output);
    if (!published.isFile() || published.dev !== info.dev || published.ino !== info.ino) throw new Error('office_output_changed');
  } finally { await file.close(); }
  abort.signal.throwIfAborted();
  process.stdout.write(`${JSON.stringify({ output: relative(root, output), bytes: info.size,
    missingFonts: Array.isArray(result.missingFonts) ? result.missingFonts.slice(0, 200).map(value => String(value).slice(0, 200)) : [] })}\n`);
} catch {
  process.stderr.write('Office conversion failed or outcome is unconfirmed; no automatic retry.\n'); process.exitCode = 1;
} finally {
  try { await converter?.dispose(); } catch { process.exitCode = 1; }
  if (directory) await rm(directory, { recursive: true, force: true });
}
