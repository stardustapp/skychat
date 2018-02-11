
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
  methods: {
    addChannel() {
      const channel = prompt('Channel name to autojoin on '+this.config._id+':');
      if (!channel) {
        return;
      }

      const listPath = '/config/irc/networks/'+this.config._id+'/channels';
      skylink.enumerate(listPath).then(list => {
        var nextId = 1;
        list.forEach(ent => {
          if (ent.Type === 'String') {
            var seqId = parseInt(ent.Name) + 1;
            if (seqId > nextId) {
              nextId = seqId;
            }
          }
        });

        return skylink.putString(listPath+'/'+nextId, channel);
      });
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

Vue.component('irc-add-net', {
  template: '#irc-add-net',
  methods: {
    add() {
      const net = prompt('Alias name for new network:');
      if (!net || net.match(/\W/)) {
        return;
      }

      skylink.store('/config/irc/networks/'+net, Skylink.toEntry(net, {
        user: orbiter.launcher.chartName,
        ident: orbiter.launcher.chartName,
        nickname: orbiter.launcher.chartName,
        'full-name': `${orbiter.metadata.ownerName} on Stardust`,
        'auto-connect': 'no',
        channels: {},
      }));
    },
  },
});