const {WebServer} = require('./web-server.js');
const {ExportSite} = require('./export-site.js');
const {SessionMgmt} = require('./session-mgmt.js');
const {UserSession} = require('./user-session.js'); // contains the firestore schema

const {InflateSkylinkLiteral} = require('@dustjs/standard-machine-rt/src/old/core/api-entries.js');

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

  // interactive sessions authenticated by Firebase JWTs
  publicEnv.mount('/idtoken-launch', 'function', {
    async invoke(input) {
      // TODO: THIS INPUT ISNT VALID SKYLINK! ITS JUST A RAW JSON OBJECT!
      const {idToken, appId} = input;
      const token = await admin.auth().verifyIdToken(idToken);
      const sessionId = await sessionMgmt.createSession(token.uid, {
        application: appId,
        authority: 'IdToken',
      });
      return { Type: 'String', StringValue: sessionId };
    }});

  // automated sessions authenticated by static randomized string
  publicEnv.mount('/apptoken-launch', 'function', {
    async invoke(input) {
      const inputEnt = InflateSkylinkLiteral(input);
      const userId = inputEnt.getChild('User ID', true, 'String').StringValue;
      const tokenSecret = inputEnt.getChild('Token', true, 'String').StringValue;

      // find the token document
      const tokenQuery = await userColl
        .doc(userId)
        .collection('tokens')
        .where('secret', '==', tokenSecret)
        .limit(1)
        .get();
      if (tokenQuery.empty) throw new Error(
        `App Token not found`);
      const tokenSnap = tokenQuery.docs[0];

      // fetch the Firebase user record
      const userRecord = await admin.auth().getUser(userId);
      if (userRecord.disabled) throw new Error(
        `User is disabled; cannot create a session`);
      if (userRecord.tokensValidAfterTime) {
        const validSince = new Date(userRecord.tokensValidAfterTime);
        if (validSince >= tokenSnap.get('issuedAt')) throw new Error(
          `User's tokens are revoked; cannot create a session`);
      }

      // issue a session for the app
      console.log(`Automaton "${tokenSnap.get('name')}" launching for`, userRecord.displayName);
      const sessionId = await sessionMgmt.createSession(userId, {
        authority: 'AppToken',
        application: tokenSnap.get('appId'),
        tokenId: tokenSnap.id,
      });
      await tokenSnap.ref.update({
        launchedAt: new Date,
      });
      return { Type: 'String', StringValue: sessionId };
    }});

  // TODO: push back the expiresAt of a given still-valid session
  // publicEnv.mount('/renew-session', 'function', {
  //   async invoke(input) {
  //     console.log('TODO: automaton launch w/', input, {userId, tokenId});
  //     return { Type: 'Error', StringValue: 'TODO' };
  //   }});

  // TODO: issue an AppToken
  // publicEnv.mount('/create-apptoken', 'function', ...
  //   require('crypto').randomBytes(24).toString('base64')

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
