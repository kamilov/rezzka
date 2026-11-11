import {copyFile, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {generateIcons} from './generate-icons.mjs';
import {generateThirdPartyNotices} from './generate-notices.mjs';
import {copyReleaseFiles, releaseVersion, stageManifest, verifyIpk} from './release-files.mjs';

const version = releaseVersion(JSON.parse(await readFile('package.json', 'utf8')).version);
const app = JSON.parse(await readFile('webos/appinfo.json', 'utf8'));
const service = JSON.parse(await readFile('build/service/package.json', 'utf8'));
if (!/^[a-z][a-z0-9.-]+$/.test(app.id) || service.name !== `${app.id}.service` || service.version !== version) {
  throw new Error('Application/service identity or version differs; run npm run build first.');
}
const staging = 'build/package';
const appDirectory = `${staging}/app`;
const serviceDirectory = `${staging}/service`;
const outputDirectory = `${staging}/output`;
await rm(staging, {recursive: true, force: true});
await mkdir(outputDirectory, {recursive: true});
await copyReleaseFiles('dist', appDirectory, 'frontend');
await copyReleaseFiles('build/service', serviceDirectory, 'service');
await writeFile(`${appDirectory}/appinfo.json`, JSON.stringify({...app, version}, null, 2) + '\n');
await generateIcons(appDirectory);
await generateThirdPartyNotices(appDirectory);
await copyFile('LICENSE', `${appDirectory}/LICENSE`);
const appFiles = await stageManifest(appDirectory, 'app');
const serviceFiles = await stageManifest(serviceDirectory, 'service');
const result = spawnSync(resolve('node_modules/.bin/ares-package'), ['--no-minify', appDirectory, serviceDirectory, '-o', outputDirectory], {stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`ares-package failed (${result.status ?? result.signal}).`);
const filename = `${app.id}_${version}_all.ipk`;
const packagePath = `${outputDirectory}/${filename}`;
const verified = verifyIpk(await readFile(packagePath), {appId: app.id, serviceId: service.name, version, appFiles, serviceFiles});
await mkdir('artifacts', {recursive: true});
// Publish local artifacts only after archive contents have passed validation.
await copyFile(packagePath, `artifacts/${filename}.tmp`);
await rename(`artifacts/${filename}.tmp`, `artifacts/${filename}`);
await writeFile(`artifacts/${filename}.sha256.tmp`, `${verified.sha256}  ${filename}\n`);
await rename(`artifacts/${filename}.sha256.tmp`, `artifacts/${filename}.sha256`);
await copyFile(`${appDirectory}/THIRD_PARTY_NOTICES.txt`, 'artifacts/THIRD_PARTY_NOTICES.txt');
await copyFile(`${appDirectory}/LICENSE`, 'artifacts/LICENSE');
console.log(`Verified ${verified.files} package files. Prepared artifacts/${filename} and its SHA256 checksum.`);
