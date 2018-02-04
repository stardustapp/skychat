
Vue.component('auth-card', {
  template: '#auth-card',
  data: () => {
    const secretKey = `skychart.${orbiter.launcher.chartName}.secret`;
    return {
      secretKey: secretKey,
      launchSecret: '',
      savedSecret: localStorage[secretKey],
    };
  },
  created() {
    promise.then(() => this.fetchSecret());
  },
  methods: {
    fetchSecret() {
      skylink.get('/persist/launch-secret')
        .then(x => this.launchSecret = x.StringValue);
    },
    setCookie() {
      localStorage[this.secretKey] = this.launchSecret;
      this.savedSecret = this.launchSecret;
    },
    deleteCookie() {
      delete localStorage[this.secretKey];
      this.savedSecret = null;
    },
  },
});

Vue.component('irc-net-card', {
  template: '#irc-net-card',
  props: {
    config: Object,
  },
  computed: {
    autoConnect() {
      return this.config['auto-connect'] != 'no';
    },
    useTls() {
      return this.config['use-tls'] == 'yes';
    },
  },
});

Vue.component('irc-prefs-card', {
  template: '#irc-prefs-card',
  data: () => {
    return {
      enableNicklist: false,
      layout: 'modern',
    };
  },
  created() {
    promise.then(() => this.fetchPrefs());
  },
  methods: {
    fetchPrefs() {
      skylink.get('/config/irc/prefs/layout')
        .then(x => this.layout = x.StringValue);
      skylink.get('/config/irc/prefs/disable-nicklist')
        .then(x => this.enableNicklist = x.StringValue == 'no');
    },
  },
});