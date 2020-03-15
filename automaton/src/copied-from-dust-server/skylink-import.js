const {
  SkylinkClient,
  StatelessHttpSkylinkClient,
  MessagePassingSkylinkClient,
  WebsocketSkylinkClient,
} = require('@dustjs/standard-machine-rt');

class ImportedSkylinkDevice {
  constructor(remote, pathPrefix) {
    this.remote = remote;
    this.pathPrefix = pathPrefix;

    // copy promise from remote
    this.ready = Promise.resolve(remote.ready)
      .then(() => remote.volley({Op: 'ping'}));
  }

  getEntry(path) {
    return new ImportedSkylinkEntry(this.remote, this.pathPrefix + path);
  }

  getSubRoot(path) {
    if (path === '') return this;
    return new ImportedSkylinkDevice(this.remote, this.pathPrefix + path);
  }

  static fromUri(uri) {
    if (!uri.startsWith('skylink+')) throw new Error(
      `BUG: ImportedSkylinkDevice given non-skylink URI of scheme "${uri.split('://')[0]}"`);

    const parts = uri.slice('skylink+'.length).split('/');
    const scheme = parts[0].slice(0, -1);
    const endpoint = parts.slice(0, 3).join('/') + '/~~export' + (scheme.startsWith('ws') ? '/ws' : '');
    const remotePrefix = ('/' + parts.slice(3).join('/')).replace(/\/+$/, '');

    if (scheme.startsWith('http')) {
      const skylink = new StatelessHttpSkylinkClient(endpoint);
      return new ImportedSkylinkDevice(skylink, remotePrefix);

    } else if (scheme.startsWith('ws')) {
      const skylink = new WebsocketSkylinkClient(endpoint);
      skylink.shutdownHandlers.push(() => {
        skylink.ready = Promise.reject(new Error(`Skylink WS transport has been disconnected`));
        // TODO: either try reconnecting, or just shut the process down so it can restart
      });
      return new ImportedSkylinkDevice(skylink, '/pub'+remotePrefix);

    } else {
      throw new Error(`BUG: Tried importing a skylink of unknown scheme "${scheme}"`);
    }
  }
}

class ImportedSkylinkEntry {
  constructor(remote, path) {
    this.remote = remote;
    this.path = path;
  }

  async get() {
    const response = await this.remote.volley({
      Op: 'get',
      Path: this.path,
    });
    if (!response.Ok) throw new Error(
      `Remote skylink get() failed: ${(response.Output||{}).StringValue || "Empty"}`);
    return response.Output;
  }

  async enumerate(enumer) {
    const response = await this.remote.volley({
      Op: 'enumerate',
      Path: this.path||'/',
      Depth: enumer.remainingDepth(),
    });
    if (!response.Ok) throw new Error(
      `Remote skylink enumerate() failed: ${(response.Output||{}).StringValue || "Empty"}`);

    // transclude the remote enumeration
    enumer.visitEnumeration(response.Output);
  }

  async put(value) {
    const response = await this.remote.volley((value === null) ? {
      Op: 'unlink',
      Path: this.path,
    } : {
      Op: 'store',
      Dest: this.path,
      Input: value,
    });
    if (!response.Ok) throw new Error(
      `Remote skylink put() failed: ${(response.Output||{}).StringValue || "Empty"}`);
  }

  async invoke(value) {
    // if (typeof value.get === 'function') {
    //   value = await value.get();
    // }

    const response = await this.remote.volley({
      Op: 'invoke',
      Path: this.path,
      Input: value,
    });
    if (!response.Ok) throw new Error(
      `Remote skylink invoke() failed: ${(response.Output||{}).StringValue || "Empty"}`);
    return response.Output;
  }

/*
  async subscribe(depth, newChan) {
    const response = await this.remote.volley({
      Op: 'subscribe',
      Path: this.path,
      Depth: depth,
    });
    if (!response.Ok) throw new Error(
      `Remote skylink subscribe() failed: ${(response.Output||{}).StringValue || "Empty"}`);
    return response.Output;
  }
*/
}

module.exports = {
  ImportedSkylinkDevice,
  ImportedSkylinkEntry,
};
