//var currentNickP = skylinkP.then(
//  x => x.subscribe(this.path+'/latest', {maxDepth: 0})
//      .then(chan => new SingleSubscription(chan));

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
        case 'mentions':
          return {prefix: '@', main: fullName};
        default:
          return {prefix: '?', main: fullName};
      }
    },
    ctxClass() {
      const isGreater = function (a, b) {
        if (!a) return false;
        if (!b) return true;
        [aDt, aId] = a.split('/');
        [bDt, bId] = b.split('/');
        if (aDt > bDt) return true;
        if (aDt < bDt) return false;
        if (+aId > +bId) return true;
        return false;
      }

      const classes = [];
      if (isGreater(this.ctx['latest-mention'], this.ctx['latest-seen'])) {
        classes.push('unseen-mention');
      }
      if (isGreater(this.ctx['latest-activity'], this.ctx['latest-seen'])) {
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
    deleteContext(evt) {
      evt.preventDefault();
      if (confirm(`Deleting ALL HISTORY for ${this.ctx._id} on network ${this.net._id}\n\nPlease confirm deletion of ${this.ctx._id}`)) {
        console.warn('Deleting', this.ctx._path);
        skylink.unlink('/'+this.ctx._path)
          .then(() => alert(`Deleted ${this.ctx._id}!`),
                err => alert(`Couldn't delete ${this.ctx._id} - ${err}`));
      }
    },
  },
});

// Show filler while data is loading
Vue.component('empty-activity', {
  template: '#empty-activity',
  props: {
    msg: Object,
  },
  data() {
    return {
      width: 100 + Math.floor(Math.random() * 300),
    };
  },
});

Vue.component('block-activity', {
  template: '#block-activity',
  props: {
    msg: Object,
  },
  computed: {
    timestamp() { return new Date(this.msg['timestamp']).toTimeString().split(' ')[0]; },
    author() { return this.msg.author; },
    authorColor() { return colorForNick(this.msg.author, true); },
    message() { return this.msg.text },
    enriched() { return colorize(this.message); },
  },
});

const RichActivity = Vue.component('rich-activity', {
  template: '#rich-activity',
  props: {
    msg: Object,
    mention: String,
  },
  computed: {
    newAuthor() { return this.msg.newAuthor; },
    timestamp() { return new Date(this.msg['timestamp']).toTimeString().split(' ')[0]; },
    author() { return this.msg.author; },
    authorColor() { return colorForNick(this.msg.author, true); },
    message() { return this.msg.text || this.msg.params[1]; },
    enriched() { return colorize(this.message); },
    elClass() { return (this.msg['is-mention'] ? ' activity-highlight' : ''); },
  },
});

Vue.component('action-activity', {
  template: '#action-activity',
  props: {
    msg: Object,
  },
  computed: {
    timestamp() { return new Date(this.msg['timestamp']).toTimeString().split(' ')[0]; },
    author() { return this.msg.author; },
    authorColor() { return colorForNick(this.msg.author, true); },
    message() { return this.msg.text || this.msg.params[2] || this.msg.params[1].split(' ').slice(1).join(' '); },
    enriched() { return colorize(this.message); },
    elClass() { return (this.msg['is-mention'] ? ' activity-highlight' : ''); },
  },
});

Vue.component('status-activity', {
  template: '#status-activity',
  props: {
    msg: Object,
    networkName: String,
  },
  computed: {

    isActionable() {
      if (this.msg.command === '710') return 'Send invite for '+this.msg.params[1];
      return false;
    },

    timestamp() {
      return new Date(this.msg['timestamp']).toTimeString().split(' ')[0];
    },
    text() {
      if (!this.msg) return 'loading';
      const nickName = this.msg['prefix-name'];
      const extraPath = `${this.msg['prefix-user']}@${this.msg['prefix-host']}`;

      switch (this.msg.command) {
        case 'CTCP':
          return `${nickName} requested CTCP ${this.msg.params.slice(1).join(' - ')} `;
        case 'JOIN':
          return `${nickName} joined (${extraPath})`;
        case 'INVITE':
          // TODO: if (this.msg.params[0] === current-nick)
          return `${nickName} invited ${this.msg.params[0]} to join ${this.msg.params[1]}`;
        case 'PART':
          return `${nickName} left (${extraPath}) ${this.msg.params[1] || ''}`;
        case 'KICK':
          return `${nickName} kicked ${this.msg.params[1]} from ${this.msg.params[0]} (${this.msg.params[2] || ''})`;
        case 'QUIT':
          return `${nickName} quit (${extraPath}) ${this.msg.params[0] || ''}`;
        case 'NICK':
          return `${nickName} => ${this.msg.params[0]}`;
        case 'TOPIC':
          return `${nickName} set the topic: ${this.msg.params[1]}`;
        case 'MODE':
          return `${nickName} set modes: ${this.msg.params.slice(1).join(' ')}`;

        // Information numerics
        // These always come from the server, so nickName is trash
        case '001':
        case '002':
        case '003':
          return `${this.msg.params[1]}`;
        case '004':
          return `Your server is ${this.msg.params[1]}, running ${this.msg.params[2]}`;
        case '042':
          return `${this.msg.params[2]} is ${this.msg.params[1]}`;
        case '251':
        case '255':
        case '250':
          return `${this.msg.params[1]}`;
        case '265': // current local users
        case '266': // current global users
          return `${this.msg.params.slice(-1)[0]}`;
        case '252':
        case '254':
        case '396':
          return `${this.msg.params[1]} ${this.msg.params[2]}`;
        case '332': // topic - TODO: should be rich/formatted
          return `Topic of ${this.msg.params[1]} is ${this.msg.params[2]}`;
        case '333': // topic author, timestamp
          return `Set ${moment((+this.msg.params[3])*1000).calendar()} by ${this.msg.params[2]}`;
        //case '353': // names list
        case '366': // end of names
          return 'Completed parsing /names response';

        // Error numerics
        case '421': // unknown command
          return `${this.msg.params[2]} ${this.msg.params[1]}`;
        case '462': // you may not reregister
          return `${this.msg.params[1]}`;

        case '341': // INVITE
          return `Successfully invited ${this.msg.params[1]} to join ${this.msg.params[2]}`;
        case '710': // KNOCK
          const [otherNick, ...extra] = this.msg.params[2].split('!');
          return `${otherNick} ${this.msg.params[3]} (${extra.join('!')})`;

        default:
          return `${this.msg.command} ${this.msg.params.join(' - ')}`;
      }
    },

  },
  methods: {
    doAction() {
      console.log('doing', this.msg.command);
      if (this.msg.command === '710') {
        const network = this.networkName;
        const sendFunc = '/runtime/apps/irc/namespace/state/networks/' + network + '/wire/send/invoke';
        const command = 'INVITE';
        const args = [this.msg.params[2].split('!')[0], this.msg.params[1]];
        const params = {};
        args.forEach((arg, idx) => params[''+(idx+1)] = arg);

        console.log('sending to', network, '-', command, params);
        return skylink.invoke(sendFunc, Skylink.toEntry('', {command, params}));
      }
    },
  },
});

Vue.component('mention-activity', {
  template: '#mention-activity',
  props: {
    msg: Object,
  },
  computed: {
    timestamp() {
      return new Date(this.msg['timestamp']).toTimeString().split(' ')[0];
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
      if (this.type === 'server' || this.type === 'mentions') {
        return netPath;
      }
      return `${netPath}/${this.type}/${this.context}`;
    },
    logPath() {
      if (this.type === 'server') {
        return this.path + '/server-log';
      } else if (this.type === 'mentions') {
        return this.path + '/mention-log';
      } else {
        return this.path + '/log';
      }
    },
    layoutClass() {
      return 'layout-' + (app.prefs.layout || 'modern');
    },
    enableNotifs() {
      return app.prefs.enableNotifs != 'no';
    },
    logTypeClass() {
      return 'logtype-' + this.type;
    },
    showNicklist() {
      return this.type == 'channels'
        && app.prefs.disableNicklist == 'no';
    },
  },
  methods: {
    // used to combine consecutive entries into collapsed groups
    canMerge(first, second) {
      return false;
    },

    toggleNicklist() {
      const isHidden = app.prefs.disableNicklist != 'no';
      setPref('disableNicklist', isHidden ? 'no' : 'yes');
    },

    componentFor(entry) {
      if (entry.location) {
        entry.raw.author = entry.sender || entry.raw['prefix-name'] || 'unknown';
        return 'mention-activity';
      }
      if (!entry.command) {
        return 'empty-activity';
      }
      if (['JOIN', 'QUIT'].includes(entry.command) && entry['prefix-name'].startsWith('KiChjang')) {
        return;
      }
      if (entry.command == 'CTCP' && entry.params[1].startsWith('ACTION')) {
        entry.author = entry.sender || entry['prefix-name'] || 'unknown';
        return 'action-activity';
      }
      if (entry.command == 'BLOCK') {
        // multiline monologues from the server
        return 'block-activity';
      }
      if (['PRIVMSG', 'NOTICE', 'LOG'].includes(entry.command)) {
        entry.author = entry.sender || entry['prefix-name'] || 'unknown';
        return 'rich-activity';
      }
      if (['005', '353'].includes(entry.command)) {
        return;
      }
      return 'status-activity';
    },

    joinChan() {
      this.sendGenericPayload('JOIN', [this.context]);
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
        if (thisChunk.length === 0) {
          return Promise.resolve(msgCount);
        }
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
      var promise;
      switch (cmd.toLowerCase()) {

        // a few things are just helpers for talking

        case 'me':
          promise = this.sendGenericPayload("CTCP", [this.context, "ACTION", args.join(' ')]);
          break;
        case 'say':
          promise = this.sendPrivateMessage(this.context, args.join(' '));
          break;
        case 'shrug':
          var shrug = '¯\\_(ツ)_/¯';
          if (args.length) {
            shrug = args.join(' ') + ' ' + shrug;
          }
          promise = this.sendPrivateMessage(this.context, shrug);
          break;
        case 'slap':
          if (args[0]) {
            promise = this.sendGenericPayload("CTCP", [
              this.context, "ACTION",
              `slaps \x0306${args.join(' ')}\x0F around a bit with \x0313a large trout\x0F`]);
          }
          break;
        case 'hi5':
          if (args[0]) {
            promise = this.sendGenericPayload("CTCP", [
              this.context, "ACTION",
              `_o/\\o_ ${args.join(' ')}`]);
          }
          break;

        // commands that pass as-is to IRC server
        case 'whois':
        case 'whowas':
        case 'who':
        case 'links':
        case 'map':
        case 'accept':
        case 'help':
        case 'userhost':
        case 'ison':
        case 'motd':
        case 'time':
        case 'nick':
        case 'mode':
        case 'stats':
        case 'ping':
        // and also some of these i guess
        case 'chanserv':
        case 'nickserv':
        case 'cs':
        case 'ns':
          promise = this.sendGenericPayload(cmd, args);
          break;

        case 'j':
        case 'join':
          promise = this.sendGenericPayload('join', args);
          break;

        case 'p':
        case 'part':
          promise = this
            .sendGenericPayload(cmd, [this.context, args.join(' ') || 'Leaving']);
          break;

        case 'invite':
          promise = this
            .sendGenericPayload(cmd, [args[0], args[1] || this.context]);
          break;

        case 'who':
        case 'topic':
        case 'names':
          promise = this
            .sendGenericPayload(cmd, [args[0] || this.context]);
          break;

        case 'cycle':
          promise = this
            .sendGenericPayload('PART', [this.context, args.join(' ') || 'Cycling'])
            .then(() => this.sendGenericPayload('JOIN', [this.context]));
          break;

        case 'q':
        case 'quit':
          promise = this
            .sendGenericPayload(cmd, [args.join(' ') || 'User quit']);
          break;

        case 'away':
          if (args.length) {
            promise = this.sendGenericPayload(cmd, [args.join(' ')]);
          } else {
            promise = this.sendGenericPayload(cmd, []);
          }
          break;

        case 'msg':
          promise = this
            .sendPrivateMessage(args[0], args.slice(1).join(' '));
          break;

        case 'notice':
          promise = this
            .sendGenericPayload(cmd, [args[0], args.slice(1).join(' ')]);
          break;

        case 'ctcp':
          promise = this
            .sendGenericPayload("CTCP", [args[0], args[1], args.slice(2).join(' ')]);
          break;

        case 'raw':
        case 'quote':
          const trailingIdx = args.findIndex(x => x.startsWith(':'));
          if (trailingIdx != -1) {
            const trailing = args.slice(trailingIdx).join(' ').slice(1);
            args.splice(trailingIdx, args.length-trailingIdx, trailing);
          }

          promise = this
            .sendGenericPayload(args[0], args.slice(1));
          break;

        default:
          alert(`Command /${cmd.toLowerCase()} doesn't exist`);
          cbs.reject();
      }

      if (promise) {
        promise.then((x) => cbs.accept(), (err) => cbs.reject(err))
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
      lineCt: 1,
      tabCompl: null,
      shouldPastebin: false,

      // TODO: history should be in profile instead
      history: JSON.parse(localStorage.messageHistory || '[]'),
      historyIdx: -1,
      partialMsg: null, // keep old message when replacing the input
    };
  },
  methods: {
    updateLineCount() {
      const newLineCt = Math.min(this.message.split('\n').length, 8);
      if (newLineCt > this.lineCt && newLineCt > 3) {
        this.shouldPastebin = true;
      } else if (newLineCt < this.lineCt && newLineCt < 3) {
        this.shouldPastebin = false;
      }
      this.lineCt = newLineCt;
    },

    onKeyUp(evt) {
      this.updateLineCount();

      // Auto-send non-pastebin messages on plain enter
      if (evt.key == 'Enter' && this.autoSending) {
        // block newline
        evt.preventDefault();

        // send the message
        this.autoSending = false;
        this.submit();
      }
    },

    onKeyDown(evt) {
      // Catch send enters, don't type them
      if (evt.key == 'Enter' && !evt.shiftKey && !this.shouldPastebin) {
        this.autoSending = true;
        evt.preventDefault();
        return;
      }

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

      } else {
        // handle some normal-mode keybinds

        if (evt.key === 'ArrowUp' && (this.lineCt == 1 || this.historyIdx != -1)) {
          // up-arrow in single-line msg goes back in time
          if (this.historyIdx+1 < this.history.length) {
            // keep initial partial message
            if (this.historyIdx == -1) {
              this.partialMsg = this.message;
            }

            // increment through history
            this.historyIdx++;
            this.message = evt.target.value = this.history[this.historyIdx];

            evt.target.select();
            this.updateLineCount();
          }
          evt.preventDefault();

        } else if (evt.key === 'ArrowDown' && this.historyIdx != -1) {
          // down-arrow in single-line msg goes forward in time, until now
          // decrement through history
          this.historyIdx--;

          // put back initial partial message
          if (this.historyIdx == -1) {
            this.message = evt.target.value = this.partialMsg;
          } else {
            // or the next message in history
            this.message = evt.target.value = this.history[this.historyIdx];
            evt.target.select();
          }

          this.updateLineCount();
          evt.preventDefault();

        } else if (evt.key === 'Escape' && this.historyIdx != -1) {
          // escape history mode
          this.historyIdx = -1;
          this.message = evt.target.value = this.partialMsg;
          this.partialMsg = null;

          this.updateLineCount();
          evt.preventDefault();
        }
      }
    },

    submit() {
      if (this.locked || !this.message) return;
      this.locked = true;

      const input = this.message;
      this.message = '';

      // update message history
      if (this.historyIdx !== -1 && this.history[this.historyIdx] == input) {
        // resent old message, remove from history
        this.history.splice(this.historyIdx, 1);
      }
      this.history.unshift(input);
      this.historyIdx = -1;

      // save message history to persistant storage
      while (this.history.length > 25) {
        this.history.pop();
      }
      localStorage.messageHistory = JSON.stringify(this.history);

      const cbs = {
        accept: () => {
          this.locked = false;
          this.shouldPastebin = false;
          this.lineCt = 1;
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
        var msg = Promise.resolve(input);

        // pastebin if we want to
        if (this.shouldPastebin) {
          const filename = 'p'+Skylink.randomId()+'.txt';
          const {domainName, chartName} = orbiter.launcher;
          const httpUri = `https://${domainName}/~${chartName}/blobs/pastes/${filename}`;
          msg = skylink
            .mkdirp('/persist/blobs/uploads')
            .then(() => skylink.putFile('/persist/blobs/pastes/'+filename, input))
            .then(() => 'pastebin: '+httpUri);
        }

        msg.then(text => {
          text.split('\n').slice(0, 15).forEach(line => {
            this.$emit('message', line, cbs);
          });
        }, err => {
          alert('msg send failed: '+err);
          console.log('msg send failed:', err);
          cbs.reject();
        });
      }
    },
  },
});

const MissingRouteHandler = Vue.component('missing-route', {
  template: `
<div id="missing-route">
  <h2>
    <sky-menu-toggle ref="menuToggle" />
    <span>Welcome to Skychat!</span>
  </h2>
  <p>Select a channel to get started :)</p>
  <p>Built and hosted by <a href="http://danopia.net" target="_blank">Daniel Lamando</a></p>
  <p class="ps-note">PS: No channels? Your profile might not be provisioned for IRC.</p>
</div>`,
  mounted() {
    const {menuToggle} = this.$refs;
    menuToggle.openMenu();
  },
});

window.appRouter = new VueRouter({
  mode: 'hash',
  routes: [
    { name: 'context', path: '/network/:network/context/:type/:context', component: ViewContext, props: true },
    { name: 'missing-route', path: "*", component: MissingRouteHandler },
  ],
});
