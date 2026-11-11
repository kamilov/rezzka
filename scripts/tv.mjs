import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const [action, device, value] = process.argv.slice(2);
const app = 'ru.kamilov.rezzka';
if (!action || !device || !/^[a-zA-Z0-9_-]+$/.test(device)) {
  console.error('Usage: npm run tv -- <install|launch|inspect|inspect-service|simulator> <device-or-simulator-version> [package.ipk]');
  process.exit(1);
}
const commands = {
  install: ['ares-install', '-d', device, ...(value ? [value] : [])],
  launch: ['ares-launch', '-d', device, app],
  inspect: ['ares-inspect', '-d', device, '--app', app],
  'inspect-service': ['ares-inspect', '-d', device, '--service', `${app}.service`],
  simulator: ['ares-launch', '-s', device, resolve('build/package/app')],
};
if (!(action in commands) || (action === 'install' && (!value || !value.endsWith('.ipk')))) {
  console.error('Unknown action or missing package.ipk'); process.exit(1);
}
const [bin, ...args] = commands[action];
const result = spawnSync(resolve('node_modules/.bin', bin), args, {stdio: 'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
