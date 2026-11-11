import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {copyReleaseFiles, releaseVersion, sha256, stageManifest, verifyIpk} from '../../scripts/release-files.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'rezzka-package-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('release version must come from a numeric webOS-compatible version', () => {
  assert.equal(releaseVersion('12.3.0'), '12.3.0');
  for (const value of ['1.2.3-beta.1', 'v1.2.3', '01.2.3', '../1.2.3', '', undefined]) {
    assert.throws(() => releaseVersion(value));
  }
});

test('release copy strips maps without modifying the debug build', async t => {
  const root = await temporary(t);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'assets'), {recursive: true});
  const js = 'console.log("fixture");\n//# sourceMappingURL=index-abc123.js.map\n';
  await writeFile(join(source, 'assets/index-abc123.js'), js);
  await writeFile(join(source, 'assets/index-abc123.js.map'), '{}');
  await writeFile(join(source, 'index.html'), '<script src="assets/index-abc123.js"></script>');
  await copyReleaseFiles(source, target, 'frontend');
  assert.equal(await readFile(join(target, 'assets/index-abc123.js'), 'utf8'), 'console.log("fixture");\n');
  await assert.rejects(readFile(join(target, 'assets/index-abc123.js.map')), {code: 'ENOENT'});
  assert.equal(await readFile(join(source, 'assets/index-abc123.js'), 'utf8'), js);
});

test('unknown, private and orphaned map files cannot enter release staging', async t => {
  const root = await temporary(t);
  for (const name of ['source-session.json', 'kinopoisk-key.json', 'private.txt', 'index.js.map']) {
    const source = join(root, name + '-source');
    await mkdir(source);
    await writeFile(join(source, name), 'synthetic fixture');
    await assert.rejects(copyReleaseFiles(source, join(root, 'out'), 'service'), /Unexpected service release file/);
  }
});

test('release copy rejects symlinks, including a symlinked input root', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'private'), 'synthetic fixture');
  await symlink(join(root, 'private'), join(root, 'source/index.js'));
  await assert.rejects(copyReleaseFiles(join(root, 'source'), join(root, 'out'), 'service'), /Symbolic links/);
  await symlink(join(root, 'source'), join(root, 'linked'));
  await assert.rejects(copyReleaseFiles(join(root, 'linked'), join(root, 'out'), 'service'), /Not a regular directory/);
});

test('an incomplete staging directory fails before invoking the packager', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'index.js'), 'module.exports = {};');
  await assert.rejects(stageManifest(root, 'service'), /Missing service release file: package.json/);
});

function tar(entries) {
  const blocks = [];
  for (const [name, text, type = '0'] of entries) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write('ustar\0', 257, 6);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function ar(entries) {
  const blocks = [Buffer.from('!<arch>\n')];
  for (const [name, data] of entries) {
    blocks.push(Buffer.from(name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) +
      '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n'), data);
    if (data.length % 2) blocks.push(Buffer.from('\n'));
  }
  return Buffer.concat(blocks);
}

const appId = 'ru.kamilov.rezzka';
const serviceId = `${appId}.service`;
const appPath = `usr/palm/applications/${appId}/index.html`;
const servicePath = `usr/palm/services/${serviceId}/index.js`;
const packagePath = `usr/palm/packages/${appId}/packageinfo.json`;
const release = {
  appId, serviceId, version: '1.2.3',
  appFiles: new Map([['index.html', sha256('application')]]),
  serviceFiles: new Map([['index.js', sha256('service')]]),
};

function ipk({extra = [], app = 'application', metadata = {}, controlVersion = '1.2.3'} = {}) {
  return ar([
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', tar([['control', `Package: ${appId}\nVersion: ${controlVersion}\n`]])],
    ['data.tar.gz', tar([
      [appPath, app], [servicePath, 'service'],
      [packagePath, JSON.stringify({id: appId, version: '1.2.3', app: appId, services: [serviceId], ...metadata})],
      ...extra,
    ])],
  ]);
}

test('archive verification checks expected contents and computes the downloadable checksum', () => {
  const archive = ipk();
  assert.deepEqual(verifyIpk(archive, release), {files: 3, sha256: sha256(archive)});
});

test('archive verification rejects added private files and changed contents', () => {
  assert.throws(() => verifyIpk(ipk({extra: [[`usr/palm/services/${serviceId}/source-session.json`, '{}']]}), release), /Unexpected package file/);
  assert.throws(() => verifyIpk(ipk({app: 'changed'}), release), /changed after staging/);
});

test('archive verification rejects links, traversal and duplicate entries', () => {
  assert.throws(() => verifyIpk(ipk({extra: [['usr/palm/link', '', '2']]}), release), /Unsupported TAR entry type/);
  assert.throws(() => verifyIpk(ipk({extra: [['../outside', 'bad']]}), release), /Invalid or duplicate TAR path/);
  assert.throws(() => verifyIpk(ipk({extra: [[appPath, 'application']]}), release), /Invalid or duplicate TAR path/);
});

test('archive verification rejects inconsistent version and identity', () => {
  assert.throws(() => verifyIpk(ipk({controlVersion: '1.2.2'}), release), /control metadata/);
  assert.throws(() => verifyIpk(ipk({metadata: {services: ['com.other.service']}}), release), /package metadata/);
});

test('archive verification rejects truncated and unexpected outer members', () => {
  assert.throws(() => verifyIpk(ipk().subarray(0, -100), release), /truncated|Incomplete/);
  const unexpected = ar([['private.txt', Buffer.from('fixture')]]);
  assert.throws(() => verifyIpk(unexpected, release), /Unexpected or truncated IPK member/);
});
