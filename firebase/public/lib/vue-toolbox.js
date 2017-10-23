
// Represents a mechanism for requesting historical entries
// from a non-sparse array-style log (1, 2, 3...)
// Accepts an array that entries are added into.
// A head entry is added immediately to anchor new log entries.
// No support for unloading entries yet :(
// TODO: rn always starts at latest and heads towards horizon
class LazyBoundSequenceBackLog {
  constructor(partId, path, array, idx) {
    this.id = partId;
    this.path = path;
    this.array = array;
    console.log('Starting log partition', partId, path);

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

      this.latestIdSub.forEach(newLatest => {
        console.log('Log partition', this.id, 'got new message sequence', newLatest);

        if (newLatest >= 0) {
          const msg = {
            id: newLatest,
            slot: 'entry',
            props: {},
          };
          const idx = this.array.indexOf(this.latestItem);
          this.array.splice(idx+1, 0, msg);
          this.latestId = newLatest;
          this.latestItem = msg;
          this.loadEntry(msg);
        } else {
          console.log('log partition', this.id, 'is empty');
        }

        if (this.readyCbs) {
          this.readyCbs.resolve(newLatest);
          this.readyCbs = null;
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

      console.log('got msg', msg.id, '- was', props);
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
        slot: 'entry',
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
  },
  data: () => ({
    horizonPart: null,
    newestPart: null,
    loadedParts: [],
    entries: [], // passed to vue
    nonce: null,
  }),
  computed: {
    latestPart() {
      return this.latestPartSub && this.latestPartSub.val;
    },
  },
  watch: {
    path(path) { this.switchTo(path) },
  },
  created() {
    promise.then(() => this.switchTo(this.path));
    this.scrollTimer = setInterval(this.scrollTick.bind(this), 1000);
  },
  destroyed() {
    clearInterval(this.scrollTimer);
  },
  beforeUpdate() {
    console.log('before update');
  },
  updated() {
    console.log('updated');
  },
  methods: {
    switchTo(path) {
      this.horizonPart = null;
      this.newestPart = null;
      this.latestPartSub = null;
      this.loadedParts = [];
      this.entries = [];
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
          const prevPart = new LazyBoundSequenceBackLog(prevPartId, this.path+'/'+prevPartId, this.entries, 0);
          this.loadedParts.unshift(prevPart);

          return prevPart.readyPromise.then(() => {
            console.log('older part', prevPart.id, 'is ready, asking for remainder of', remainder);
            return this.requestMessages(remainder);
          });
        } else {
          return Promise.reject(`Entire log ran dry with ${remainder} entries still desired of ${n}`);
        }
      } else {
        console.log('the request of', n, 'entries has been satisfied');
        return Promise.resolve();
      }
    },
    startLivePart(partId) {
      // TODO: finish out active part if any

      console.log('Starting live partition', partId);
      const part = new LazyBoundSequenceBackLog(partId, this.path+'/'+partId, this.entries, -1);
      this.loadedParts.push(part);
      this.newestPart = partId;

      // If this is the first part, start loading in backlog
      // TODO: something else can probably be requesting backlog
      if (this.loadedParts.length == 1) {
        part.readyPromise.then(() => {
          // requesting is blocking/sync
          console.log('loading initial block of backlog');
          this.requestMessages(35);
        });
      }

      /*
      const part = {
        id: partId,
        path: this.path+'/'+partId,
        live: true,
        headEntry: null,
        tailEntry: null,
      };
      this.loadedParts.push(part);

      const horizonP = skylink.loadString('/'+path+'/horizon');
      const latestSubP = skylink
        .subscribe('/'+path+'/latest', {maxDepth: 0})
        .then(chan => new SingleSubscription(chan))
        .then(sub => sub.readyPromise);
      Promise.all([horizonP, latestSubP]).then(([horizon, latestSub]) => {
        if (this.nonce !== nonce) {
          console.warn('sky-infinite-timeline-log init on', path, 'became ready, but was cancelled, ignoring');
          return;
        }

        this.horizonPart = horizon;
        this.latestPartSub = latestSub;
        console.log(path, '- newest', this.latestPartSub.val, ', horizon', this.horizonPart);
      });*/

    },

    scrollTick() {
      const {log} = this.$refs;
      const bottomTop = log.scrollHeight - log.clientHeight;
      this.isAtBottom = bottomTop <= log.scrollTop;
      this.scrollDown();
      /*if (this.isAtBottom && this.newMessageCount && document.visibilityState === 'visible') {
        log.scrollTop = bottomTop;
        this.newMessageCount = 0;
        this.offerLastSeen(this.mostRecentMsg);
      }*/
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

    offerLastSeen(id) {/*
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
      });*/
    },

  },
  template: `
  <component :is="el||'div'" ref="log">
    <slot v-for="entry in entries" :name="entry.slot" v-bind="entry.props"></slot>
  </component>`,
});
