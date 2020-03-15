class TemporaryMount {
  constructor(opts) {
    this.entries = new Map();
  }

  getEntry(path) {
    return new TmpEntry(this, path);
  }
}

class TmpEntry {
  constructor(mount, path) {
    this.mount = mount;
    this.path = path;
  }

  async get() {
    const entry = this.mount.entries.get(this.path);
    if (!entry) return null;
    if (entry.Type) return entry;
    if (entry.get) return entry.get();
    throw new Error(`get() called but wasn't a gettable thing`);
  }

  async invoke(input) {
    const entry = this.mount.entries.get(this.path);
    if (!entry) return null;
    if (entry.invoke) return entry.invoke(input);
    throw new Error(`get() called but wasn't a gettable thing`);
  }

  async put(value) {
    console.log('putting', this.path, value);
    return this.mount.entries.set(this.path, value);
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    TemporaryMount,
  };
}
