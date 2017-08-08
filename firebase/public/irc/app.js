const skylinkP = Skylink.openChart();
var skylink;

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

      const sendFunc = '/runtime/apps/irc/namespace/state/networks/freenode/wire/send/invoke';
      const sendMessage = (msg) => {
        return skylink.invoke(sendFunc, Skylink.toEntry('', {
          command: 'PRIVMSG',
          params: {
            '1': this.channelName,
            '2': msg,
          }}));
      };

      var match;
      /*if (match = this.message.match(/^\/w (#[^ ]+)$/)) {
        return app
          .switchChannel(match[1])
          .then(() => this.message = '');
      }*/
      if (match = this.message.match(/^\/me (.+)$/)) {
        return sendMessage("\x01ACTION "+match[1]+"\x01")
          .then(() => {
            this.message = '';
          });
      }
      if (match = this.message.match(/^\/join (.+)$/)) {
        return skylink.invoke(sendFunc, Skylink.toEntry('', {
          command: 'JOIN',
          params: {
            '1': match[1],
          }}));
      }

      return sendMessage(this.message)
        .then(() => {
          this.message = '';
        });
    },
  },
});

Vue.component('rich-activity', {
  template: '#rich-activity',
  props: {
    msg: Object,
  },
  computed: {

    newAuthor() { return this.msg.newAuthor; },
    timestamp() { return new Date(this.msg['timestamp']).toTimeString().split(' ')[0]; },
    author() { return this.msg.sender || this.msg['prefix-name']; },
    authorColor() { return colorForNick(this.author, true); },
    message() { return this.msg.text || this.msg.params[1]; },
    segments() { return colorize(this.msg.text || this.msg.params[1]); },

    hasUrl() {
      if (!this.message) return false;
      return this.message.includes('https://') || this.message.includes('http://');
    },
    urlFrom() {
      if (!this.message) return false;
      return this.message.match(/https?:\/\/[^ ]+/)[0];
    },

  },
});

Vue.component('status-activity', {
  template: '#status-activity',
  props: {
    msg: Object,
  },
  computed: {

    timestamp() {
      return new Date(this.msg['timestamp']).toTimeString().split(' ')[0];
    },
    text() {
      if (!this.msg) return 'loading';
      switch (this.msg.command) {
        case 'CTCP':
          return `* ${this.msg['prefix-name']} ${this.msg.params[1].slice(7)}`;
        case 'JOIN':
          return `* ${this.msg['prefix-name']} joined ${this.msg.params[0]}`;
        case 'PART':
          return `* ${this.msg['prefix-name']} left ${this.msg.params[0]} (${this.msg.params[1]})`;
        default:
          return `* ${this.msg.command} ${this.msg.params.join(' - ')}`;
      }
    },

  },
});

const ViewContext = Vue.component('view-context', {
  template: '#view-context',
  data() {
    return {
      currentDay: '',
      scrollback: [{time:new Date(),text:'none yet'}],
      checkpoint: -1,
      isUpdating: false,
      timer: null,
      currentAuthor: null,
    };
  },
  created() {
    this.getContext();
    this.timer = setInterval(this.updateLog.bind(this), 2500);
  },
  computed: {
    name() {
      return this.$route.params.context;
    },
    path() {
      return '/persist/irc/networks/' + this.$route.params.network + '/' + this.$route.params.type + '/' + this.$route.params.context;
    },
    logPath() {
      if (this.$route.params.type == 'server') {
        return '/persist/irc/networks/' + this.$route.params.network + '/' + this.$route.params.context;
      }
      return this.path + '/log';
    },
  },
  watch: {
    path: 'getContext'
  },
  methods: {

    getContext() {
      return skylinkP
        .then(x => x.loadString(this.logPath + '/latest'))
        .then(x => {
          this.currentDay = x;
          this.scrollback = [];
          this.checkpoint = -1;
          this.updateLog();
        });
    },

    updateLog() {
      if (this.isUpdating) return;
      this.isUpdating = true;

      return skylinkP
        .then(x => x.loadString(this.logPath + '/' + this.currentDay + '/latest'))
        .then(latest => {
          var nextId = this.checkpoint;
          if (nextId < 0) {
            nextId = Math.max(-1, latest - 25);
          }

          while (nextId < latest) {
            nextId++;
            var msg = {
              id: this.currentDay + '/' + nextId,
              params: [],
            };
            Promise.all([msg, skylink.enumerate(this.logPath + '/' + this.currentDay + '/' + nextId, {maxDepth: 2})])
              .then(([msg, list]) => {
                list.forEach(ent => {
                  if (ent.Name.startsWith('params/')) {
                    msg.params[(+ent.Name.split('/')[1])-1] = ent.StringValue;
                  } else if (ent.Type === 'String') {
                    msg[ent.Name] = ent.StringValue;
                  }
                });

                if (['PRIVMSG', 'NOTICE', 'LOG'].includes(msg.command)) {
                  msg.component = 'rich-activity';

                  const thisAuthor = msg.sender || msg['prefix-name'];
                  msg.newAuthor = (this.currentAuthor !== thisAuthor);
                  this.currentAuthor = thisAuthor;
                } else {
                  msg.component = 'status-activity';
                  this.currentAuthor = null;
                }

                this.scrollback.push(msg);
              });
          }
          this.checkpoint = nextId;
          skylink.putString(this.path + '/latest-seen', this.currentDay + '/' + nextId);
        })
        .then(() => {
          this.$refs.log.scrollTop = this.$refs.log.scrollHeight;
          this.isUpdating = false;
        }, () => {
          this.isUpdating = false;
        });
    },

  },
});

const router = new VueRouter({
  mode: 'hash',
  routes: [
    { name: 'context', path: '/network/:network/context/:type/:context', component: ViewContext },
  ],
});

var app = new Vue({
  el: '#app',
  router,
  data: {
    networks: [],
  },
  created() {
    skylinkP
      .then(x => skylink = x)
      .then(() => skylink.enumerate('/persist/irc/networks', {
        includeRoot: false,
        maxDepth: 1,
      }))
      .then(x => {
        this.networks = x
          .map(n => {
            const obj = {
              id: n.Name,
              channels: [],
              queries: [],
            };

            skylinkP
              .then(x => x.enumerate('/persist/irc/networks/' + n.Name + '/channels', {
                includeRoot: false,
                maxDepth: 1,
              }))
              .then(x => {
                obj.channels = x
                  .map(c => ({
                    prefix: c.Name.match(/^(#*)(.+)/)[1],
                    mainName: c.Name.match(/^(#*)(.+)/)[2],
                    type: 'channels',
                    network: n.Name,
                    //name: c.StringValue,
                    id: c.Name,//.split('/')[0],
                    latestActivity: '',
                    latestSeen: '',
                  }));
                this.loadCtxLatest(obj.channels);
              });

            skylinkP
              .then(x => x.enumerate('/persist/irc/networks/' + n.Name + '/queries', {
                includeRoot: false,
                maxDepth: 1,
              }))
              .then(x => {
                obj.queries = x
                  .map(c => ({
                    type: 'queries',
                    network: n.Name,
                    id: c.Name,
                    latestActivity: '',
                    latestSeen: '',
                  }));
                this.loadCtxLatest(obj.queries);
              });

            return obj;
          });
      });

    setInterval(() => {
      this.networks.forEach(n => {
        this.loadCtxLatest(n.channels);
        this.loadCtxLatest(n.queries);
      });
    }, 15 * 1000);
  },
  methods: {
    loadCtxLatest(list) {
      list.forEach(ctx => {
        const {network, type, id} = ctx;
        const ctxRoot = '/persist/irc/networks/' + network + '/' + type + '/' + id;

        skylink.loadString(ctxRoot + '/latest-activity')
          .then(x => ctx.latestActivity = x);
        skylink.loadString(ctxRoot + '/latest-seen')
          .then(x => ctx.latestSeen = x);
      });
    },

    ctxClassFor(ctx) {
      const classes = [];
      if (ctx.latestActivity > ctx.latestSeen) {
        classes.push('unseen-activity');
      }
      return classes.join(' ');
    },
  },
});
