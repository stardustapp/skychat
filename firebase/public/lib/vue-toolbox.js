const EnableNotifications = true;

const IrcBridgeHosts = [
  'example.com',
];

// Represents a mechanism for requesting historical entries
// from a non-sparse array-style log (1, 2, 3...)
// Accepts an array that entries are added into.
// A head entry is added immediately to anchor new log entries.
// No support for unloading entries yet :(
// TODO: rn always starts at latest and heads towards horizon
class LazyBoundSequenceBackLog {
  constructor(partId, path, array, idx, mode) {
    this.id = partId;
    this.path = path;
    this.array = array;
    this.mode = mode;
    this.onNewItem = null;
    console.log('Starting log partition', partId, path, 'mode', mode);

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });
    this.completePromise = new Promise((resolve, reject) => {
      this.completeCbs = {resolve, reject};
    });

    this.header = {
      slot: 'partition-header',
      props: {
        partId: partId,
      },
    };
    if (idx === -1) {
      this.array.push(this.header);
    } else {
      this.array.splice(idx, 0, this.header);
    }
    this.latestItem = this.header;

    this.horizonId = null;
    this.oldestId = null;
    this.latestId = null;
    this.latestIdSub = null;

    var initPromise;

    // Backfill partitions are not expected to get new messages
    // Skip subscribing to latest
    if (this.mode == 'backfill') {
      initPromise = this.initBackfillPart(path);
    } else {
      initPromise = this.initLivePart(path);
    }

    initPromise.catch(err => {
      // log probably doesn't exist (TODO: assert that's why)
      console.warn('log setup error:', err);
      this.oldestId = -1;
      this.latestId = -1;
      this.horizonId = -1;
      this.readyCbs.resolve(-1);
      this.completeCbs.resolve(-1);
    });
  }

  initLivePart(path) {
    const horizonP = skylink
      .loadString('/'+path+'/horizon');
    const latestSubP = skylink
      .subscribe('/'+path+'/latest', {maxDepth: 0})
      .then(chan => new DustClient.SingleSubscription(chan))
      .then(sub => {
        this.latestIdSub = sub;
        return sub.readyPromise;
      });

    return Promise.all([horizonP, latestSubP]).then(([horizon, latest]) => {
      this.horizonId = +horizon;
      this.latestId = +latest.val;
      this.oldestId = +latest.val;
      //console.log(path, '- newest', this.latestId, ', horizon', this.horizonId);

      if (this.readyCbs) {
        this.readyCbs.resolve(this.latestId);
        this.readyCbs = null;
      }

      // Bleeding partitions should start at horizon and backfill in without gaps
      if (this.mode == 'bleeding-edge') {
        this.latestId = this.horizonId-1;
      } else if (this.mode == 'initial') {
        this.latestId--;
      } else {
        // this shouldn't happy, backfill modes hit different init logic
        console.log('log part', this.id, 'is in mode', this.mode, 'and is not streaming');
        return;
      }

      this.latestIdSub.forEach(newLatest => {
        const newLatestId = +newLatest;
        //console.log('Log partition', this.id, 'got new message sequence', newLatestId, '- latest was', this.latestId);

        while (newLatestId > this.latestId) {
          this.latestId++;
          const msg = {
            id: this.latestId,
            fullId: this.id+'/'+this.latestId,
            slot: 'entry',
            props: {},
          };
          const idx = this.array.indexOf(this.latestItem);
          this.array.splice(idx+1, 0, msg);
          this.latestId = this.latestId;
          this.latestItem = msg;
          const promise = this.loadEntry(msg);

          if (this.onNewItem) {
            this.onNewItem(this, this.latestId, promise);
          }
        }
      });
    });
  }

  initBackfillPart(path) {
    const horizonP = skylink
      .loadString('/'+path+'/horizon');
    const latestP = skylink
      .loadString('/'+path+'/latest');

    return Promise.all([horizonP, latestP]).then(([horizon, latest]) => {
      this.horizonId = +horizon;
      this.latestId = +latest;
      this.oldestId = +latest;
      console.log(path, '- newest', this.latestId, ', horizon', this.horizonId);

      if (this.readyCbs) {
        this.readyCbs.resolve(this.latestId);
        this.readyCbs = null;
      }

      // seed in the latest message, so we have something
      console.log('Log partition', this.id, 'seeding with latest message sequence', this.latestId);
      const msg = {
        id: this.latestId,
        fullId: this.id+'/'+this.latestId,
        slot: 'entry',
        props: {},
      };
      const idx = this.array.indexOf(this.latestItem);
      this.array.splice(idx+1, 0, msg);
      this.latestId = this.latestId;
      this.latestItem = msg;
      this.loadEntry(msg);
    });
  }

  stop() {
    if (this.latestIdSub) {
      this.latestIdSub.stop();
    }
  }

  // TODO: IRC SPECIFIC :(
  loadEntry(msg) {
    msg.path = this.path+'/'+msg.id;
    return skylink.enumerate('/'+msg.path, {maxDepth: 3}).then(list => {
      var props = {params: []};
      list.forEach(ent => {
        let name = ent.Name;
        let obj = props;

        if (name === 'raw') {
          props.raw = {};
          return;
        }
        if (name.startsWith('raw/')) {
          obj = props.raw;
          name = name.slice(4);
        }

        if (name === 'params') {
          obj.params = [];
          return;
        }
        if (name.startsWith('params/')) {
          obj.params[(+name.split('/')[1])-1] = ent.StringValue;
        } else if (ent.Type === 'String') {
          obj[name] = ent.StringValue;
        }
      });
      //console.debug(props);

      // Feature to rewrite certain messages in-memory before rendering them
      /*///////////
      if (props.command === 'NOTICE'
          && props['prefix-name'] === 'ircIsDead'
          && IrcBridgeHosts.includes(props['prefix-host'])) {
        props.juneBridged = true;
        const rawText = props['params'][1];
        if (rawText.startsWith('<')) {
          const author = rawText.slice(1, rawText.indexOf('> '));
          props['prefix-name'] = author[0] + author.slice(2); // remove ZWS
          props['params'][1] = rawText.slice(author.length+3);
        } else if (rawText.startsWith('-')) {
          const author = rawText.slice(1, rawText.indexOf('- '));
          props['prefix-name'] = `- ${author[0]}${author.slice(2)} -`; // remove ZWS
          props['params'][1] = rawText.slice(author.length+3);
        } else if (rawText.startsWith('*')) {
          const author = rawText.split(' ')[1];
          props['prefix-name'] = author[0] + author.slice(2); // remove ZWS
          props['params'][1] = rawText.replace(` ${author}`, '');
        }
      }
      //*/

      var mergeKey = false;
      if (['PRIVMSG', 'NOTICE', 'LOG'].includes(props.command) && props['prefix-name']) {
        mergeKey = [props.command, 'nick', props['prefix-name'], new Date(props.timestamp).getHours()].join(':');
      } else if (['JOIN', 'PART', 'QUIT', 'NICK'].includes(props.command)) {
        mergeKey = 'background';
      }
      // TODO: MODE that only affects users might as well get merged too

      //console.debug('got msg', msg.id, '- was', props);
      msg.mergeKey = mergeKey;
      msg.props = props;
      return msg;
    });
  }

  // Insert and load up to [n] older entries
  // Returns the number of entries inserted
  // If ret < n, no further entries will exist.
  request(n) {
    console.log("Log partition", this.id, "was asked to provide", n, "entries");
    let idx = 1 + this.array.indexOf(this.header);
    var i = 0;

    // the first entry comes from the setup
    if (this.oldestId == this.latestId && this.oldestId != -1) {
      i++;
    }

    for (; i < n; i++) {
      if (this.oldestId < 1) {
        console.log('Log partition', this.id, 'ran dry');
        if (this.completeCbs) {
          this.completeCbs.resolve(i);
          this.completeCbs = null;
        }
        return i;
      }

      const id = --this.oldestId;

      const msg = {
        id: id,
        fullId: this.id+'/'+id,
        slot: 'entry',
        mergeKey: false,
        props: {},
      };
      this.array.splice(idx, 0, msg);
      this.loadEntry(msg);
    }

    // made it to the end
    return n;
  }
}

Vue.component('sky-infinite-timeline-log', {
  props: {
    path: String,
    el: String,
    partitions: String,
    latestSeenId: String,
    enableNotifs: Boolean,
  },
  data: () => ({
    horizonPart: null,
    newestPart: null,
    loadedParts: [],
    entries: [], // passed to vue
    nonce: null,
    unseenCount: 0,
    historyDry: false,
    isAtBottom: true,
    historyLoading: true,
  }),
  computed: {
    latestPart() {
      return this.latestPartSub && this.latestPartSub.val;
    },
    latestSeenEnt() {
      return this.entries.find((x) => x.fullId == this.latestSeenId);
    },
  },
  watch: {
    path(path) { this.switchTo(path) },
    latestSeenEnt(newEnt) {
      if (!this.seenDivider) {
        this.seenDivider = {
          id: 'seen-divider',
          slot: 'marker',
          props: {
            text: 'new messages',
          }};
      }

      const curIdx = this.entries.indexOf(this.seenDivider);
      var newIdx = this.entries.indexOf(newEnt);
      console.log('updating seen divider', curIdx, newIdx);
      if (curIdx == newIdx+1) return;

      if (curIdx != -1) {
        this.entries.splice(curIdx, 1);
      }

      newIdx = this.entries.indexOf(newEnt);
      if (newIdx != -1 && newIdx+1 < this.entries.length) {
        this.entries.splice(newIdx+1, 0, this.seenDivider);
      }
    },
  },
  created() {
    promise.then(() => this.switchTo(this.path));
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 1000);

    if (this.enableNotifs && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  },
  destroyed() {
    clearInterval(this.scrollTimer);
    this.loadedParts.forEach(x => x.stop());
    this.latestPartSub.stop();
    if (this.latestNotif) {
      this.latestNotif.close();
    }
  },
  beforeUpdate() {
    //console.log('before update', this.$el.clientHeight, this.$el.scrollHeight);
    this.prevScrollHeight = this.$el.scrollHeight;

    // don't muck with this while loading (for initial load)
    if (!this.historyLoading) {
      const bottomTop = this.$el.scrollHeight - this.$el.clientHeight;
      //console.log('bottomTop', bottomTop, 'scrollTop', this.$el.scrollTop);
      this.isAtBottom = bottomTop <= this.$el.scrollTop + 2; // fudge for tab zoom
      //console.log(bottomTop, this.$el.scrollTop, this.isAtBottom);
    }
  },
  updated() {
    //console.log('updated', this.$el.clientHeight, this.prevScrollHeight, this.$el.scrollHeight);
    const deltaHeight = this.prevScrollHeight - this.$el.scrollHeight;
    if (this.prevScrollHeight != this.$el.scrollHeight) {
      if (this.isAtBottom) {
        //console.log('scrolling down');
        this.$el.scrollTop = this.$el.scrollHeight - this.$el.clientHeight;
        this.unseenCount = 0;
      } else {
        if (Math.abs(deltaHeight) < 25 && this.$el.scrollTop < 3000) {
          //console.log('fudging scrollTop to adjust for message load, delta', deltaHeight);
          this.$el.scrollTop -= deltaHeight;
          // if it's small, just go with it
          // important when loading messages in
        }
        //if (this.newestSeenMsg != this.entries.slice(-1)[0]) {
          //const newMsgs = this.entries.length - this.entries.indexOf(this.newestSeenMsg)
          //this.unseenCount += newMsgs;
        //}
      }
    }
    this.newestSeenMsg = this.entries.slice(-1)[0];
  },
  methods: {
    switchTo(path) {
      // shut down previous subs
      if (this.latestPartSub) {
        this.loadedParts.forEach(x => x.stop());
        this.latestPartSub.stop();
      }

      this.horizonPart = null;
      this.newestPart = null;
      this.latestPartSub = null;
      this.loadedParts = [];
      this.entries = [];
      this.unseenCount = 0;
      this.historyDry = false;
      this.historyLoading = true;
      this.isAtBottom = true;
      const nonce = ++this.nonce;

      if (this.latestNotif) {
        this.latestNotif.close();
        this.latestNotif = null;
      }

      // TODO: fetch subs from cache
      console.log('updating sky-infinite-timeline-log to', path);

      const horizonP = skylink.loadString('/'+path+'/horizon');
      const latestSubP = skylink
        .subscribe('/'+path+'/latest', {maxDepth: 0})
        .then(chan => new DustClient.SingleSubscription(chan));
      Promise.all([horizonP, latestSubP]).then(([horizon, latestSub]) => {
        if (this.nonce !== nonce) {
          console.warn('sky-infinite-timeline-log init on', path, 'became ready, but was cancelled, ignoring');
          return;
        }

        this.horizonPart = horizon;
        this.latestPartSub = latestSub;
        console.log(path, '- newest', this.latestPartSub.api.val, ', horizon', this.horizonPart);

        latestSub.forEach(partId => this.startLivePart(partId));
      });

    },
    // oldest part must be ready. promises to successfully load exactly n older messages.
    requestMessages(n) {
      const part = this.loadedParts[0];
      const m = part.request(n);
      if (m < n) {
        const remainder = n - m;
        console.log('log part only gave', m, 'messages, want', remainder, 'more');

        if (part.id > this.horizonPart) {
          const prevPartId = moment
            .utc(part.id, 'YYYY-MM-DD')
            .subtract(1, 'day')
            .format('YYYY-MM-DD');

          console.log('adding older part', prevPartId);
          const prevPart = new LazyBoundSequenceBackLog(prevPartId, this.path+'/'+prevPartId, this.entries, 0, 'backfill');
          this.loadedParts.unshift(prevPart);

          this.historyLoading = true;
          return prevPart.readyPromise.then(() => {
            console.log('older part', prevPart.id, 'is ready, asking for remainder of', remainder);
            return this.requestMessages(remainder);
          });
        } else {
          this.historyDry = true;
          return Promise.reject(`Entire log ran dry with ${remainder} entries still desired of ${n}`);
        }
      } else {
        console.log('the request of', n, 'entries has been satisfied');
        return Promise.resolve();
      }
    },
    startLivePart(partId) {
      // check if this is a part that just appeared
      var mode = 'initial';
      if (this.newestPart) {
        if (this.newestPart === partId) {
          console.warn('ignoring repeat part announcement', partId);
          return;
        }
        mode = 'bleeding-edge';
      }

      console.log('Starting live partition', partId);
      const part = new LazyBoundSequenceBackLog(partId, this.path+'/'+partId, this.entries, -1, mode);
      this.loadedParts.push(part);
      this.newestPart = partId;

      part.onNewItem = this.handleNewItem.bind(this);

      // If this is the first part, start loading in backlog
      // TODO: something else can probably be requesting backlog
      if (this.loadedParts.length == 1) {
        part.readyPromise.then(() => {
          // requesting is blocking/sync
          console.log('loading initial block of backlog');
          this.requestMessages(20).then(() => this.historyLoading = false);
        });
      }
    },

    scrollTick() {
      // load more, indefinitely
      if (this.$el.scrollTop < 2500 && !(this.historyLoading || this.historyDry)) {
        this.historyLoading = true;
        const {scrollTop, scrollHeight} = this.$el;
        console.log('infinite loader is loading more history');
        this.requestMessages(20).then(() => {
          this.historyLoading = false;
          const heightDiff = this.$el.scrollHeight - scrollHeight;
          //console.log('infinite scroll changed height by', heightDiff, '- scrolltop was', scrollTop, this.$el.scrollTop);
          // scroll if still in loader zone
          if (this.$el.scrollTop < 2500) {
            this.$el.scrollTop = scrollTop + heightDiff;
            //console.log('scroll top is 2 now', this.$el.scrollTop);
            setTimeout(() => {
              this.$el.scrollTop = scrollTop + heightDiff;
              //console.log('scroll top is 3 now', this.$el.scrollTop);
            }, 10);
          }
        });

        // also detect things quickly in case of crossing a partition
        const heightDiff = this.$el.scrollHeight - scrollHeight;
        //console.log('infinite scroll changed height by', heightDiff, '- scrolltop was', scrollTop, this.$el.scrollTop);
        // scroll if still in loader zone
        if (this.$el.scrollTop < 2500) {
          this.$el.scrollTop = scrollTop + heightDiff;
          //console.log('scroll top is 1 now', this.$el.scrollTop);
        }
      }

      const bottomTop = this.$el.scrollHeight - this.$el.clientHeight;
      this.isAtBottom = bottomTop <= this.$el.scrollTop + 2; // fuzz for tab zoom
      if (this.isAtBottom && document.visibilityState === 'visible') {
        this.$el.scrollTop = bottomTop;
        //console.log('at bottom, resetting scrollTop to', bottomTop);
        this.unseenCount = 0;
        this.offerLastSeen(this.entries.slice(-1)[0]);
      }
    },
    scrollDown() {
      console.log('setting scrolltop in scrollDown()');
      this.$el.scrollTop = this.$el.scrollHeight - this.$el.clientHeight;
      this.unseenCount = 0;
    },

    offerLastSeen(ent) {
      if (!ent || !ent.fullId) return;

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

      if (isGreater(ent.fullId, this.latestSeenId)) {
        this.$emit('newLastSeen', ent.fullId);
      }
    },

    canMerge(idx, latter) {
      const former = this.entries[idx];
      if (former && former.mergeKey && latter.mergeKey) {
        return former.mergeKey == latter.mergeKey;
      }
      return false;
    },

    async handleNewItem(part, msgId, promise) {
      if (this.isAtBottom && !document.hidden)
        if (document.hidden === null || !document.hidden)
          return;

      this.unseenCount++;

      if (this.enableNotifs && this.unseenCount && Notification.permission === 'granted') {
        const context = this.path.split('/').slice(3, 6).join(' ');
        this.latestNotif = new Notification(`Activity in ${context}`, {
          //icon: 'http://cdn.sstatic.net/stackexchange/img/logos/so/so-icon.png',
          body: `${this.unseenCount} new message${this.unseenCount == 1 ? '' : 's'}`,
          tag: this.path,
        });
        this.latestNotif.onclick = function () {
          window.focus();
          this.close();
          //window.open("http://stackoverflow.com/a/13328397/1269037");
        };
      }

      const entry = await promise;
      console.log('Got new entry', msgId, entry);
    },

  },
  template: `
  <component :is="el||'div'" ref="log">
    <slot name="header" />
    <slot v-for="(entry, idx) in entries" :name="entry.slot" v-bind="entry.props" :mergeUp="canMerge(idx-1,entry)"></slot>

    <li class="new-unread-below"
        v-if="unseenCount > 0"
        @click="scrollDown">
      {{unseenCount}} new messages below 👇
    </li>
  </component>`,
});

Vue.component('sky-side-menu', {
  props: {
    fixedWidth: Number,
  },
  methods: {
    transitionend(evt) {
      if (evt.pseudoElement === '::after') {
        //console.log('done transitioning BG');
        this.$el.classList.remove('animate');
      } else {
        //console.log('done moving menu');
        this.$el.style.transitionDuration = '';
        this.$el.style.transitionDelay = '';
        this.needsCooldown = false;
      }
    },

    click(evt) {
      if (evt.offsetX <= this.width) return;
      if (!this.$el.classList.contains('open')) return;
      if (this.needsCooldown) return;
      console.log('BG was clicked w/ menu open, closing menu');
      window.evt=evt;

      this.$el.classList.add('animate');
      this.$el.classList.remove('moving');
      this.$el.classList.remove('open');
    },
  },

  mounted() {
    const el = this.$el;
    var currentPan = null;
    var wasOpen = false;
    this.width = this.fixedWidth || 250;
    this.needsCooldown = false;

    var mc = new Hammer.Manager(el, {
      recognizers: [
        [ Hammer.Pan, {
          direction: Hammer.DIRECTION_HORIZONTAL,
          threshold: 25,
        }],
      ],
    });

    mc.on('panstart', (evt) => {
      // shield against buggy scroll-within-sidenav behavior
      // where every other scroll causes erroneous panning
      if (!evt.velocityX) {
        console.log('Sidenav refusing pan start event without X velocity', currentPan);
        return;
      }

      console.log(this.width, el.offsetLeft, Math.round(evt.center.x), this.width + el.offsetLeft - Math.round(evt.center.x));
      currentPan = this.width + el.offsetLeft - Math.round(evt.center.x);
      el.classList.remove('animate');
      wasOpen = el.classList.contains('open');
      el.classList.add('moving');
    });

    mc.on('pan', (evt) => {
      if (currentPan != null) {
        var offset = Math.round(evt.center.x) + currentPan - this.width;
        //console.log('panning', Math.round(evt.center.x), currentPan, this.width, offset);
        if (offset > (-this.width/2)) {
          el.classList.add('open');
        } else {
          el.classList.remove('open');
        }
        if (offset > 0) {
          offset = Math.round(Math.sqrt(offset) * 2);
        }
        return el.style.left = offset + 'px';
      }
    });

    mc.on('panend', (evt) => {
      var adjustedOffset, currentX, delayMillis, deltaX, durationMillis, nowOpen, offset, remainingTime, targetX, velocityX, wantedSpeed;
      if (currentPan != null) {
        offset = Math.round(evt.center.x) + currentPan - this.width;
        adjustedOffset = offset + Math.round(Math.sqrt(evt.velocityX * 50) * (this.width / 10));
        nowOpen = adjustedOffset > (-this.width/2);
        targetX = nowOpen ? (el.classList.add('open'), 0) : (el.classList.remove('open'), -this.width);
        currentX = parseInt(el.style.left||'0');
        deltaX = targetX - currentX;
        if (deltaX === 0) {
          el.classList.remove('moving');
          el.style.left = '';
          currentPan = null;
          return;
        }
        velocityX = Math.round(evt.velocityX * this.width);
        durationMillis = 1000;
        if (Math.abs(velocityX) < 1) {
          if (deltaX > 0 && wasOpen === false && nowOpen === true) {
            wantedSpeed = 2;
          } else if (deltaX < 0 && wasOpen === true && nowOpen === false) {
            wantedSpeed = -2;
          } else {
            console.log('no animation,', velocityX);
            el.classList.add('animate');
            el.classList.remove('moving');
            el.style.left = '';
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
          console.log(deltaX, wantedSpeed);
          console.log('speed is not left, not warping time');
        } else {
          remainingTime = deltaX / wantedSpeed * 4;
          if (remainingTime > durationMillis / 2) {
            remainingTime = durationMillis / 2;
          }
          delayMillis = durationMillis - remainingTime;
          console.log('going from', currentX, 'to', targetX, 'needs', deltaX, '- at', wantedSpeed, 'speed,', 'skipping', delayMillis, 'millis of', durationMillis, 'leaving', remainingTime, 'millis');
          el.style.transitionDuration = durationMillis + 'ms';
          el.style.transitionDelay = -delayMillis + 'ms';
        }
        el.classList.add('animate');
        el.classList.remove('moving');
        el.style.left = '';
        currentPan = null;
        this.needsCooldown = true; // let it finish opening before we make closing easy
      }
    });

    mc.on('pancancel', (evt) => {
      currentPan = null;
      el.classList.add('animate');
      el.classList.remove('moving');
      el.style.left = '';
      if (wasOpen) {
        el.classList.add('open');
      } else {
        el.classList.remove('open');
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
  template: `
  <aside id="left-menu"
      @transitionend="transitionend"
      @click="click">
    <nav id="navbar">
      <slot />
    </nav>
  </aside>`,
});

Vue.component('sky-menu-toggle', {
  methods: {
    openMenu() {
      const menu = document.querySelector('#left-menu');
      if (!menu.classList.contains('open')) {
        menu.classList.add('animate');
        menu.classList.add('open');
      }
    },
    toggleMenu() {
      const menu = document.querySelector('#left-menu');
      menu.classList.add('animate');
      if (menu.classList.contains('open')) {
        menu.classList.remove('open');
      } else {
        menu.classList.add('open');
      }
    },
  },
  template: `
  <a href="#menu" class="menu" @click.prevent="toggleMenu">
    <i class="material-icons">menu</i>
  </a>`,
});
