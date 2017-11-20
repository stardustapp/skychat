
// compare to Rx Observable
class Channel {
  constructor(id) {
    this.id = id;
    this.queue = ['waiting'];

    this.burnBacklog = this.burnBacklog.bind(this);
  }

  // add a packet to process after all other existing packets process
  handle(packet) {
    this.queue.push(packet);
    if (this.queue.length == 1) {
      // if we're alone at the front, let's kick it off
      this.burnBacklog();
    }
  }

  start(callbacks) {
    this.callbacks = callbacks;
    var item;
    console.log('Starting channel #', this.id);
    this.burnBacklog();
    while (item = this.queue.shift()) {
      this.route(item);
    }
  }

  burnBacklog() {
    const item = this.queue.shift();
    if (item === 'waiting') {
      // skip dummy value
      return this.burnBacklog();
    } else if (item) {
      return this.route(item).then(this.burnBacklog);
    }
  }

  route(packet) {
    const callback = this.callbacks['on' + packet.Status];
    if (callback) {
      return callback(packet) || Promise.resolve();
    } else {
      console.log("Channel #", this.id, "didn't handle", packet);
      return Promise.resolve();
    }
  }


  forEach(effect) {
    this.start({
      onNext(x) {
        effect(x.Output);
      },
      onError(x) { chan.handle(x); },
      onDone(x) { chan.handle(x); },
    });
    return new Channel('void');
  }

  map(transformer) {
    const chan = new Channel(this.id + '-map');
    this.start({
      onNext(x) { chan.handle({
        Status: x.Status,
        Output: transformer(x.Output), // TODO: rename Value
      }); },
      onError(x) { chan.handle(x); },
      onDone(x) { chan.handle(x); },
    });
    return chan;
  }

  filter(selector) {
    const chan = new Channel(this.id + '-filter');
    this.start({
      onNext(x) {
        if (selector(x.Output)) {
          chan.handle(x);
        }
      },
      onError(x) { chan.handle(x); },
      onDone(x) { chan.handle(x); },
    });
    return chan;
  }
}

/*
Skylink.prototype.subscribeAgainst = function subscribeAgainst(path, routes) {
  return this
    .subscribe(path)
    .then(channel => new Subscription(channel))
};
*/

class Subscription {
  constructor(channel) {
    this.paths = new Map();
    this.status = 'Pending';
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });

    channel.forEach(pkt => {
      var handler = this['on' + pkt.type];
      if (handler) {
        handler.call(this, pkt.path, pkt.entry);
      } else {
        console.warn('sub did not handle', pkt);
      }
    });
  }

  onAdded(path, entry) {
    this.paths.set(path || '', entry);
  }

  onReady() {
    console.log('Subscription is ready.', this.paths);
  }

  onError(_, error) {
    if (this.readyCbs) {
      this.readyCbs.reject(error);
      this.readyCbs = null;
    }
    this.status = 'Failed: ' + error;
  }
}

// accepts zero depth and presents the root node
class SingleSubscription {
  constructor(sub) {
    console.log('single sub started');
    this.sub = sub;
    this.api = {
      // TODO: stop: this.stop.bind(this),
      val: null,
    };
    this.status = 'Pending';
    this.forEachCbs = [];
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });

    sub.channel.forEach(pkt => {
      var handler = this['on' + pkt.type];
      if (handler) {
        handler.call(this, pkt.path, pkt.entry);
      } else {
        console.warn('single sub did not handle', pkt);
      }
    });
  }

  stop() {
    return this.sub.stop();
  }

  // registers a callback for each change
  forEach(cb) {
    this.forEachCbs.push(cb);
    if (this.api.val !== null) {
      cb(this.api.val);
    }
  }

  onAdded(path, entry) {
    console.log('single: added ', entry);
    this.api.val = entry;
    this.forEachCbs.forEach(cb => cb(entry));
  }

  onChanged(path, entry) {
    console.log('single: changed from', this.api.val, 'to', entry);
    this.api.val = entry;
    this.forEachCbs.forEach(cb => cb(entry));
  }

  onRemoved(path) {
    console.log('single: removed');
    this.api.val = null;
    this.forEachCbs.forEach(cb => cb(null));
  }

  onReady() {
    console.log('Single subscription is ready.', this.api.val);
    if (this.readyCbs) {
      this.readyCbs.resolve(this.api);
      this.readyCbs = null;
    }
    this.status = 'Ready';
  }

  onError(_, error) {
    if (this.readyCbs) {
      this.readyCbs.reject(error);
      this.readyCbs = null;
    }
    this.status = 'Failed: ' + error;
  }
}

// accepts one depth and presents one reactive object once ready
class FlatSubscription {
  constructor(sub) {
    console.log('flat sub started');
    this.sub = sub;
    this.fields = {};
    this.status = 'Pending';
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });

    sub.channel.forEach(pkt => {
      var handler = this['on' + pkt.type];
      if (handler) {
        handler.call(this, pkt.path, pkt.entry);
      } else {
        console.warn('sub did not handle', pkt);
      }
    });
  }

  stop() {
    return this.sub.stop();
  }

  onAdded(path, entry) {
    if (path) {
      console.log('flat: added', path, entry);
      this.fields[path] = entry;
    }
  }

  onChanged(path, entry) {
    if (path) {
      console.log('flat: changed', path, 'from', this.fields[path], 'to', entry);
      this.fields[path] = entry;
    }
  }

  onRemoved(path) {
    if (path) {
      console.log('flat: removed', path);
      this.fields[path] = null;
    }
  }

  onReady() {
    console.log('Flat subscription is ready.', this.fields);
    if (this.readyCbs) {
      this.readyCbs.resolve(this.fields);
      this.readyCbs = null;
    }
    this.status = 'Ready';
  }

  onError(_, error) {
    if (this.readyCbs) {
      this.readyCbs.reject(error);
      this.readyCbs = null;
    }
    this.status = 'Failed: ' + error;
  }
}

// Supports 2-deep subscriptions of format:
// /:id - a document with unique/arbitrary id
// /:id/:field - string fields of document
// documents are presented as vanilla objects
class RecordSubscription {
  constructor(sub, opts) {
    this.sub = sub;
    this.basePath = opts.basePath;
    this.fields = opts.fields || [];
    this.filter = opts.filter || {};
    this.stats = {
      hidden: 0,
    };

    this.idMap = new Map();
    this.items = new Array();
    this.status = 'Pending';
    // TODO: this.currentId = ''; // used during startup

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });

    sub.channel.forEach(pkt => {
      var handler = this['on' + pkt.type];
      if (handler) {
        handler.call(this, pkt.path, pkt.entry);
      } else {
        console.warn('record sub did not handle', pkt);
      }
    });
  }

  stop() {
    return this.sub.stop();
  }

  insertDoc(id, doc) {
    const properIdx = this.items.findIndex(x => x._id > id);
    if (properIdx === -1) {
      this.items.push(doc);
    } else {
      this.items.splice(properIdx, 0, doc);
    }
  }

  onAdded(path, entry) {
    if (!path) {
      // root entry: ignore
      return;
    }

    const parts = path.split('/');
    if (parts.length == 1) {
      // new document
      const [id] = parts;
      const doc = {
        _id: id,
        _path: this.basePath + '/' + id,
      };
      this.fields.forEach(x => doc[x] = null);

      // store it
      this.idMap.set(id, doc);
      if (Object.keys(this.filter).length == 0) {
        this.insertDoc(id, doc);
      } else {
        this.stats.hidden++;
      }

    } else if (parts.length == 2) {
      // add field to existing doc
      const [id, field] = parts;
      const doc = this.idMap.get(id);
      //switch (entry.Type)
      doc[field] = entry || '';

      // check filter
      if (field in this.filter) {
        if (doc[field] === this.filter[field]) {
          const idx = this.items.indexOf(doc);
          if (idx === -1) {
            this.stats.hidden--;
            this.insertDoc(id, doc);
          }
          //console.log('dropping document', id, 'due to filter on', field);
          //const idx = this.items.indexOf(doc);
          //if (idx >= 0) {
          //  this.items.splice(idx, 1);
          //}
        } else {
          // filter fails
          const idx = this.items.indexOf(doc);
          if (idx !== -1) {
            this.stats.hidden++;
            this.items.splice(idx, 1);
          }
        }
      }
    }
  }

  onChanged(path, entry) {
    if (!path) {
      // root entry: ignore
      return;
    }

    const parts = path.split('/');
    if (parts.length == 1) {
      // replaced document
      console.warn('recordsub got changed packet for entire document. not implemented!', path, entry);

    } else if (parts.length == 2) {
      // changed field on existing doc
      const [id, field] = parts;
      const doc = this.idMap.get(id);
      //switch (entry.Type)

      // check filter
      if (field in this.filter) {
        const didMatch = doc[field] === this.filter[field];
        const doesMatch = (entry || '') === this.filter[field];
        if (!didMatch && doesMatch) {
          const idx = this.items.indexOf(doc);
          if (idx === -1) {
            this.stats.hidden--;
            this.insertDoc(id, doc);
          }
        } else if (didMatch && !doesMatch) {
          // filter now fails
          const idx = this.items.indexOf(doc);
          if (idx !== -1) {
            this.stats.hidden++;
            this.items.splice(idx, 1);
          }
        }
      }

      // actually do the thing lol
      doc[field] = entry || '';
    }
  }

  onRemoved(path) {
    if (!path) {
      // root entry: ignore (TODO)
      return;
    }

    const parts = path.split('/');
    if (parts.length == 1) {
      // deleted document
      const [id] = parts;
      this.idMap.delete(id, doc);

      // remove doc from output
      const idx = this.items.indexOf(doc);
      if (idx !== -1) {
        this.items.splice(idx, 1);
      }

    } else if (parts.length == 2) {
      // remove field from existing doc
      const [id, field] = parts;
      const doc = this.idMap.get(id);
      doc[field] = null;

      // remove doc from output, if field is a filter
      if (field in this.filter) {
        const idx = this.items.indexOf(doc);
        if (idx !== -1) {
          this.stats.hidden++;
          this.items.splice(idx, 1);
        }
      }
    }
  }

  onReady() {
    console.log('Subscription is ready.', this.idMap);
    if (this.readyCbs) {
      this.readyCbs.resolve(this.items);
      this.readyCbs = null;
    }
    this.status = 'Ready';
  }

  onError(_, error) {
    if (this.readyCbs) {
      this.readyCbs.reject(error);
      this.readyCbs = null;
    }
    this.status = 'Failed: ' + error;
  }
}
