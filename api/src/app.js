const {WebServer, SkylinkExport} = require('@dustjs/server-koa');
const {
  Environment,
  FunctionDevice,
} = require('@dustjs/skylink');

const {SessionMgmt} = require('./session-mgmt.js');
const {ServiceMgmt} = require('./service-mgmt.js');
const {UserSession} = require('./user-session.js'); // contains the firestore schema

const admin = require('firebase-admin');
const adminCredential = admin.credential.applicationDefault();
admin.initializeApp({
  credential: adminCredential,
  databaseURL: process.env.FIREBASE_DATABASE_URL
    || 'https://stardust-skychat.firebaseio.com',
});

const {Datadog} = require('./copied-from-dust-server/datadog.js');
const {AsyncCache} = require('./copied-from-dust-server/async-cache.js');
Datadog.uidTagCache = new AsyncCache({
  async loadFunc(uid) {
    console.log('loading metrics tags for uid', uid);
    const user = await admin.auth().getUser(uid);
    return {
      user: user.email || user.uid,
    };
  },
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

  const serviceMgmt = new ServiceMgmt(admin.firestore());
  const getUserServices = (uid) => serviceMgmt
    .getServices(userColl
      .doc(uid)
      .collection('services'));

  // set up state
  const sessionMgmt = new SessionMgmt(sessionColl, async snapshot => {
    // TODO: check expiresAt
    return new UserSession(
      snapshot.id,
      snapshot.get('uid'),
      snapshot.get('authority'),
      userColl.doc(snapshot.get('uid')),
      await getUserServices(snapshot.get('uid')));
  });

  // set up the skylink API
  const publicEnv = new Environment;
  publicEnv.bind('/sessions', sessionMgmt);

  // mount the client (thru reversal) as a registered service
  publicEnv.bind('/publish%20service', new FunctionDevice({
    async invoke(input) {
      const sessionId = input.getChild('Session ID', true, 'String').StringValue;
      const serviceId = input.getChild('Service ID', true, 'String').StringValue;
      const deviceRef = input.getChild('Ref', true, 'Device');

      const sessionSnap = await sessionColl.doc(sessionId).get();

      // add the given device to the user's service environment
      const serviceEnv = await getUserServices(sessionSnap.get('uid'));
      await serviceEnv.registerServiceDevice(serviceId, deviceRef);

      return { Type: 'String', StringValue: 'ok' };
    }}));

  // interactive sessions authenticated by Firebase JWTs
  publicEnv.bind('/idtoken-launch', new FunctionDevice({
    async invoke(input) {
      const idToken = input.getChild('ID Token', true, 'String').StringValue;
      const appId = input.getChild('App ID', true, 'String').StringValue;

      const token = await admin.auth().verifyIdToken(idToken);
      const sessionId = await sessionMgmt.createSession(token.uid, {
        application: appId,
        authority: 'IdToken',
      });
      return { Type: 'String', StringValue: sessionId };
    }}));

  // automated sessions authenticated by static randomized string
  publicEnv.bind('/apptoken-launch', new FunctionDevice({
    async invoke(input) {
      const userId = input.getChild('User ID', true, 'String').StringValue;
      const tokenSecret = input.getChild('Token', true, 'String').StringValue;

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
    }}));

  // TODO: push back the expiresAt of a given still-valid session
  // publicEnv.bind('/renew-session', new FunctionDevice({
  //   async invoke(input) {
  //     console.log('TODO: automaton launch w/', input, {userId, tokenId});
  //     return { Type: 'Error', StringValue: 'TODO' };
  //   }}));

  // TODO: issue an AppToken
  // publicEnv.bind('/create-apptoken', new FunctionDevice({
  //   require('crypto').randomBytes(24).toString('base64')

  // set up a web server
  const web = new WebServer();

  // serve skylink protocol
  const allowedOrigins = process.env.SKYLINK_ALLOWED_ORIGINS;
  web.mountApp('/~~export', new SkylinkExport(publicEnv, {
    allowedOrigins: allowedOrigins ? allowedOrigins.split(',') : [],
  }));

  console.log('App listening on', await web.listen(9231, '0.0.0.0'));

})().then(() => {/*process.exit(0)*/}, err => {
  console.error();
  console.error('!-> Daemon crashed:');
  console.error(err.stack || err);
  process.exit(1);
});
