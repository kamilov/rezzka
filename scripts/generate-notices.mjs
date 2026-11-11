import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

// These npm packages omit LICENSE. Preserve the exact upstream text at the
// gitHead recorded by registry.npmjs.org for each installed package version.
const noriginSources = {
  '@noriginmedia/norigin-spatial-navigation@3.4.0': '20a497a96276e579969aa512c2f8d181b468d6f9',
  '@noriginmedia/norigin-spatial-navigation-core@4.2.0': '20a497a96276e579969aa512c2f8d181b468d6f9',
  '@noriginmedia/norigin-spatial-navigation-react@3.3.0': '5483dc21f5f2ebcdaf639c2c6dcef7386709a58d',
};
const noriginLicenseHash = '31f4dfab168c785a249c044da77d7a910fc08467d8d183064acb50a2d5607532';

async function resolvePackage(name, parentManifest) {
  const require = createRequire(parentManifest);
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    entry = require.resolve(name);
  }
  let directory = dirname(entry);
  while (true) {
    const manifestPath = resolve(directory, 'package.json');
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.name === name) return {directory, manifestPath, manifest};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package metadata: ${name}`);
    directory = parent;
  }
}

export async function collectRuntimePackages(root = projectRoot) {
  const manifestPath = resolve(root, 'package.json');
  const manifest = await readJson(manifestPath);
  const packages = new Map();
  async function visit(name, parentManifest) {
    const item = await resolvePackage(name, parentManifest);
    if (packages.has(item.manifestPath)) return;
    packages.set(item.manifestPath, item);
    for (const dependency of Object.keys(item.manifest.dependencies ?? {}).sort()) {
      await visit(dependency, item.manifestPath);
    }
    for (const dependency of Object.keys(item.manifest.optionalDependencies ?? {}).sort()) {
      try { await visit(dependency, item.manifestPath); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
  }
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) await visit(name, manifestPath);
  return [...packages.values()].sort((a, b) =>
    `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`, 'en'));
}

async function packageNotice(item) {
  const {manifest, directory} = item;
  const identity = `${manifest.name}@${manifest.version}`;
  const filenames = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.(?:txt|md))?$/i.test(name)).sort();
  const source = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const header = [identity, `License: ${manifest.license ?? 'not specified'}`, source ? `Source: ${source}` : ''].filter(Boolean).join('\n');
  if (filenames.length) {
    const texts = await Promise.all(filenames.map(async name => `${name}\n${await readFile(resolve(directory, name), 'utf8')}`));
    return `${header}\n\n${texts.join('\n\n')}`;
  }
  const commit = noriginSources[identity];
  if (!commit) throw new Error(`Missing license text for ${identity}; review this dependency before packaging.`);
  const text = (await readFile(resolve(projectRoot, 'public/vendor/LICENSE-Norigin.txt'), 'utf8')).replace(/\r\n/g, '\n');
  if (createHash('sha256').update(text).digest('hex') !== noriginLicenseHash) {
    throw new Error('Norigin license differs from the verified upstream text.');
  }
  return `${header}\nLicense source: https://raw.githubusercontent.com/NoriginMedia/norigin-spatial-navigation/${commit}/LICENSE\n\n${text}`;
}

export async function generateThirdPartyNotices(outputDir) {
  const rootManifest = await readJson(resolve(projectRoot, 'package.json'));
  const packages = await collectRuntimePackages();
  const sections = [
    `${rootManifest.name} ${rootManifest.version} — Third-party notices\n\nThe Rezzka application license is supplied in LICENSE. Third-party components retain their own licenses and notices below.`,
    'Rezzka demo/sample.mp4\n\nSynthetic 12-second 1280×720 H.264 video generated entirely from FFmpeg lavfi color, drawgrid and drawbox primitives. No external images, footage, fonts or audio are used. Generator source: scripts/generate-demo.mjs. Run: node scripts/generate-demo.mjs (requires FFmpeg with libx264 on PATH). The generator and bundled sample are distributed under GPL-3.0-only; see LICENSE.',
  ];
  for (const item of packages) sections.push(await packageNotice(item));

  // Norigin's bundle also includes TypeScript helpers whose notice is not a
  // standalone npm runtime dependency. Copy their embedded notice verbatim.
  const core = packages.find(item => item.manifest.name === '@noriginmedia/norigin-spatial-navigation-core');
  if (core) {
    const bundle = await readFile(resolve(core.directory, 'dist/index.mjs'), 'utf8');
    const notice = bundle.match(/\/\*+\s*Copyright \(c\) Microsoft Corporation\.[\s\S]*?\*\//)?.[0];
    if (!notice) throw new Error('Review the TypeScript helper notice after updating Norigin.');
    sections.push(`TypeScript helpers embedded in ${core.manifest.name}@${core.manifest.version}\n\n${notice}`);
  }

  for (const [title, filename] of [
    ['Manrope font', 'public/assets/fonts/OFL-Manrope.txt'],
    ['LG webOSTV.js 1.2.13', 'public/vendor/LICENSE-webOSTV.txt'],
  ]) {
    sections.push(`${title}\n\n${await readFile(resolve(projectRoot, filename), 'utf8')}`);
  }
  const credits = await readJson(resolve(projectRoot, 'public/assets/posters/credits.json'));
  sections.push(['Demo posters', credits.purpose, credits.note, ...credits.posters.map(poster => [
    `${poster.title} (${poster.year}) — assets/posters/${poster.file}`,
    `Author: ${poster.author}`,
    `Attribution: ${poster.attribution}`,
    `License: ${poster.license} — ${poster.license_url}`,
    `Original source: ${poster.official_source}`,
    `License evidence: ${poster.license_evidence}`,
    `Downloaded from: ${poster.download_url}`,
    `Changes: ${poster.changes}`,
  ].join('\n'))].join('\n\n'));

  const destination = resolve(outputDir);
  await mkdir(destination, {recursive: true});
  const path = resolve(destination, 'THIRD_PARTY_NOTICES.txt');
  await writeFile(path, `${sections.map(text => text.replace(/\r\n/g, '\n').trim()).join('\n\n' + '='.repeat(72) + '\n\n')}\n`);
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateThirdPartyNotices(process.argv[2] ?? resolve(projectRoot, 'build/notices'));
}
