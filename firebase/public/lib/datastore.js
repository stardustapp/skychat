
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

// Supports 2-deep subscriptions of format:
// /:id - a document with unique/arbitrary id
// /:id/:field - string fields of document
// documents are presented as vanilla objects
class RecordSubscription {
  constructor(channel, opts) {
    this.basePath = opts.basePath;
    this.fields = opts.fields || [];
    this.filter = opts.filter || {};

    this.idMap = new Map();
    this.items = new Array();
    this.status = 'Pending';
    // TODO: this.currentId = ''; // used during startup

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyCbs = {resolve, reject};
    });

    channel.forEach(pkt => {
      var handler = this['on' + pkt.type];
      if (handler) {
        handler.call(this, pkt.path, pkt.entry);
      } else {
        console.warn('record sub did not handle', pkt);
      }
    });
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
      this.idMap.set (id, doc);
      if (Object.keys(this.filter).length == 0) {
        this.items.push(doc);
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
          this.items.push(doc);
          //console.log('dropping document', id, 'due to filter on', field);
          //const idx = this.items.indexOf(doc);
          //if (idx >= 0) {
          //  this.items.splice(idx, 1);
          //}
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
