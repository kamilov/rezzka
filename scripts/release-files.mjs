import {copyFile, lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const publicFiles = new Set([
  'assets/rezzka-logo.svg', 'assets/rezzka-mark.svg',
  'assets/fonts/Manrope.ttf', 'assets/fonts/OFL-Manrope.txt',
  'assets/posters/big-buck-bunny.jpg', 'assets/posters/sintel.jpg',
  'assets/posters/spring.jpg', 'assets/posters/sprite-fright.jpg',
  'assets/posters/tears-of-steel.png', 'assets/posters/credits.json',
  'demo/sample.mp4', 'vendor/webOSTV.js', 'vendor/LICENSE-webOSTV.txt',
  'vendor/LICENSE-Norigin.txt',
]);
const appMetadata = new Set(['appinfo.json', 'icon.png', 'largeIcon.png', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']);
const serviceFiles = new Set(['index.js', 'package.json', 'services.json']);
const bundledAsset = /^assets\/index-[a-zA-Z0-9_-]+\.(?:js|css)$/;
const maximumArchiveSize = 64 * 1024 * 1024;

export function releaseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Release version must be a numeric major.minor.patch in package.json.');
  }
  return value;
}

export function allowedFile(file, kind) {
  if (kind === 'service') return serviceFiles.has(file);
  return file === 'index.html' || publicFiles.has(file) || bundledAsset.test(file) ||
    (kind === 'app' && appMetadata.has(file));
}

export async function listFiles(directory, prefix = '') {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Not a regular directory: ${directory}`);
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const file = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in a release: ${file}`);
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), file + '/'));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unsupported release entry: ${file}`);
  }
  return files.sort();
}

export function stripSourceMapReference(value) {
  return value.replace(/^[\t ]*\/\/[#@] sourceMappingURL=[^\r\n]*(?:\r?\n|$)/gm, '')
    .replace(/\/\*[#@] sourceMappingURL=[^*]*\*\//g, '');
}

// A source map is skipped only if its corresponding allowed JS/CSS file exists.
// Everything else must be explicitly approved instead of silently being copied.
export async function copyReleaseFiles(source, destination, kind) {
  const files = await listFiles(source);
  const names = new Set(files);
  for (const file of files) {
    if (file.endsWith('.map') && /\.(?:js|css)\.map$/.test(file) &&
        names.has(file.slice(0, -4)) && allowedFile(file.slice(0, -4), kind)) continue;
    if (!allowedFile(file, kind)) throw new Error(`Unexpected ${kind} release file: ${file}`);
    const target = join(destination, file);
    await mkdir(dirname(target), {recursive: true});
    if (/\.(?:js|css)$/.test(file)) {
      await writeFile(target, stripSourceMapReference(await readFile(join(source, file), 'utf8')));
    } else await copyFile(join(source, file), target);
  }
}

export async function stageManifest(directory, kind) {
  const result = new Map();
  for (const file of await listFiles(directory)) {
    if (!allowedFile(file, kind)) throw new Error(`Unexpected ${kind} release file: ${file}`);
    result.set(file, sha256(await readFile(join(directory, file))));
  }
  const required = kind === 'app'
    ? ['index.html', ...appMetadata, ...publicFiles]
    : [...serviceFiles];
  for (const file of required) if (!result.has(file)) throw new Error(`Missing ${kind} release file: ${file}`);
  if (kind === 'app' && ![...result.keys()].some(file => /^assets\/index-[a-zA-Z0-9_-]+\.js$/.test(file))) {
    throw new Error('Missing application JavaScript bundle.');
  }
  return result;
}

export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

function readAr(buffer) {
  if (buffer.length > maximumArchiveSize || buffer.subarray(0, 8).toString() !== '!<arch>\n') {
    throw new Error('Invalid IPK archive.');
  }
  const members = new Map();
  let offset = 8;
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + 60);
    if (header.length !== 60 || header.subarray(58).toString() !== '`\n') throw new Error('Invalid IPK member.');
    const name = header.subarray(0, 16).toString().trim().replace(/\/$/, '');
    const sizeText = header.subarray(48, 58).toString().trim();
    if (!/^\d+$/.test(sizeText)) throw new Error('Invalid IPK member size.');
    const size = Number(sizeText);
    if (!['debian-binary', 'control.tar.gz', 'data.tar.gz'].includes(name) || members.has(name) ||
        offset + 60 + size > buffer.length) throw new Error('Unexpected or truncated IPK member.');
    members.set(name, buffer.subarray(offset + 60, offset + 60 + size));
    offset += 60 + size + size % 2;
  }
  if (offset !== buffer.length || members.size !== 3 || members.get('debian-binary')?.toString() !== '2.0\n') {
    throw new Error('Incomplete IPK archive.');
  }
  return members;
}

const tarText = field => field.toString('utf8').replace(/\0.*$/s, '');
function tarNumber(field) {
  const value = tarText(field).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid TAR numeric field.');
  return Number.parseInt(value, 8);
}

// Only regular files and directories are valid in our own generated package.
// No extraction occurs: symlinks, PAX overrides and traversal paths fail closed.
function readTar(compressed) {
  const buffer = gunzipSync(compressed, {maxOutputLength: maximumArchiveSize * 2});
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (buffer.length - offset < 1024 || !buffer.subarray(offset).every(byte => byte === 0)) break;
      return entries;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== tarNumber(header.subarray(148, 156))) throw new Error('Invalid TAR checksum.');
    const prefix = tarText(header.subarray(345, 500));
    let name = (prefix ? prefix + '/' : '') + tarText(header.subarray(0, 100));
    const type = header[156];
    const directory = type === 53;
    if (name.startsWith('./')) name = name.slice(2);
    if (directory && name.endsWith('/')) name = name.slice(0, -1);
    if (!name || name.startsWith('/') || name.includes('\\') ||
        name.split('/').some(part => !part || part === '.' || part === '..') ||
        /[\x00-\x1f\x7f]/.test(name) || entries.has(name)) throw new Error('Invalid or duplicate TAR path.');
    if (type !== 0 && type !== 48 && !directory) throw new Error('Unsupported TAR entry type.');
    const size = tarNumber(header.subarray(124, 136));
    if ((directory && size !== 0) || offset + 512 + size > buffer.length) throw new Error('Truncated TAR member.');
    entries.set(name, {directory, data: buffer.subarray(offset + 512, offset + 512 + size)});
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Incomplete TAR archive.');
}

export function verifyIpk(buffer, {appId, serviceId, version, appFiles, serviceFiles: serviceManifest}) {
  const members = readAr(buffer);
  const controls = readTar(members.get('control.tar.gz'));
  if (controls.size !== 1 || controls.get('control')?.directory !== false) throw new Error('Unexpected package control files.');
  const control = controls.get('control').data.toString();
  if (!control.split('\n').includes(`Package: ${appId}`) || !control.split('\n').includes(`Version: ${version}`)) {
    throw new Error('Package control metadata does not match the release.');
  }
  const entries = readTar(members.get('data.tar.gz'));
  const expected = new Map();
  for (const [file, hash] of appFiles) expected.set(`usr/palm/applications/${appId}/${file}`, hash);
  for (const [file, hash] of serviceManifest) expected.set(`usr/palm/services/${serviceId}/${file}`, hash);
  const packagePath = `usr/palm/packages/${appId}/packageinfo.json`;
  expected.set(packagePath, null);
  const directories = new Set();
  for (const file of expected.keys()) {
    const parts = file.split('/');
    while (parts.pop(), parts.length) directories.add(parts.join('/'));
  }
  for (const [file, entry] of entries) {
    if (entry.directory) {
      if (!directories.has(file)) throw new Error(`Unexpected package directory: ${file}`);
    } else {
      if (!expected.has(file)) throw new Error(`Unexpected package file: ${file}`);
      const hash = expected.get(file);
      if (hash !== null && hash !== sha256(entry.data)) throw new Error(`Package file changed after staging: ${file}`);
      expected.delete(file);
    }
  }
  if (expected.size) throw new Error(`Missing package file: ${expected.keys().next().value}`);
  const metadata = JSON.parse(entries.get(packagePath).data.toString());
  if (metadata.id !== appId || metadata.version !== version ||
      JSON.stringify(metadata.app) !== JSON.stringify(appId) ||
      JSON.stringify(metadata.services) !== JSON.stringify([serviceId])) throw new Error('Unexpected package metadata.');
  return {files: [...entries.values()].filter(entry => !entry.directory).length, sha256: sha256(buffer)};
}
