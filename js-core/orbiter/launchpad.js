const domLoaded = new Promise(resolve => {
  document.addEventListener('DOMContentLoaded', resolve);
});

  // // 🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥
  // // The Firebase SDK is initialized and available here!
  //
  // firebase.auth().onAuthStateChanged(user => { });
  // firebase.database().ref('/path/to/ref').on('value', snapshot => { });
  // firebase.messaging().requestPermission().then(() => { });
  // firebase.storage().ref('/path/to/ref').getDownloadURL().then(() => { });
  //
  // // 🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥

  // try {
  //   let app = firebase.app();
  //   let features = ['auth', 'database', 'messaging', 'storage'].filter(feature => typeof app[feature] === 'function');
  //   document.getElementById('load').innerHTML = `Firebase SDK loaded with ${features.join(', ')}`;
  // } catch (e) {

const Launchpad =
class FirebaseLaunchpad {
  constructor(domainName, chartName, appId) {
    this.domainName = domainName;
    // ignore chartName
    this.appId = appId;

    this.status = 'Idle';

    // Autoconfigure skychart endpoint, defaulting to TLS
    // Allow downgrades to insecure where real certs don't go: localhost, LAN, and IPs
    let protocol = 'wss';
    if (this.domainName.match(/^(localhost|[^.]+.(?:lan|local)|(?:\d{1,3}\.)+\d{1,3})(?::(\d+))?$/)) {
      if (location.protocol === 'http:') {
        protocol = 'ws';
      }
      this.domainName = `${this.domainName}:9231`;
    } else {
      this.domainName = `api.${this.domainName}`;
    }
    this.endpoint = `${protocol}://${this.domainName}/~~export/ws`;
    this.skychart = new Skylink('', this.endpoint);

    console.log('Configuring firebase orbiter launchsite for app', appId);
  }

  static forCurrentUserApp() {
    // Discover appId from app's HTML document
    const appIdMeta = document.querySelector('meta[name=x-stardust-appid]');
    if (!(appIdMeta && appIdMeta.content)) {
      throw new Error('add <meta name=x-stardust-appid ...> tag');
    }
    const appId = appIdMeta.content;

    return new FirebaseLaunchpad(localStorage.domainName || location.hostname, null, appId);
  }

  async discover() {
    await domLoaded;
    this.status = 'Waiting for login';
    this.user = await new Promise(resolve => {
      firebase.auth().onAuthStateChanged(user => {
        if (user) resolve(user);
      });
    });
    this.status = 'Located';

    this.metadata = {
      ownerName: this.user.displayName,
      ownerEmail: this.user.email,
      homeDomain: 'localhost',
    };

    return this.metadata;
  }

  async launch() {
    const result = await this.skychart.invoke('/pub/idtoken-launch/invoke',
      Skylink.toEntry('ticket', {
        'ID Token': await this.user.getIdToken(),
        'App ID': this.appId,
      }));

    if (result.Name === 'error') {
      this.status = 'Located';
      return Promise.reject(result.StringValue);
    } else {
      this.skychart.stopTransport();
      this.status = 'Done';
      return '/pub/sessions/' + result.StringValue + '/mnt';
    }
  }
}

// original class for old servers
/*
class Launchpad {
  constructor(domainName, chartName, appId) {
    this.domainName = domainName;
    this.chartName = chartName;
    this.appId = appId;

    this.status = 'Idle';

    // Autoconfigure skychart endpoint, defaulting to TLS
    // Downgrade to insecure where real certs don't go: localhost, LAN, and IPs
    let protocol = 'wss';
    if (this.domainName.match(/^(localhost|[^.]+.(?:lan|local)|(?:\d{1,3}\.)+\d{1,3})(?::(\d+))?$/)) {
      protocol = 'ws';
    }
    this.endpoint = `${protocol}://${this.domainName}/~~export/ws`;

    console.log('Configuring orbiter launchsite for chart', chartName, '- app', appId);
  }

  static forCurrentUserApp() {
    //console.info('Autoconfiguring orbiter for the current context...');

    // Discover appId from app's HTML document
    const appIdMeta = document.querySelector('meta[name=x-stardust-appid]');
    if (!(appIdMeta && appIdMeta.content)) {
      throw new Error('add <meta name=x-stardust-appid ...> tag');
    }
    const appId = appIdMeta.content;

    // Discover chartName from current URL
    if (location.pathname.startsWith('/~~')) {
      throw new Error("Core routes don't have a chart");
    } else if (!location.pathname.startsWith('/~')) {
      throw new Error("Unscoped routes don't have a chart");
    }
    const chartName = location.pathname.split('/')[1].slice(1);

    return new Launchpad(localStorage.domainName || location.hostname, chartName, appId);
  }

  // Discover saved secret from localStorage, if any
  get storedSecret() {
    if (this.providedSecret) {
      return this.providedSecret;
    }
    const secretKey = `skychart.${this.chartName}.secret`;
    if (window.localStorage && window.localStorage[secretKey]) {
      //console.info('Retrieving local secret for', this.chartName);
      return window.localStorage[secretKey];
    }
    //console.log('No known secret stored, returning nil');
    return null; // no secret is known
  }

  // Store the given secret to localStorage, or set falsey to clear
  set storedSecret(secret) {
    console.info('Storing', secret.length, 'character secret for', this.chartName);
    const secretKey = `skychart.${this.chartName}.secret`;
    window.localStorage[secretKey] = secret || '';
  }

  // Connects to a control-plane skylink for chart APIs
  // Returns a metadata object
  // Enables launch() function which, only succeeds once per Launchpad.
  discover() {
    if (this.status != 'Idle') {
      throw new Error(`Launchpad was in status ${this.status}, not ready to discover`);
    }
    this.status = 'Discovering';

    // Start up the bootstrap connection
    this.skychart = new Skylink('', this.endpoint);

    return this.skychart
      .invoke('/pub/open/invoke', Skylink.String('', this.chartName), '/tmp/chart')
      .then(() => {
        this.status = 'Reading';
        const meta = {};
        const p1 = this.skychart
          .loadString('/tmp/chart/owner-name')
          .then(x => meta.ownerName = x);
        const p2 = this.skychart
          .loadString('/tmp/chart/owner-email')
          .then(x => meta.ownerEmail = x);
        const p3 = this.skychart
          .loadString('/tmp/chart/home-domain')
          .then(x => meta.homeDomain = x);
        return Promise.all([p1, p2, p3])
          .then(() => {
            this.metadata = meta;
            this.status = 'Located';
            return meta;
          });
      });
  }

  // Attempt to launch an orbiter
  launch(secretString) {
    if (this.status != 'Located') {
      throw new Error(`Launchpad was in status ${this.status}, not ready to launch`);
    }
    this.status = 'Launching';

    var secret = null;
    if (secretString) {
      secret = Skylink.String('secret', secretString);
    }

    return this.skychart
      .invoke('/tmp/chart/launch/invoke', secret)
      .then(x => {
        if (x.Name === 'error') {
          this.status = 'Located';
          return Promise.reject(x.StringValue);
        } else {
          this.skychart.stopTransport();
          this.status = 'Done';
          return '/pub/sessions/' + x.StringValue + '/mnt';
        }
      });
  }
}
*/

if (typeof module !== "undefined" && module !== null) {
  module.exports = FirebaseLaunchpad;
}
