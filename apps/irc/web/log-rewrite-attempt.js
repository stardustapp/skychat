// Singleton for the whole orbiter.
// Vends cursors into various logs the user wants to look at.
// Holds on to the all the log handles for fast switching.
class Multiplexer {
  constructor(prefix='') {
    this.prefix = prefix;
    this.logs = new Map();
  }

  getLatest(path) {
    var log;
    if (this.logs.has(path)) {
      log = this.logs.get(path);
    } else {
      log = new DailyLog(this.prefix + path);
      this.logs.set(path, log);
    }

    return log.startAtLatest();
  }

  getSeekedLog(path, fullId) {
    throw new Error(`Seek not implemented. ${path} ${fullid}`);
  }
}
const multiplexer = new Multiplexer();

class DailyLog {
  constructor(path) {
    console.log('Starting log driver on', path);
    this.path = path;
    this.parts = new Map();
    this.liveCursors = new Set();

    // always fetch the horizon, since it's static
    // also (for now) always sub the latest
    this.horizonP = skylink
      .loadString(this.path+'/horizon');
    this.latestP = skylink
      .subscribe(this.path+'/latest', {maxDepth: 0})
      .then(chan => new SingleSubscription(chan));

    // live parts need to be un-lived when there's a new one
    this.livePartId = '';
    this.latestP.then(sub => sub.forEach(partId => {
      if (this.livePartId) {
        console.log('cooling live part', this.livePartId,
                    'as', partId, 'is now latest');
        const livePart = this.parts.get(this.livePartId);
        this.livePartId = '';
        livePart.stopLiveStream();
      }

      this.liveCursors.forEach(cursor => {
        cursor.informNewLivePart(partId);
      });
    }));
  }

  getPartition(partId) {
    if (this.parts.has(partId)) {
      return this.parts.get(partId);
    }

    const isLive = partId === this.latestPartApi.val;
    console.log('starting partition', partId, 'ishot', isLive);
    const part = new LogPartition(partId, this.path + '/' + partId, isLive);
    this.parts.set(partId, part);

    if (isLive) {
      this.livePartId = partId;
    }
    return part;
  }

  startAtLatest() {
    const latestSubP = this.latestP.then(x => x.readyPromise);
    return Promise.all([this.horizonP, latestSubP])
      .then(([horizon, latestSub]) => {
        this.horizonPartId = horizon;
        this.latestPartApi = latestSub;

        console.log(this.path,
                    '- newest', latestSub.val,
                    ', horizon', horizon);

        return new DailyLogCursor(this, 'latest');

         //latestSub.forEach(partId => this.startLivePart(partId));
      });
  }

  seekToPastId(fullId) {

  }
}

class DailyLogCursor {
  constructor(log, startingPoint) {
    this.log = log;

    if (startingPoint === 'latest') {
      const latestPart = this.log.getPartition(this.log.latestPartApi.val);
      console.log('starting live cursor at', latestPart);

      latestPart.latestSubP.then(x => x.readyPromise).then(({val}) => {
        console.log('cursor sees latest message as', val);
      });
    } else {
      throw new Error('lol 32535');
    }

  }

  informNewLivePart(partId) {
    // TODO: means we have to start paying attention to a new part
  }
}

class LogPartition {
  constructor(partId, path, isLive) {
    this.partId = partId;
    this.path = path;
    this.isLive = isLive;
    this.entries = new Map();

    this.horizonP = skylink
      .loadString(this.path+'/horizon');

    if (isLive) {
      console.log('Starting live partition driver on', path);
      this.latestSubP = skylink
        .subscribe(this.path+'/latest', {maxDepth: 0})
        .then(chan => new SingleSubscription(chan));
    } else {
      this.latestP = skylink
        .loadString(this.path+'/latest');
    }
  }

  getEntry(index) {
    if (this.entries.has(index)) {
      return this.entries.get(index);
    }

    const entry = {
      id: index,
      fullId: this.partId+'/'+index,
      slot: 'entry',
      props: {},
    };
    const promise = this.loadEntry(entry);

    this.entries.set(index, entry);
    return promise;
  }

  stopLiveStream() {
    console.log('log part', this.path, 'no longer live, fine whatever');
    this.isLive = false;
  }

  // TODO: IRC SPECIFIC :(
  loadEntry(msg) {
    msg.path = this.path+'/'+msg.id;
    return skylink.enumerate('/'+msg.path, {maxDepth: 2}).then(list => {
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

}




// Represents a mechanism for requesting historical entries
// from a non-sparse array-style log (1, 2, 3...)
// Accepts an array that entries are added into.
// A head entry is added immediately to anchor new log entries.
// No support for unloading entries yet :(
// TODO: rn always starts at latest and heads towards horizon
class LazyBoundSequenceBackLogBeta {
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
      .then(chan => new SingleSubscription(chan))
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
          this.loadEntry(msg);
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

Vue.component('sky-infinite-timeline-log-beta', {
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
    /*  if (!this.seenDivider) {
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
      }*/
    },
  },
  created() {
    promise.then(() => this.switchTo(this.path));
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 1000);
  },
  destroyed() {
    clearInterval(this.scrollTimer);
    this.loadedParts.forEach(x => x.stop());
    this.latestPartSub.stop();
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
        if (Math.abs(deltaHeight) < 25 && this.$el.scrollTop < 2000) {
          //console.log('fudging scrollTop to adjust for message load, delta', deltaHeight);
          this.$el.scrollTop -= deltaHeight;
          // if it's small, just go with it
          // important when loading messages in
        }
        if (this.newestSeenMsg != this.entries.slice(-1)[0]) {
          const newMsgs = this.entries.length - this.entries.indexOf(this.newestSeenMsg)
          this.unseenCount += newMsgs;
        }
      }
    }
    this.newestSeenMsg = this.entries.slice(-1)[0];
  },
  methods: {
    switchTo(path) {
      const cursor = multiplexer.getLatest('/'+path);
      window.lC = cursor;
      console.log('started cursor', cursor, 'on', path);
      /*
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
      });*/

    },
    // oldest part must be ready. promises to successfully load exactly n older messages.
    requestMessages(n) {
      /*const part = this.loadedParts[0];
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
          const prevPart = new LazyBoundSequenceBackLogBeta(prevPartId, this.path+'/'+prevPartId, this.entries, 0, 'backfill');
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
      }*/
    },
    startLivePart(partId) {
      // check if this is a part that just appeared
      /*var mode = 'initial';
      if (this.newestPart) {
        mode = 'bleeding-edge';
      }

      console.log('Starting live partition', partId);
      const part = new LazyBoundSequenceBackLogBeta(partId, this.path+'/'+partId, this.entries, -1, mode);
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
      }*/
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
          if (this.$el.scrollTop < 1250) {
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
        if (this.$el.scrollTop < 1250) {
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
