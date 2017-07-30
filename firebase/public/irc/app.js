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
      var match;
      if (match = this.message.match(/^\/w (#[^ ]+)$/)) {
        return app
          .switchChannel(match[1])
          .then(() => this.message = '');
      }
      if (match = this.message.match(/^\/me (.+)$/)) {
        return skylinkP
          .then(x => x.invoke(this.chanPath + '/send-message/invoke',
                  Skylink.String('message',
                                 "\x01ACTION "+match[1]+"\x01")))
          .then(() => {
            this.message = '';
          });
      }
      if (this.message === '/join') {
        skylinkP
          .then(x => x.invoke(this.chanPath + '/join/invoke'))
          .then(() => {
            this.message = '';
            alert('joined!');
          });
         return
      }

      skylinkP
        .then(x => x.invoke(this.chanPath + '/send-message/invoke',
                Skylink.String('message',
                               this.message)))
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
      name: '',
    };
  },
  created() {
    this.getContext();
    this.timer = setInterval(this.updateLog.bind(this), 2500);
  },
  computed: {
    path() {
      return '/n/irc/n/' + this.$route.params.network + '/n/' + this.$route.params.context;
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
          if (nextId <= 0) {
            nextId = Math.max(-1, latest - 25);
          }

          while (nextId < latest) {
            nextId++;
            var msg = {id: nextId, text: 'loading'};
            this.scrollback.push(msg);
            Promise.all([msg,skylink.loadString(this.path + '/log/' + this.currentDay + '/' + nextId)])
              .then(([msg,x]) => {
                msg.text = x;
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
      .then(() => skylink.enumerate('/n/irc/n', {
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
              .then(x => x.enumerate('/n/irc/n/' + n.Name + '/n', {
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
