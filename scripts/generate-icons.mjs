import {mkdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Rasterize the same vector mark that is displayed in the app. No generated
// files are written to webos/ or public/ during a package build.
export async function generateIcons(outputDir) {
  const destination = resolve(outputDir);
  if (destination === resolve(projectRoot, 'webos') || destination === resolve(projectRoot, 'public')) {
    throw new Error('Generated icons must be written to a build directory.');
  }
  const mark = await readFile(resolve(projectRoot, 'public/assets/rezzka-mark.svg'), 'utf8');
  await mkdir(destination, {recursive: true});
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}
    : {});
  try {
    const page = await browser.newPage({viewport: {width: 130, height: 130}, deviceScaleFactor: 1});
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { display: grid; place-items: center; background: #111318; color: #f4f2ee; }
      svg { display: block; width: 76%; height: 76%; }
    </style></head><body>${mark}</body></html>`);
    for (const [name, size] of [['icon.png', 80], ['largeIcon.png', 130]]) {
      await page.setViewportSize({width: size, height: size});
      await page.screenshot({path: resolve(destination, name), animations: 'disabled'});
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateIcons(process.argv[2] ?? resolve(projectRoot, 'build/icons'));
}
