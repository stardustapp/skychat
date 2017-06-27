class Skylink {
  constructor(prefix, endpoint) {
    this.endpoint = endpoint || '/~~export';
    this.prefix = prefix || '';
  }

  //////////////////////////////////////
  // First-order operations

  ping() {
    return this.exec({Op: 'ping'}).then(x => x.Ok);
  }

  get(path) {
    return this.exec({
      Op: 'get',
      Path: this.prefix + path,
    }).then(x => x.Output);
  }

  enumerate(path, opts={}) {
    const maxDepth = opts.maxDepth == null ? 1 : +opts.maxDepth;
    const shapes = opts.shapes || [];
    return this.exec({
      Op: 'enumerate',
      Path: this.prefix + path,
      Depth: maxDepth,
      Shapes: shapes,
    }).then(res => {
      const list = res.Output.Children;
      if (opts.includeRoot === false) {
        list.splice(0, 1);
      }
      return list;
    });
  }

  store(path, entry) {
    return this.exec({
      Op: 'store',
      Dest: this.prefix + path,
      Input: entry,
    });
  }

  invoke(path, input, outputPath) {
    return this.exec({
      Op: 'invoke',
      Path: this.prefix + path,
      Input: input,
      Dest: outputPath ? (this.prefix + outputPath) : '',
    }).then(x => x.Output);
  }

  copy(path, dest) {
    return this.exec({
      Op: 'copy',
      Path: this.prefix + path,
      Dest: this.prefix + dest,
    });
  }

  unlink(path) {
    return this.exec({
      Op: 'unlink',
      Path: this.prefix + path,
    });
  }

  //////////////////////////////////////
  // Helpers using the core operations

  fetchShape(path) {
    return this.enumerate(path, {
      maxDepth: 3,
    }).then(x => {
      const shape = {
        path: path,
      };
      const props = new Map();

      x.forEach(item => {
        const parts = item.Name.split('/');
        if (item.Name === 'type') {
          shape.type = item.StringValue;
        } else if (item.Name === 'props') {
          shape.props = true;
        } else if (parts[0] === 'props' && parts.length == 2) {
          if (item.Type === 'String') {
            props.set(parts[1], {
              name: parts[1],
              type: item.StringValue,
              shorthand: true,
            });
          } else if (item.Type === 'Folder') {
            props.set(parts[1], {
              name: parts[1],
              shorthand: false,
            });
          }
        } else if (parts[0] === 'props' && parts[2] === 'type') {
          props.get(parts[1]).type = item.StringValue;
        } else if (parts[0] === 'props' && parts[2] === 'optional') {
          props.get(parts[1]).optional = item.StringValue === 'yes';
        }
      });

      if (shape.props) {
        shape.props = [];
        props.forEach(prop => shape.props.push(prop));
      }
      return shape;
    });
  }

  mkdirp(path) {
    const parts = path.slice(1).split('/');
    var path = '';
    const nextPart = () => {
      if (parts.length === 0) {
        return true;
      }
      const part = parts.shift();
      path += '/' + part;
      return this.get(path)
        .then(x => true, x => {
          console.log('mkdirp got failure', x);
          if (x.includes('404')) {
            return this.store(path, Skylink.Folder(part));
          }
          return Promise.reject(x);
        })
        .then(nextPart);
    };
    return nextPart();
  }

  // File-based API

  putFile(path, data) {
    const nameParts = path.split('/');
    const name = nameParts[nameParts.length - 1];
    return this.store(path, Skylink.File(name, data));
  }

  loadFile(path) {
    return this.get(path).then(x => {
      if (x.Type !== 'File') {
        return Promise.reject(`Expected ${path} to be a File but was ${x.Type}`);
      } else {
        return atob(x.FileData || '');
      }
    });
  }

  // String-based API

  putString(path, value) {
    const nameParts = path.split('/');
    const name = nameParts[nameParts.length - 1];
    return this.store(path, Skylink.String(name, value));
  }

  loadString(path) {
    return this.get(path).then(x => {
      if (x.Type !== 'String') {
        return Promise.reject(`Expected ${path} to be a String but was ${x.Type}`);
      } else {
        return x.StringValue || '';
      }
    });
  }

  //////////////////////////////////////
  // Helpers to build an Input

  static String(name, value) {
    return {
      Name: name,
      Type: 'String',
      StringValue: value,
    };
  }

  static File(name, data) {
    return {
      Name: name,
      Type: 'File',
      FileData: btoa(data),
    };
  }

  static Folder(name, children) {
    return {
      Name: name,
      Type: 'Folder',
      Children: children || [],
    };
  }

  //////////////////////////////////////
  // The actual transport

  exec(request) {
    return fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    })
    .then(this.checkHttpOk)
    .then(x => x.json())
    .then(this.checkOk);
  }

  // Chain after a fetch() promise with .then()
  checkHttpOk(resp) {
    if (resp.status >= 200 && resp.status < 400) {
      return resp;
    } else {
      return Promise.reject(`Stardust op failed with HTTP ${resp.status}`);
    }
  }

  // Chain after a json() promise with .then()
  checkOk(obj) {
    if (obj.ok === true || obj.Ok === true) {
      return obj;
    } else {
      alert(`Stardust operation failed:\n\n${obj}`);
      return Promise.reject(obj);
    }
  }
}