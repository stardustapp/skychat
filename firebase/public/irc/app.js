function colorize (text) {
  return text; // TODO: use colorize.js
}


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

const ViewContext = Vue.component('view-context', {
  template: '#view-context',
  data() {
    return {
      currentDay: '',
      scrollback: [{time:new Date(),text:'none yet'}],
      checkpoint: -1,
      isUpdating: false,
      timer: null,
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
      return '/persist/irc/networks/' + this.$route.params.network + '/channels/' + this.$route.params.context;
    },
  },
  watch: {
    path: 'getContext'
  },
  methods: {

    hasUrl(line) {
      return line.includes('https://') || line.includes('http://');
    },
    urlFrom(line) {
      return line.match(/https?:\/\/[^ ]+/)[0];
    },

    getContext() {
      return skylinkP
        .then(x => x.loadString(this.path + '/log/latest'))
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
        .then(x => x.loadString(this.path + '/log/' + this.currentDay + '/latest'))
        .then(latest => {
          var nextId = this.checkpoint;
          if (nextId < 0) {
            nextId = Math.max(-1, latest - 25);
          }

          while (nextId < latest) {
            nextId++;
            var msg = {id: nextId, text: 'loading'};
            this.scrollback.push(msg);
            Promise.all([msg,skylink.enumerate(this.path + '/log/' + this.currentDay + '/' + nextId, {maxDepth: 2})])
              .then(([msg, list]) => {
                var data = {params: []};
                list.forEach(ent => {
                  if (ent.Name.startsWith('params/')) {
                    data.params[(+ent.Name.split('/')[1])-1] = ent.StringValue;
                  } else if (ent.Type === 'String') {
                    data[ent.Name] = ent.StringValue;
                  }
                });

                msg.command = data.command;
                switch (data.command) {
                  case 'PRIVMSG':
                    msg.text = `${data['prefix-name']}: ${colorize(data.params[1])}`;
                    break;
                  case 'NOTICE':
                    msg.text = `[${data['prefix-name']}] ${colorize(data.params[1])}`;
                    break;
                  case 'CTCP':
                    msg.text = `* ${data['prefix-name']} ${data.params[1].slice(7)}`;
                    break;
                  case 'JOIN':
                    msg.text = `* ${data['prefix-name']} joined ${data.params[0]}`;
                    break;
                  default:
                    msg.text = data.command;
                }
              });
          }
          this.checkpoint = nextId;
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
    { name: 'context', path: '/network/:network/context/:context', component: ViewContext },
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
              contexts: [],
            };

            skylinkP
              .then(x => x.enumerate('/persist/irc/networks/' + n.Name + '/channels', {
                includeRoot: false,
                maxDepth: 1,
              }))
              .then(x => {
                obj.contexts = x
                  .map(c => ({
                    prefix: c.Name.match(/^(#*)(.+)/)[1],
                    mainName: c.Name.match(/^(#*)(.+)/)[2],
                    //name: c.StringValue,
                    id: c.Name,//.split('/')[0],
                  }));
              });

            return obj;
          });
      });
  },
  methods: {

  },
});
