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
    elClass() { return (this.msg['is-mention'] ? ' activity-highlight' : ''); },
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
    openMenu() {
      const menu = document.querySelector('#left-menu');
      menu.classList.add('animate');
      if (menu.classList.contains('open')) {
        menu.classList.remove('open');
      } else {
        menu.classList.add('open');
      }
    },

    // used to combine consecutive entries into collapsed groups
    canMerge(first, second) {
      return false;
    },

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

    setLatestSeen(id) {
      if (this.isSettingLatestSeen) return;
      this.isSettingLatestSeen = true;
      console.log('seeing latest seen to', id);
      return skylink
        .putString('/' + this.path + '/latest-seen', id)
        .then(() => this.isSettingLatestSeen = false);
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

window.appRouter = new VueRouter({
  mode: 'hash',
  routes: [
    { name: 'context', path: '/network/:network/context/:type/:context', component: ViewContext, props: true },
  ],
});
