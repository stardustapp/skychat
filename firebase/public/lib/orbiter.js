class Orbiter {
  constructor(subPath) {
    this.subPath = subPath || '';
    this.rootPath = '/~~' + this.subPath;
    
    // this is where /tmp and /rom/shapes lives
    if (this.subPath) {
      this.rootOrbit = new Orbiter('');
    } else {
      this.rootOrbit = this;
    }
  }
  
  // Chain after a promise with .then()
  checkOk(obj) {
    if (obj.ok === true) {
      console.log("Stardust operation completed successfully");
      return obj;
    } else {
      alert(`Stardust operation failed:\n\n${obj}`);
      return Promise.reject(obj);
    }
  }

  loadMetadata(path, opts) {
    opts = opts || {};
    
    const headers = {
      Accept: 'application/json',
    };
    if (opts.shapes) {
      headers['X-Sd-Match-Shape'] = opts.shapes;
    }
    
    console.log(`[orbiter] Loading JSON metadata for ${path}`);
    return fetch(this.rootPath + path, {headers})
      .then(x => x.json());
  }
  
   // TODO: rename loadRaw
  loadFile(path) {
    console.log(`[orbiter] Loading file ${path}`);
    return fetch(this.rootPath + path, {
      headers: {
        Accept: 'text/plain',
      },
    })
    .then(x => x.text());
  }
  
  // Invokes a function with a given input (path, temporary, or null)
  invoke(path, input, outputPath) {
    console.log(`[orbiter] Invoking ${path} with ${input}`);
    
    if (outputPath === true) {
      outputPath = '/tmp/' + Orbiter.randomId();
    } else if (outputPath) {
      outputPath = this.subPath + outputPath
    }
    
    var p;
    if (input == null) {
      p = Promise.resolve(null);
    } else if (input.constructor === String) {
      p = Promise.resolve(this.subPath + input)
    } else {
      p = this.rootOrbit
        .putRandomFolder('/tmp', input)
        .then(name => '/tmp/' + name)
    }
    return p.then(inputPath => fetch(this.rootPath + path, {
      method: 'POST',
      // redirect: 'manual',
      headers: {
        'X-SD-Input': inputPath || '',
        'X-SD-Output': outputPath || '',
      },
    })).then(resp => {
      if (resp.status === 201 && outputPath) {
        console.log('Invocation result created at', outputPath);
        return new Orbiter(outputPath);
      } else {
        return null;
      }
    });
    // TODO: cleanup tmp folder?
  }
  
  delete(path) {
    console.log(`[orbiter] Deleting entry ${path}`);
    return fetch(this.rootPath + path, {
      method: 'DELETE',
    });
  }
  
  putFolder(path) {
    console.log(`[orbiter] Creating folder ${path}`);
    return fetch(this.rootPath + path, {
      method: 'PUT',
      headers: {
        'X-SD-Entry-Type': 'Folder',
      },
    })
    .then(x => x.json())
    .then(x => this.checkOk(x));
  }
  
  putFile(path, data) {
    console.log(`[orbiter] Storing file ${path} with ${data.length} bytes`);
    return fetch(this.rootPath + path, {
      method: 'PUT',
      body: data,
      headers: {
        'X-SD-Entry-Type': 'File',
        'Content-Type': 'text/plain',
      },
    })
    .then(x => x.json())
    .then(x => this.checkOk(x));
  }
  
  putString(path, value) {
    console.log(`[orbiter] Storing string ${path} with value "${value}"`);
    return fetch(this.rootPath + path, {
      method: 'PUT',
      body: value,
      headers: {
        'X-SD-Entry-Type': 'String',
        'Content-Type': 'text/plain',
      },
    })
    .then(x => x.json())
    .then(x => this.checkOk(x));
  }
  
  static randomId() {
    return [
      Date.now().toString(36),
      Math.random().toString(36).slice(2).slice(-4),
    ].join('_');
  }

  putRandomFolder(parent, children) {
    const name = Orbiter.randomId();
    const fullPath = parent + '/' + name;
    return this
      .putFolderOf(fullPath, children)
      .then(() => name);
  }
  
  putFolderOf(path, children) {
    return this
      .putFolder(path)
      .then(() => Object
            .keys(children)
            .map(name => {
        const child = children[name];
        const fullPath = path + '/' + name;
        switch (child.type) {
          case 'String':
            return this.putString(fullPath, child.value || '');
          case 'File':
            return this.putFile(fullPath, child.data || '');
          case 'Folder':
            return this.putFolderOf(fullPath, child.children || {});
          default:
            alert(`Can't put a ${child.type} in folder ${path}`);
        }
      }))
      .then(list => Promise.all(list));
  }
  
  
  static String(value) {
    return {
      type: 'String',
      value: value,
    };
  }

  static File(data) {
    return {
      type: 'File',
      data: data,
    };
  }

  static Folder(children) {
    return {
      type: 'Folder',
      children: children,
    };
  }
}