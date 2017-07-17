const skylink = Skylink.openChart();
//const skylink = chart.getLink();
//const chanLink = .forChart('/tmp/irc-channel');

Vue.component('send-message', {
  template: '#send-message',
  props: {
    channelName: String,
    chanPath: String,
  },
  data() {
    return {
      message: '',
    };
  },
  methods: {
    submit() {
      var match;
      if (match = this.message.match(/^\/w (#[^ ]+)$/)) {
        return app
          .switchChannel(match[1])
          .then(() => this.message = '');
      }
      if (match = this.message.match(/^\/me (.+)$/)) {
        return skylink
          .then(x => x.invoke(this.chanPath + '/send-message/invoke',
                  Skylink.String('message',
                                 "\x01ACTION "+match[1]+"\x01")))
          .then(() => {
            this.message = '';
          });
      }
      if (this.message === '/join') {
        skylink
          .then(x => x.invoke(this.chanPath + '/join/invoke'))
          .then(() => {
            this.message = '';
            alert('joined!');
          });
         return
      }

      skylink
        .then(x => x.invoke(this.chanPath + '/send-message/invoke',
                Skylink.String('message',
                               this.message)))
        .then(() => {
          this.message = '';
        });
    },
  },
});

const ViewChannel = Vue.component('view-channel', {
  template: '#view-channel',
  data() {
    return {
      scrollback: ['none yet'],
      timer: null,
      name: '',
    };
  },
  created() {
    this.getChannel();
    this.timer = setInterval(this.updateLog.bind(this), 2500);
  },
  computed: {
    path() {
      return '/n/' + this.$route.params.channel;
    },
  },
  watch: {
    path: 'getChannel'
  },
  methods: {

    hasUrl(line) {
      return line.includes('https://') || line.includes('http://');
    },
    urlFrom(line) {
      return line.match(/https?:\/\/[^ ]+/)[0];
    },

    getChannel() {
      skylink
        .then(x => x.loadString(this.path + '/chan-name'))
        .then(x => this.name = x);
      this.updateLog();
    },

    updateLog() {
      skylink
        .then(x => x.invoke(this.path + '/get-messages/invoke'))
        .then(x => this.scrollback = x.StringValue.split('\n'))
        .then(() => {
          this.$refs.log.scrollTop = this.$refs.log.scrollHeight;
        });
    },

  },
});

const router = new VueRouter({
  mode: 'hash',
  routes: [
    { name: 'channel', path: '/channels/:channel', component: ViewChannel },
  ],
});

var app = new Vue({
  el: '#app',
  router,
  data: {
    channels: [],
  },
  created() {
    skylink
      .then(x => x.enumerate('/n', {
        includeRoot: false,
        maxDepth: 2,
      }))
      .then(x => {
        this.channels = x
          .filter(c => c.Name.endsWith('/chan-name'))
          .map(c => ({
            prefix: c.StringValue.match(/^(#*)(.+)/)[1],
            mainName: c.StringValue.match(/^(#*)(.+)/)[2],
            name: c.StringValue,
            id: c.Name.split('/')[0],
          }));
      });
  },
  methods: {

  },
});
