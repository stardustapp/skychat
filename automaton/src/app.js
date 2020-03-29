// const {join} = require('path');

const {WebServer} = require('./web-server.js');
const {ExportSite} = require('./export-site.js');
const {AppRuntime} = require('./app-runtime.js');
const {ApiSession} = require('./api-session.js');

const {ImportedSkylinkDevice} = require('./copied-from-dust-server/skylink-import.js');
const {TemporaryMount} = require('./copied-from-dust-server/tmp.js');
const {FilesystemDevice} = require('./filesystem-import.js');

var parseArgs = require('minimist');
var argv = parseArgs(process.argv, {
  string: ['app'],
});
// console.log({argv});

// @dustjs/standard-machine-rt/src/skylink/client.js wants these
global.fetch = require('node-fetch');
global.WebSocket = require('ws');

(async () => {

  if (typeof argv.app !== 'string') throw new Error(
    `--app= is required`);

  const argKeys = new Set(Object.keys(argv));
  argKeys.delete('_');
  argKeys.delete('app');

  // Pull out arguments that look like paths
  const userMounts = new Array;
  for (const mount of Object.keys(argv)) {
    if (!mount.startsWith('/')) continue;

    const target = argv[mount];
    userMounts.push({mount, target});
    argKeys.delete(mount);
  }

  const extraKeys = Array.from(argKeys);
  if (extraKeys.length) throw new Error(
    `Extra unhandled arguments given: ${extraKeys.join(', ')}`);

  // get a session with the user's auth server
  const apiSession = await ApiSession.findFromEnvironment(process.env);

  console.group(); console.group();

  // set up namespace that the lua has access to
  const userEnv = new Environment('lua-root:');
  for (const {mount, target} of userMounts) {
    switch (true) {

      case target === 'temp://':
        const tmpDevice = new TemporaryMount();
        userEnv.bind(mount, tmpDevice);
        break;

      case target.startsWith('skylink+'):
        const remoteDevice = ImportedSkylinkDevice.fromUri(target);
        await remoteDevice.ready;
        userEnv.bind(mount, remoteDevice);
        break;

      case target.startsWith('file://'):
        const fsDevice = FilesystemDevice.fromUri(target);
        userEnv.bind(mount, fsDevice);
        break;

      case target.startsWith('session://'):
        const subPath = `/${target.slice(10)}`.replace(/\/$/, '');
        const sessDevice = await apiSession.createMountDevice(subPath);
        userEnv.bind(mount, sessDevice);
        break;

      default: throw new Error(
        `Given mount ${mount} specifies unsupported target URI: "${target}"`);
    }
  }

  console.groupEnd(); console.groupEnd();

  // TODO!!!: shut down our process if any remote devices get broken
  // eg websocket disconnected

  // set up the skylink API
  // TODO: this API will eventually be exposed via skylink's "reversal" extension instead of a listener
  const runtime = new AppRuntime(argv.app, userEnv);

  // serve skylink protocol over HTTP
  const web = new WebServer();
  web.mountApp('/~~export', new ExportSite(runtime.env));
  console.log('==> Automaton listening on', await web.listen(9232, '0.0.0.0'));
  console.log();

  await runtime.launch();

})().then(() => {
  console.error();
  console.error('!-> Daemon completed.');
  process.exit(0);
}, err => {
  console.error();
  console.error('!-> Daemon crashed:');
  console.error(err.stack || err);
  process.exit(1);
});
