import { Environment, SkylinkClientDevice, SkylinkServer } from '@dustjs/skylink';

import { runMigration } from './migration.js';
import { ApiSession } from './api-session.js';

import parseArgs from 'minimist';
var argv = parseArgs(process.argv, {
  string: ['source', 'network'],
});

(async () => {

  // get a session with the user's auth server
  const apiSession = await ApiSession.findFromEnvironment(process.env);
  console.group(); console.group();

  // set up namespace that the script has access to
  const userEnv = new Environment('migration:');
  await userEnv.bind('/source', SkylinkClientDevice.fromUri(argv.source));
  await userEnv.bind('/dest', await apiSession.createMountDevice());

  // build local skylink 'server' for working with the namespace
  const envServer = new SkylinkServer(userEnv);

  console.groupEnd(); console.groupEnd();
  console.log('==> Starting migration');
  console.log();
  await runMigration(envServer, argv.network);

})().then(() => {
  console.error();
  console.error('!-> Migration completed.');
  process.exit(0);
}, err => {
  console.error();
  console.error('!-> Migration crashed:');
  console.error(err.stack || err);
  process.exit(1);
});
