
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

    const horizonP = skylink
      .loadString('/'+path+'/horizon');
    const latestSubP = skylink
      .subscribe('/'+path+'/latest', {maxDepth: 0})
      .then(chan => new SingleSubscription(chan))
      .then(sub => {
        this.latestIdSub = sub;
        return sub.readyPromise;
      });

    Promise.all([horizonP, latestSubP]).then(([horizon, latest]) => {
      this.horizonId = +horizon;
      this.latestId = +latest.val;
      this.oldestId = +latest.val;
      console.log(path, '- newest', this.latestId, ', horizon', this.horizonId);

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
        console.log('log part', this.id, 'is in mode', this.mode, 'and is not streaming');
        return;
      }

      this.latestIdSub.forEach(newLatest => {
        const newLatestId = +newLatest;
        console.log('Log partition', this.id, 'got new message sequence', newLatestId, '- latest was', this.latestId);

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
          this.loadEntry(msg);
        }
      });
    }, (err) => {
      // log probably doesn't exist (TODO: assert that's why)
      this.oldestId = -1;
      this.latestId = -1;
      this.horizonId = -1;
      this.readyCbs.resolve(-1);
      this.completeCbs.resolve(-1);
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
    skylink.enumerate('/'+msg.path, {maxDepth: 2}).then(list => {
      var props = {params: []};
      list.forEach(ent => {
        if (ent.Name.startsWith('params/')) {
          props.params[(+ent.Name.split('/')[1])-1] = ent.StringValue;
        } else if (ent.Type === 'String') {
          props[ent.Name] = ent.StringValue;
        }
      });

      ////////////

      var mergeKey = false;
      if (['PRIVMSG', 'NOTICE', 'LOG'].includes(props.command) && props['prefix-name']) {
        mergeKey = [props.command, 'nick', props['prefix-name']].join(':');
      } else if (['JOIN', 'PART', 'QUIT', 'NICK'].includes(props.command)) {
        mergeKey = 'background';
      }
      // TODO: MODE that only affects users might as well get merged too

      console.log('got msg', msg.id, '- was', props);
      msg.mergeKey = mergeKey;
      msg.props = props;
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
  },
  data: () => ({
    horizonPart: null,
    newestPart: null,
    loadedParts: [],
    entries: [], // passed to vue
    nonce: null,
    unseenCount: 0,
    historyDry: false,
    historyLoading: false,
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
    this.isAtBottom = true;
    promise.then(() => this.switchTo(this.path));
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 500);
  },
  destroyed() {
    clearInterval(this.scrollTimer);
    this.loadedParts.forEach(x => x.stop());
    this.latestPartSub.stop();
  },
  beforeUpdate() {
    //console.log('before update', this.$el.clientHeight, this.$el.scrollHeight);
    this.prevScrollHeight = this.$el.scrollHeight;

    const bottomTop = this.$el.scrollHeight - this.$el.clientHeight;
    this.isAtBottom = bottomTop <= this.$el.scrollTop;
  },
  updated() {
    //console.log('updated', this.$el.clientHeight, this.prevScrollHeight, this.$el.scrollHeight);
    if (this.prevScrollHeight != this.$el.scrollHeight) {
      console.log('messages are bigger now');
      if (this.isAtBottom) {
        this.$el.scrollTop = this.$el.scrollHeight - this.$el.clientHeight;
        this.unseenCount = 0;
      } else if (this.newestSeenMsg != this.entries.slice(-1)[0]) {
        const newMsgs = this.entries.length - this.entries.indexOf(this.newestSeenMsg)
        this.unseenCount += newMsgs;
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
      this.historyLoading = false;
      const nonce = ++this.nonce;

      // TODO: fetch subs from cache
      console.log('updating sky-infinite-timeline-log to', path);

      const horizonP = skylink.loadString('/'+path+'/horizon');
      const latestSubP = skylink
        .subscribe('/'+path+'/latest', {maxDepth: 0})
        .then(chan => new SingleSubscription(chan));
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
        mode = 'bleeding-edge';
      }

      console.log('Starting live partition', partId);
      const part = new LazyBoundSequenceBackLog(partId, this.path+'/'+partId, this.entries, -1, mode);
      this.loadedParts.push(part);
      this.newestPart = partId;

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
      if (this.$el.scrollTop < 100 && !(this.historyLoading || this.historyDry)) {
        this.historyLoading = true;
        console.log('infinite loader is loading more history');
        this.requestMessages(20).then(() => {
          this.historyLoading = false;
          if (this.$el.scrollTop < 100) {
            this.$el.scrollTop = 110;
          }
        });
      }

      const bottomTop = this.$el.scrollHeight - this.$el.clientHeight;
      this.isAtBottom = bottomTop <= this.$el.scrollTop;
      if (this.isAtBottom && document.visibilityState === 'visible') {
        this.$el.scrollTop = bottomTop;
        this.unseenCount = 0;
        this.offerLastSeen(this.entries.slice(-1)[0]);
      }
    },
    scrollDown() {
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

  },
  template: `
  <component :is="el||'div'" ref="log">
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
        console.log('done transitioning BG');
        this.$el.classList.remove('animate');
      } else {
        console.log('done moving menu');
        this.$el.style.transitionDuration = '';
        this.$el.style.transitionDelay = '';
      }
    },

    click(evt) {
      if (evt.offsetX <= this.width) return;
      if (!this.$el.classList.contains('open')) return;
      console.log('BG was clicked w/ menu open, closing menu');

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
        console.log('panning', Math.round(evt.center.x), currentPan, this.width, offset);
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