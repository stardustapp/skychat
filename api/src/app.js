const {WebServer} = require('./web-server.js');
const {ExportSite} = require('./export-site.js');
const {SessionMgmt} = require('./session-mgmt.js');
const {UserSession} = require('./user-session.js'); // contains the firestore schema

const admin = require('firebase-admin');
const adminCredential = admin.credential.applicationDefault();
admin.initializeApp({
  credential: adminCredential,
  databaseURL: process.env.FIREBASE_DATABASE_URL
    || 'https://stardust-skychat.firebaseio.com',
});

(async () => {

  // check that we have some sort of access
  try {
    await adminCredential.getAccessToken();
  } catch (err) {
    console.error(`FATAL: Failed to find a Google credential for Firebase.`);
    console.error(`For local usage, make sure to set the GOOGLE_APPLICATION_CREDENTIALS environment variable to the location of a .json credential file.`);
    console.error();
    console.error(err.message);
    process.exit(5);
  }

  const sessionColl = admin
    .firestore().collection('sessions');
  const userColl = admin
    .firestore().collection('users');

  // set up state
  const sessionMgmt = new SessionMgmt(sessionColl, snapshot => {
    // TODO: check expiresAt
    return new UserSession(
      snapshot.id,
      snapshot.get('uid'),
      snapshot.get('authority'),
      userColl.doc(snapshot.get('uid')));
  });

  // set up the skylink API
  const publicEnv = new Environment;
  publicEnv.bind('/sessions', sessionMgmt);
  publicEnv.mount('/idtoken-launch', 'function', {
    async invoke(input) {
      const {idToken, appId} = input;
      const token = await admin.auth().verifyIdToken(idToken);
      const sessionId = await sessionMgmt.createSession(token.uid, {
        application: appId,
        authority: 'IdToken',
      });
      return { Type: 'String', StringValue: sessionId };
    }});

  // serve skylink protocol
  const web = new WebServer();
  web.mountApp('/~~export', new ExportSite(publicEnv));

  console.log('App listening on', await web.listen(9231, '0.0.0.0'));

})().then(() => {/*process.exit(0)*/}, err => {
  console.error();
  console.error('!-> Daemon crashed:');
  console.error(err.stack || err);
  process.exit(1);
});
