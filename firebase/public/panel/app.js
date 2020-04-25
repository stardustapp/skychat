
Vue.component('auth-card', {
  template: '#auth-card',
  data: () => {
    const secretKey = `skychart.${orbiter.launcher.chartName}.secret`;
    return {
      secretKey: secretKey,
      launchSecret: '',
      savedSecret: localStorage[secretKey],
      addingSecret: false,
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
    setSecret(secret) {
      promise
        .then(x => x.putString('/persist/launch-secret', secret))
        .then(() => {
          this.fetchSecret();
          this.addingSecret = false;
        });
    },
    deleteSecret() {
      promise
        .then(x => x.unlink('/persist/launch-secret'))
        .then(() => this.launchSecret = '');
    },
    addSecret() {
      if (orbiter.launcher.chartName === 'demo') {
        alert('pls dont secure demo');
      } else {
        this.addingSecret = true;
        setTimeout(() => {
          this.$refs.secretBox.focus();
        }, 1);
      }
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

Vue.component('notifier-card', {
  template: '#notifier-card',
  data() {
    return {
      qrUrl: '',
    };
  },
  created() {
    promise
      .then(x => x.invoke('/notifier/get-qr-url/invoke'))
      .then(x => this.qrUrl = x.StringValue);
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
      enableNotifs: true,
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
      skylink.get('/config/irc/prefs/enable-notifs')
        .then(x => this.enableNotifs = x.StringValue != 'no');
    },
  },
});

Vue.component('irc-add-net', {
  template: '#irc-add-net',
  methods: {
    add() {
      const net = prompt('Alias name for new network:');
      if (!net) {
        return;
      }
      if (net.match(/\W/)) {
        return alert(`Network name isn't supposed to have spaces. This name is for internal use, URLs and such. Try again`);
      }

      skylink.store('/config/irc/networks/'+encodeURIComponent(net), Skylink.toEntry(net, {
        username: orbiter.launcher.chartName || 'skychat',
        ident: orbiter.launcher.chartName || 'skychat',
        nickname: orbiter.launcher.chartName || 'skychat',
        'full-name': `Skychat user on Stardust`,
        'auto-connect': 'no',
        channels: {},
      }));
    },
  },
});



Vue.component('domain-manage-card', {
  template: '#domain-manage-card',
  props: {
    config: Object,
  },
  computed: {
  },
  methods: {
  },
});

Vue.component('domain-add-card', {
  template: '#domain-add-card',
  methods: {
    add() {
      const domain = prompt('Your new Fully Qualified Domain Name:');
      if (!domain.match(/(?=^.{4,253}$)(^((?!-)[a-zA-Z0-9-]{0,62}[a-zA-Z0-9]\.)+[a-zA-Z]{2,63}$)/)) {
        return;
      }

      console.log('doing the thing', domain);
      skylink.invoke('/domains/register/invoke', Skylink.toEntry('request', {
        domain,
      }));
    },
  },
});
