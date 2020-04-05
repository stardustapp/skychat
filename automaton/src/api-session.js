const {SkylinkClientDevice} = require('@dustjs/skylink');

// async function launchUsingIdToken(apiDevice, idToken) {
//   throw new Error(`TODO`);
// }

async function launchUsingAppToken(apiDevice, userId, tokenSecret) {
  const launchEntry = await apiDevice.getEntry('/apptoken-launch/invoke');
  if (!launchEntry || !launchEntry.invoke) throw new Error(
    `Failed to find /apptoken-launch skylink invokable on API device`);

  try {
    const output = await launchEntry.invoke({ Type: "Folder", Children: [
      { Name: "User ID", Type: "String", StringValue: userId },
      { Name: "Token", Type: "String", StringValue: tokenSecret },
    ]});

    if (output.Type !== 'String') throw new Error(
      `launchUsingAppToken got unknown response type "${output.Type}"`);
    return output.StringValue;

  } catch (err) {
    if (!err.response) throw err;
    const out = err.response.Output;
    if (!out || out.Type !== 'String') throw err;
    throw new Error(`Unable to launch API session, server said: ${out.StringValue}`);
  }
}

class ApiSession {
  constructor(apiDevice, wsOrigin, sessionId) {
    this.apiDevice = apiDevice;
    this.wsOrigin = wsOrigin;
    this.sessionId = sessionId;

    // this.closedDevice = new Promise(resolve => this.markClosedDevice = resolve);
  }

  static async findFromEnvironment(env) {
    // always required, primary server to connect to
    const serverUri = env.AUTOMATON_SERVER_URI;
    // option 1. predefined session to just use as-is
    const sessionId = env.AUTOMATON_SESSION_ID;
    // option 2. credentials to construct ('launch') a new session
    const userId = env.AUTOMATON_USER_ID;
    const tokenSecret = env.AUTOMATON_TOKEN_SECRET;

    if (!serverUri) throw new Error(
      `Export AUTOMATON_SERVER_URI, AUTOMATON_USER_ID, AUTOMATON_TOKEN_SECRET & try again`);
    console.log('    Connecting to API endpoint', serverUri);

    const apiDevice = SkylinkClientDevice.fromUri(serverUri);
    // likely HTTP, so this just performs a ping, not long-running
    await apiDevice.ready;

    // Don't mangle existing sessions, just use as-is
    // TODO: perhaps add option to safely 'adopt' the session by
    //       renewing and revoking it like our own sessions
    if (sessionId) {
      console.log('!-> WARN: Reusing existing session ID from environment variables');
      return new ApiSession(apiDevice, serverUri.replace('+http', '+ws'), sessionId);
    }

    // start a session with the user's auth server
    console.log('--> Redeeming new App session using a Token for user', userId);
    const ourSessionId = await launchUsingAppToken(apiDevice, userId, tokenSecret);

    // TODO: heartbeat the session hourly or daily
    // TODO: destroy session at process teardown

    console.log('    Session established.');
    return new ApiSession(apiDevice, serverUri.replace('+http', '+ws'), ourSessionId);
  }

  async createMountDevice(subPath='') {
    const fullUri = `${this.wsOrigin}/sessions/${this.sessionId}/mnt`;
    const wsDevice = SkylinkClientDevice.fromUri(fullUri);
    await wsDevice.ready;

    wsDevice.closed.then(() => {
      console.error();
      console.error(`WARN: WebSocket device to API server has been disconnected!!`);
      console.error(`TODO: I will shutdown uncleanly and let this be someone else's problem.`);
      process.exit(12);
      // this.markClosedDevice(wsDevice);
    })

    return wsDevice.getSubRoot(subPath);
  }
}

module.exports = {
  ApiSession,
};
