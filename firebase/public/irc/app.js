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

      const message = this.message;
      this.message = '';
      return sendMessage(message)
        .then(() => {}, err => {
          this.message = message;
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
        case 'QUIT':
          return `* ${this.msg['prefix-name']} quit (${this.msg.params[0]})`;
        case 'NICK':
          return `* ${this.msg['prefix-name']} => ${this.msg.params[0]}`;
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
      memberList: [],
      topic: '',

      isAtBottom: true,
      newMessageCount: 0,
    };
  },
  created() {
    this.getContext();
    this.timer = setInterval(this.updateLog.bind(this), 2500);
    this.metaTimer = setInterval(this.getChannelMeta.bind(this), 25000);
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 1000);
  },
  destroyed() {
    clearInterval(this.timer);
    clearInterval(this.metaTimer);
    clearInterval(this.scrollTimer);
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

    openMenu() {
      $('#left-menu').addClass('animate').toggleClass('open');
    },

    getContext() {
      this.scrollback = [];
      this.memberList = [];
      this.topic = '';

      return skylinkP
        .then(x => x.loadString(this.logPath + '/latest'))
        .then(x => {
          this.currentDay = x;
          this.scrollback = [];
          this.checkpoint = -1;
          this.newMessageCount = 0;
          this.isAtBottom = true;
          this.lastSeenId = null;
          this.updateLog();
          this.getChannelMeta();
        });
    },

    getChannelMeta() {
      skylink.enumerate(this.path + '/membership', {includeRoot: false})
        .then(x => this.memberList = x.map(y => y.Name));
      skylink.loadString(this.path + '/topic/latest')
        .then(x => this.topic = x);
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
                this.tickleAutoScroll();
              });
          }
          this.checkpoint = nextId;

          if (this.isAtBottom) {
            this.offerLastSeen(this.currentDay + '/' + nextId);
          }
        })
        .then(() => {
          this.isUpdating = false;
        }, () => {
          this.isUpdating = false;
        });
    },

    scrollTick() {
      const {log} = this.$refs;
      const bottomTop = log.scrollHeight - log.clientHeight;
      this.isAtBottom = bottomTop <= log.scrollTop;
      if (this.isAtBottom && this.newMessageCount && document.visibilityState === 'visible') {
        log.scrollTop = bottomTop;
        this.newMessageCount = 0;
        this.offerLastSeen(this.scrollback.slice(-1)[0].id);
      }
    },
    scrollDown() {
      const {log} = this.$refs;
      log.scrollTop = log.scrollHeight - log.clientHeight;
      this.newMessageCount = 0;
    },
    tickleAutoScroll() {
      // bump how many messages are missed
      const {log} = this.$refs;
      const bottomTop = log.scrollHeight - log.clientHeight;
      if (bottomTop > log.scrollTop) {
        this.newMessageCount++;
        return;
      }

      // schedule one immediate scroll
      if (!this.pendingScroll) {
        this.pendingScroll = true;
        Vue.nextTick(() => {
          this.pendingScroll = false;
          this.scrollDown();
        });
      }
    },

    offerLastSeen(id) {
      if (!document.visibilityState === 'visible') return;

      const isGreater = function (a, b) {
        [aDt, aId] = a.split('/');
        [bDt, bId] = b.split('/');
        if (aDt > bDt) return true;
        if (+aId > +bId) return true;
        return false;
      }

      if (this.lastSeenId && !isGreater(id, this.lastSeenId)) return;
      this.lastSeenId = id;
      return skylink.loadString(this.path + '/latest-seen').then(x => {
        if (!x || isGreater(id, x)) {
          console.log('Marking', id, 'as last seen for', this.name);
          return skylink.putString(this.path + '/latest-seen', id);
        }
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

const paneWidth = 250;
var currentPan, mc, nav, wasOpen;

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

    transitionend(evt) {
      if (evt.pseudoElement === '::after') {
        console.log('done transitioning BG');
        $(evt.target).removeClass('animate');
      } else {
        console.log('done moving menu');
        $(evt.target).css('transition-duration', '');
        $(evt.target).css('transition-delay', '');
      }
    },
    closeNav(evt) {
      var aside = $(evt.target).closest('aside');
      if (aside.hasClass('open')) {
        aside.addClass('animate');
        aside.removeClass('open');
      }
    },
  },




  mounted() {
    nav = $('#left-menu');

    mc = new Hammer.Manager(nav[0], {
      recognizers: [
        [
          Hammer.Pan, {
            direction: Hammer.DIRECTION_HORIZONTAL,
            threshold: 25
          }
        ]
      ]
    });

    currentPan = null;

    wasOpen = false;

    mc.on('panstart', function(evt) {
      currentPan = paneWidth + parseInt(nav.css('left')) - Math.round(evt.center.x);
      nav.removeClass('animate');
      wasOpen = nav.hasClass('open');
      return nav.addClass('moving');
    });

    mc.on('pan', function(evt) {
      var offset;
      if (currentPan != null) {
        offset = Math.round(evt.center.x) + currentPan - paneWidth;
        if (offset > (-paneWidth/2)) {
          nav.addClass('open');
        } else {
          nav.removeClass('open');
        }
        if (offset > 0) {
          offset = Math.round(Math.sqrt(offset) * 2);
        }
        return nav.css('left', offset + 'px');
      }
    });

    mc.on('panend', function(evt) {
      var adjustedOffset, currentX, delayMillis, deltaX, durationMillis, nowOpen, offset, remainingTime, targetX, velocityX, wantedSpeed;
      if (currentPan != null) {
        offset = Math.round(evt.center.x) + currentPan - paneWidth;
        adjustedOffset = offset + Math.round(Math.sqrt(evt.velocityX * 50) * (paneWidth / 10));
        nowOpen = adjustedOffset > (-paneWidth/2);
        targetX = nowOpen ? (nav.addClass('open'), 0) : (nav.removeClass('open'), -paneWidth);
        currentX = parseInt(nav.css('left'));
        deltaX = targetX - currentX;
        if (deltaX === 0) {
          nav.removeClass('moving');
          nav.css('left', '');
          currentPan = null;
          return;
        }
        velocityX = Math.round(evt.velocityX * paneWidth);
        durationMillis = 1000;
        if (Math.abs(velocityX) < 1) {
          if (deltaX > 0 && wasOpen === false && nowOpen === true) {
            wantedSpeed = 2;
          } else if (deltaX < 0 && wasOpen === true && nowOpen === false) {
            wantedSpeed = -2;
          } else {
            console.log('no animation,', velocityX);
            nav.addClass('animate');
            nav.removeClass('moving');
            nav.css('left', '');
            currentPan = null;
            return;
          }
        } else {
          wantedSpeed = velocityX / durationMillis * 6;
          if (Math.abs(wantedSpeed) < 3) {
            wantedSpeed = 3 * (wantedSpeed / Math.abs(wantedSpeed));
          }
        }
        if (deltaX > 0 && wantedSpeed < 0) {
          console.log('speed is not right, not warping time');
        } else if (deltaX < 0 && wantedSpeed > 0) {
          console.log('speed is not left, not warping time');
        } else {
          remainingTime = deltaX / wantedSpeed * 4;
          if (remainingTime > durationMillis / 2) {
            remainingTime = durationMillis / 2;
          }
          delayMillis = durationMillis - remainingTime;
          console.log('going from', currentX, 'to', targetX, 'needs', deltaX, '- at', wantedSpeed, 'speed,', 'skipping', delayMillis, 'millis of', durationMillis, 'leaving', remainingTime, 'millis');
          nav.css('transition-duration', durationMillis + 'ms');
          nav.css('transition-delay', -delayMillis + 'ms');
        }
        nav.addClass('animate');
        nav.removeClass('moving');
        nav.css('left', '');
        return currentPan = null;
      }
    });

    mc.on('pancancel', function(evt) {
      currentPan = null;
      nav.addClass('animate');
      nav.removeClass('moving');
      nav.css('left', '');
      if (wasOpen) {
        return nav.addClass('open');
      } else {
        return nav.removeClass('open');
      }
    });
  },

  /*
  'click aside a': (evt) ->
    aside = $(evt.target).closest 'aside'
    if aside.hasClass 'open'
      aside.addClass 'animate'
      aside.removeClass 'open'
  });
  */
});
