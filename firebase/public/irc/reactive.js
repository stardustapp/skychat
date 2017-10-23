Vue.component('context-listing', {
  template: '#context-listing',
  props: {
    type: String,
    net: Object,
    ctx: Object,
  },
  computed: {
    name() {
      const fullName = this.ctx._id;
      switch (this.type) {
        case 'channels':
          const [_, prefix, main] = fullName.match(/^([#&]*)?(.+)$/);
          return {prefix, main};
        case 'queries':
          return {prefix: '+', main: fullName};
        case 'server':
          return {prefix: '~', main: fullName};
        default:
          return {prefix: '?', main: fullName};
      }
    },
    ctxClass() {
      const classes = [];
      if (this.ctx['latest-mention'] > this.ctx['latest-seen']) {
        classes.push('unseen-mention');
      }
      if (this.ctx['latest-activity'] > this.ctx['latest-seen']) {
        classes.push('unseen-activity');
      }
      if (this.type == 'channels' && this.ctx['is-joined'] != 'yes') {
        classes.push('inactive-ctx');
      }
      return classes.join(' ');
    },
    routeDef() {
      return {
        name:'context',
        params: {
          network: this.net._id,
          type: this.type,
          context: this.ctx._id,
        }};
    },
  },
  methods: {
    // TODO: the sidebar should handle this itself probably, close-on-navigate
    closeNav(evt) {
      const {classList} = document.querySelector('#left-menu');
      if (classList.contains('open')) {
        classList.add('animate');
        classList.remove('open');
      }
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
    author() { return this.msg.author; },
    authorColor() { return colorForNick(this.msg.author, true); },
    message() { return this.msg.text || this.msg.params[1]; },
    enriched() { return colorize(this.msg.text || this.msg.params[1]); },

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
      const fullPath = `${this.msg['prefix-name']}!${this.msg['prefix-user']}@${this.msg['prefix-host']}`;
      switch (this.msg.command) {
        case 'CTCP':
          return `* ${this.msg['prefix-name']} ${this.msg.params[1].slice(7)}`;
        case 'JOIN':
          return `* ${fullPath} joined`;
        case 'INVITE':
          // TODO: if (this.msg.params[0] === current-nick)
          return `* ${this.msg['prefix-name']} invited ${this.msg.params[0]} to join ${this.msg.params[1]}`;
        case 'PART':
          return `* ${fullPath} left (${this.msg.params[1]})`;
        case 'KICK':
          return `* ${this.msg['prefix-name']} kicked ${this.msg.params[1]} from ${this.msg.params[0]} (${this.msg.params[1]})`;
        case 'QUIT':
          return `* ${fullPath} quit (${this.msg.params[0]})`;
        case 'NICK':
          return `* ${this.msg['prefix-name']} => ${this.msg.params[0]}`;
        case 'TOPIC':
          return `* ${this.msg['prefix-name']} set the topic: ${this.msg.params[1]}`;
        case 'MODE':
          return `* ${this.msg['prefix-name']} set modes: ${this.msg.params[1]}`;
        default:
          return `* ${this.msg.command} ${this.msg.params.join(' - ')}`;
      }
    },

  },
});

const ViewContext = Vue.component('view-context', {
  template: '#view-context',
  props: {
    network: String,
    type: String,
    context: String,
  },
  computed: {
    path() {
      const netPath = `persist/irc/networks/${this.network}`;
      if (this.type === 'server') {
        return netPath;
      }
      return `${netPath}/${this.type}/${this.context}`;
    },
    logPath() {
      if (this.type === 'server') {
        return this.path + '/server-log';
      } else {
        return this.path + '/log';
      }
    },
  },
  methods: {
    componentFor(entry) {
      if (!entry.command) {
        return '';
      }
      if (['PRIVMSG', 'NOTICE', 'LOG'].includes(entry.command)) {
        entry.author = entry.sender || entry['prefix-name'] || 'unknown';
        return 'rich-activity';
      }
      return 'status-activity';
    },

    // sends raw IRC (command & args) to current network
    sendGenericPayload(cmd, args) {
      const sendFunc = '/runtime/apps/irc/namespace/state/networks/' + this.network + '/wire/send/invoke';
      const command = cmd.toUpperCase()
      const params = {};
      args.forEach((arg, idx) => params[''+(idx+1)] = arg);

      console.log('sending to', this.network, '-', command, params);
      return skylink.invoke(sendFunc, Skylink.toEntry('', {command, params}));
    },

    // send simple PRIVMSG with word wrap
    sendPrivateMessage(target, msg) {
      // wrap messages to prevent truncation at 512
      // TODO: smarter message cutting based on measured prefix
      const maxLength = 400 - target.length;
      var msgCount = 0;
      var offset = 0;
      const sendNextChunk = () => {
        var thisChunk = msg.substr(offset, maxLength);
        if (thisChunk.length === 0) return msgCount;
        msgCount++;

        // not the last message? try chopping at a space
        const lastSpace = thisChunk.lastIndexOf(' ');
        if ((offset + thisChunk.length) < msg.length && lastSpace > 0) {
          thisChunk = thisChunk.slice(0, lastSpace);
          offset += thisChunk.length + 1;
        } else {
          offset += thisChunk.length;
        }

        return this
          .sendGenericPayload('PRIVMSG', [target, thisChunk])
          .then(sendNextChunk);
      };
      return sendNextChunk();
    },

    sendMessage(msg, cbs) {
      console.log('send message', msg);

      this.sendPrivateMessage(this.context, msg)
        .then((x) => cbs.accept(), (err) => cbs.reject(err));
    },

    execCommand(cmd, args, cbs) {
      switch (cmd.toLowerCase()) {
        case 'me':
          // TODO: use virtual CTCP command
          this.sendMessage("\x01ACTION " + args.join(' ') + "\x01", cbs);
          break;

        // commands that pass as-is to IRC server
        case 'join':
        case 'whois':
        case 'whowas':
          this.sendGenericPayload(cmd, args)
            .then((x) => cbs.accept(), (err) => cbs.reject(err));
          break;

        case 'msg':
          this.sendPrivateMessage(args[0], args.slice(1).join(' '))
            .then((x) => cbs.accept(), (err) => cbs.reject(err));
          break;

        case 'ctcp':
          var words = args.slice(1);
          words[0] = words[0].toUpperCase();
          var payload = "\x01"+words.join(' ')+"\x01";

          this.sendPrivateMessage(args[0], payload)
            .then((x) => cbs.accept(), (err) => cbs.reject(err));
          break;

        case 'raw':
        case 'quote':
          const trailingIdx = args.findIndex(x => x.startsWith(':'));
          if (trailingIdx != -1) {
            const trailing = args.slice(trailingIdx).join(' ').slice(1);
            args.splice(trailingIdx, args.length-trailingIdx, trailing);
          }

          this.sendGenericPayload(args[0], args.slice(1))
            .then((x) => cbs.accept(), (err) => cbs.reject(err));
          break;

        default:
          alert(`Command /${cmd.toLowerCase()} doesn't exist`);
          cbs.reject();
      }
    },
  },
});
/*
  data() {
    return {
      horizonDay: '',
      currentDay: '',
      logParts: [],
      checkpoint: -1,
      memberList: [],
      topic: '',
      mostRecentMsg: '',

      isAtBottom: true,
      newMessageCount: 0,
    };
  },
  created() {
    this.getContext();
    this.metaTimer = setInterval(this.getChannelMeta.bind(this), 25000);
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 1000);
  },
  destroyed() {
    clearInterval(this.metaTimer);
    clearInterval(this.scrollTimer);
  },
  computed: {
    networkName() {
      return this.$route.params.network;
    },
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
      this.logParts = [];
      this.memberList = [];
      this.topic = '';
      this.newMessageCount = 0;
      this.isAtBottom = true;
      this.lastSeenId = null;
      this.currentDay = '';
      this.horizonDay = '';
      this.mostRecentMsg = '';

      skylinkP.then(() => {
        this.getChannelMeta();

        skylink.loadString(this.logPath + '/horizon')
          .then(x => this.horizonDay = x);
      });
    },

    getChannelMeta() {
      skylink.enumerate(this.path + '/membership', {includeRoot: false})
        .then(x => this.memberList = x.map(y => y.Name));
      skylink.loadString(this.path + '/topic/latest')
        .then(x => this.topic = x);

      skylink.loadString(this.logPath + '/latest')
        .then(x => {
          if (this.currentDay === '') {
            this.currentDay = x;
            this.logParts = [{id: x}];
          } else if (this.currentDay !== x) {
            this.currentDay = x;
            this.logParts.push({id: x});
          }
        });
    },

    loadPreviousPart(part) {
      const earliestPart = this.logParts[0].id;

      if (part != earliestPart) {
        // a newer part asked for older stuff, don't fuck w/ it
        return;
      }

      const prevDay = moment
          .utc(earliestPart, 'YYYY-MM-DD')
          .subtract(1, 'day')
          .format('YYYY-MM-DD');

      if (prevDay >= this.horizonDay) {
        console.log('adding log partition', prevDay);
        this.logParts.unshift({id: prevDay});
      }
    },

    scrollTick() {
      const {log} = this.$refs;
      const bottomTop = log.scrollHeight - log.clientHeight;
      this.isAtBottom = bottomTop <= log.scrollTop;
      if (this.isAtBottom && this.newMessageCount && document.visibilityState === 'visible') {
        log.scrollTop = bottomTop;
        this.newMessageCount = 0;
        this.offerLastSeen(this.mostRecentMsg);
      }
    },
    scrollDown() {
      const {log} = this.$refs;
      log.scrollTop = log.scrollHeight - log.clientHeight;
      this.newMessageCount = 0;
    },
    tickleAutoScroll(msg) {
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

      this.offerLastSeen(msg);
    },

    offerLastSeen(id) {
      this.mostRecentMsg = id;
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
      return skylink.loadString(this.path + '/latest-seen').catch(err => null).then(x => {
        if (!x || isGreater(id, x)) {
          console.log('Marking', id, 'as last seen for', this.name);
          return skylink.putString(this.path + '/latest-seen', id);
        }
      });
    },

  },
});
//*/

Vue.component('send-message', {
  template: '#send-message',
  props: {
    networkName: String,
    channelName: String,
    chanPath: String,
    //members: Array,
  },
  data() {
    return {
      locked: false,
      message: '',
      tabCompl: null,
    };
  },
  methods: {

    onKeyDown(evt) {
      if (this.tabCompl !== null) {
        switch (evt.key) {

          // cycle through options
          case 'Tab':
            evt.preventDefault();
            if (evt.shiftKey) {
              this.tabCompl.currentIdx--;
              if (this.tabCompl.currentIdx < 0) {
                this.tabCompl.currentIdx = this.tabCompl.choices.length - 1;
              }
            } else {
              this.tabCompl.currentIdx++;
              if (this.tabCompl.currentIdx >= this.tabCompl.choices.length) {
                this.tabCompl.currentIdx = 0;
              }
            }

            var choice = this.tabCompl.choices[this.tabCompl.currentIdx];
            if (this.tabCompl.prefix) {
              if (this.tabCompl.suffix) {
                evt.target.value = this.tabCompl.prefix + choice + this.tabCompl.suffix;
                evt.target.setSelectionRange(this.tabCompl.prefix.length, this.tabCompl.prefix.length + choice.length);
              } else {
                evt.target.value = this.tabCompl.prefix + choice + ' ';
                evt.target.setSelectionRange(this.tabCompl.prefix.length, this.tabCompl.prefix.length + choice.length + 1);
              }
            } else {
              if (this.tabCompl.suffix) {
                evt.target.value = choice + ':' + this.tabCompl.suffix;
                evt.target.setSelectionRange(0, choice.length + 1);
              } else {
                evt.target.value = choice + ': ';
                evt.target.setSelectionRange(0, choice.length + 2);
              }
            }
            break;

          case 'Escape':
            evt.preventDefault();
            evt.target.value = this.tabCompl.prefix + this.tabCompl.base + this.tabCompl.suffix;
            var pos = this.tabCompl.prefix.length + this.tabCompl.base.length;
            evt.target.setSelectionRange(pos, pos);
            this.tabCompl = null;
            break;

          case 'Shift':
            // ignore this, it's for reverse tabbing
            break;

          default:
            console.log(evt);
            var choice = this.tabCompl.choices[this.tabCompl.currentIdx];
            var pos = this.tabCompl.prefix.length + choice.length;
            if (!this.tabCompl.prefix) {
              pos++;
            }
            if (!this.tabCompl.suffix) {
              pos++;
            }
            evt.target.setSelectionRange(pos, pos);
            this.message = evt.target.value;
            this.tabCompl = null;
        }

      } else if (evt.key === 'Tab' && !evt.ctrlKey && !evt.altKey && !evt.metaKey && !evt.shiftKey && evt.target.selectionStart === evt.target.selectionEnd && evt.target.value) {
        // start tabcompleting
        const prefixLoc = evt.target.value.lastIndexOf(' ', evt.target.selectionStart-1)+1;
        const suffixLoc = evt.target.value.indexOf(' ', evt.target.selectionStart);
        var tabCompl = {
          prefix: evt.target.value.slice(0, prefixLoc),
          suffix: '',
          base: evt.target.value.slice(prefixLoc),
          currentIdx: 0,
        };
        if (suffixLoc >= 0) {
          tabCompl.suffix = evt.target.value.slice(suffixLoc);
          tabCompl.base = evt.target.value.slice(prefixLoc, suffixLoc);
        }

        tabCompl.choices = this.members.filter(
          m => m.toLowerCase().startsWith(tabCompl.base.toLowerCase()));

        if (tabCompl.choices.length) {
          console.log('tab compl started:', prefixLoc, suffixLoc, tabCompl);
          this.tabCompl = tabCompl;

          var choice = tabCompl.choices[tabCompl.currentIdx];
          if (this.tabCompl.prefix) {
            if (this.tabCompl.suffix) {
              evt.target.value = this.tabCompl.prefix + choice + this.tabCompl.suffix;
              evt.target.setSelectionRange(this.tabCompl.prefix.length, this.tabCompl.prefix.length + choice.length);
            } else {
              evt.target.value = this.tabCompl.prefix + choice + ' ';
              evt.target.setSelectionRange(this.tabCompl.prefix.length, this.tabCompl.prefix.length + choice.length + 1);
            }
          } else {
            if (this.tabCompl.suffix) {
              evt.target.value = choice + ':' + this.tabCompl.suffix;
              evt.target.setSelectionRange(0, choice.length + 1);
            } else {
              evt.target.value = choice + ': ';
              evt.target.setSelectionRange(0, choice.length + 2);
            }
          }


        } else {
          console.log('no tabcompl choices found');
        }
        evt.preventDefault();
      }
    },

    submit() {
      if (this.locked) return;
      this.locked = true;

      const input = this.message;
      this.message = '';

      const cbs = {
        accept: () => {
          this.locked = false;
        },
        reject: () => {
          this.message = input;
          this.locked = false;
        },
      };

      if (input[0] == '/') {
        var cmd = input.slice(1);
        var args = [];
        const argIdx = cmd.indexOf(' ');
        if (argIdx != -1) {
          args = cmd.slice(argIdx+1).split(' '); // TODO: better story here
          cmd = cmd.slice(0, argIdx);
        }
        this.$emit('command', cmd, args, cbs);
      } else {
        this.$emit('message', input, cbs);
      }
    },
  },
});

/*
Vue.component('log-partition', {
  template: '#log-partition',
  props: {
    partId: String,
    path: String,
    isLive: Boolean,
  },
  data() {
    return {
      entries: [],
      oldestId: 0,
      checkpoint: -1,
      isUpdating: false,
      timer: null,
      currentAuthor: null,
    };
  },
  created() {
    this.updateLog();
    if (this.isLive) {
      console.log('Registering poll on', this.partId);
      this.timer = setInterval(this.updateLog.bind(this), 2500);
    }
  },
  destroyed() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  },
  /*computed: {
    path() {
      return '/persist/irc/networks/' + this.$route.params.network + '/' + this.$route.params.type + '/' + this.$route.params.context;
    },
  },
  watch: {
    isLive: 'manageLiveTimer'
  },*//*
  methods: {

    updateLog() {
      if (this.isUpdating) return;
      this.isUpdating = true;

      return skylinkP
        .then(x => x.loadString(this.path + '/latest'))
        .then(latest => {
          var nextId = this.checkpoint;
          if (nextId < 0) {
            nextId = Math.max(-1, latest - 25);
            this.oldestId = nextId + 1;
            if (this.oldestId == 0) {
              this.$emit('reachedHorizon', this.partId);
            }
          }

          if (latest === '') {
            // the log doesn't exist, skip it
            this.$emit('reachedHorizon', this.partId);
            return;
          }

          while (nextId < latest) {
            nextId++;
            var msg = {
              id: this.partId + '/' + nextId,
              params: [],
            };
            Promise.all([msg, skylink.enumerate(this.path + '/' + nextId, {maxDepth: 2})])
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

                  msg.author = msg.sender || msg['prefix-name'];
                  msg.newAuthor = (this.currentAuthor !== msg.author);
                  this.currentAuthor = msg.author;
                } else {
                  msg.component = 'status-activity';
                  this.currentAuthor = null;
                }

                this.entries.push(msg);
                if (this.isLive) {
                  this.$emit('newMessage', msg.id);
                }
              });
          }
          this.checkpoint = nextId;

          //if (this.isAtBottom) {
          //  this.offerLastSeen(this.currentDay + '/' + nextId);
          //}
        })
        .then(() => {
          this.isUpdating = false;
        }, () => {
          this.isUpdating = false;
        });
    },

    loadOlder() {
      var msgCount = 0;
      while (this.oldestId > 0 && msgCount < 20) {
        this.oldestId--;
        msgCount++;

        var msg = {
          id: this.partId + '/' + this.oldestId,
          params: [],
        };
        Promise.all([msg, skylink.enumerate(this.path + '/' + this.oldestId, {maxDepth: 2})])
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

            const prevAuthor = this.entries[0].author;
            msg.author = msg.sender || msg['prefix-name'];
            msg.newAuthor = true;
            if (prevAuthor === msg.author) {
              this.entries[0].newAuthor = false;
            }
          } else {
            msg.component = 'status-activity';
          }

          this.entries.unshift(msg);
          // TODO: keep the user's scroll position (measure scroll-height difference)
        });
      }

      if (this.oldestId == 0) {
        this.$emit('reachedHorizon', this.partId);
      }

      //if (this.isAtBottom) {
      //  this.offerLastSeen(this.currentDay + '/' + nextId);
      //}
    },

  },
});

const paneWidth = 250;
var currentPan, mc, nav, wasOpen;

var app = new Vue({
  el: '#app',
  router,
  data: {
    networks: [],
  },

  },
  methods: {
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
  *//*
});
*/

window.appRouter = new VueRouter({
  mode: 'hash',
  routes: [
    { name: 'context', path: '/network/:network/context/:type/:context', component: ViewContext, props: true },
  ],
});
