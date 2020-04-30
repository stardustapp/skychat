const Firestore = exports;
const {Datadog} = require('./copied-from-dust-server/datadog.js');

const {
  FolderEntry, StringEntry,
  InflateSkylinkLiteral,
} = require('@dustjs/skylink');

// e.g. 2017-10-29T08:15:26.519783309Z
const isoStringPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)Z$/;
function parseDateStringOrThrow(dateString) {
  if (!isoStringPattern.test(dateString)) {
    if (/^\d{10}$/.test(dateString)) {
      return new Date(parseInt(dateString));
    }
    throw new Error(
      `date field given non-ISO string "${dateString}", refusing`);
  }

  const dateValue = new Date(dateString);
  // check for "Invalid Date"
  if (!dateValue.toJSON()) throw new Error(
    `date field given invalid string "${dateString}", refusing`);

  return dateValue;
}

class PublicationState {
  constructor(chanApi) {
    this.chanApi = chanApi;
    this.sentPaths = new Map;
    this.isReady = false;
  }
  markCrashed(err) {
    this.chanApi.error(new FolderEntry('error', [
      new StringEntry('type', 'Error'),
      new StringEntry('message', err.message),
      new StringEntry('name', err.name),
    ]));
    this.chanApi = null;
  }
  markDone() {
    this.chanApi.done();
    this.chanApi = null;
  }
  markReady() {
    if (this.isReady) return;
    this.chanApi.next(new FolderEntry('notif', [
      new StringEntry('type', 'Ready'),
    ]));
    this.isReady = true;
  }
  removePath(path) {
    const exists = this.sentPaths.has(path);
    if (!exists) return;
    // throw new Error(`TODO: walk sentPaths to remove all children of ${path}`);
    this.chanApi.next(new FolderEntry('notif', [
      new StringEntry('type', 'Removed'),
      new StringEntry('path', path),
    ]));
    this.sentPaths.delete(path);

    // walk what we've sent looking for any children, to remove
    const childPathPrefix = path ? `${path}/` : ``;
    for (const [knownPath] of this.sentPaths) {
      if (path !== knownPath && knownPath.startsWith(childPathPrefix)) {
        // TODO: do we actually need to transmit child removals? clients can assume them
        this.chanApi.next(new FolderEntry('notif', [
          new StringEntry('type', 'Removed'),
          new StringEntry('path', knownPath),
        ]));
        this.sentPaths.delete(knownPath);
      }
    }
  }
  offerPath(path, newEntry) {
    const exists = this.sentPaths.has(path);
    if (!newEntry) throw new Error(
      `BUG: offerPath() cannot accept null entries`);

    const entry = {...JSON.parse(JSON.stringify(newEntry)), Name: 'entry'};
    if (typeof entry.Type !== 'string') throw new Error(
      `BUG: tried to offerPath() something without a Type string`);

    if (exists) {
      const prevEntry = this.sentPaths.get(path);
      if (prevEntry.Type !== entry.Type) throw new Error(
        `TODO: offerPath() given a ${entry.Type} for '${path}' was previously ${prevEntry.Type}`);

      switch (entry.Type) {
        case 'String':
          // simple comparision
          if (entry.StringValue === prevEntry.StringValue) return;
          break;

        case 'Error':
          // simple comparision
          if (entry.StringValue === prevEntry.StringValue) return;
          if (entry.Authority === prevEntry.Authority) return;
          if (entry.Code === prevEntry.Code) return;
          break;

        case 'Folder':
          // allow for listing Children here as a convenience method
          if ('Children' in entry) {
            const childMap = new Map;
            for (const child of entry.Children) {
              childMap.set(child.Name, child);
            }
            this.offerPathChildren(path, childMap);
          }
          // folders don't have their own attrs, so never get Changed
          return;

        default:
          console.log('prev:', JSON.stringify(prevEntry, null, 2));
          console.log('next:', JSON.stringify(entry, null, 2));
          throw new Error(`TODO: offerPath() diffing for ${entry.Type}`);
      }
    }

    this.chanApi.next(new FolderEntry('notif', [
      new StringEntry('type', exists ? 'Changed' : 'Added'),
      new StringEntry('path', path),
      entry,
    ]));
    this.sentPaths.set(path, entry);

    if (entry.Type === 'Folder' && 'Children' in entry) {
      const childMap = new Map;
      for (const child of entry.Children) {
        childMap.set(child.Name, child);
      }
      this.offerPathChildren(path, childMap);
    }
  }

  offerPathChildren(parentPath, childMap) {
    const childNamePrefix = parentPath ? `${parentPath}/` : ``;
    if (childMap.constructor !== Map) throw new Error(
      `BUG: offerPathChildren() requires a Map instance`);

    const expectedNames = new Set;
    for (const [knownPath] of this.sentPaths) {
      // make sure they're exactly one level underneath
      if (!knownPath.startsWith(childNamePrefix)) continue;
      const name = knownPath.slice(childNamePrefix.length);
      if (name.indexOf('/') !== -1 || name === '') continue;
      expectedNames.add(decodeURIComponent(name));
    }

    for (const [name, entry] of childMap) {
      // console.log('seen', name);
      expectedNames.delete(name);
      this.offerPath(childNamePrefix+encodeURIComponent(name), entry);
    }

    // console.log('offerPathChildren ended up with stragglers:', expectedNames);
    for (const lostName of expectedNames) {
      console.debug(`offerPathChildren retracting straggler:`, childNamePrefix, lostName);
      this.removePath(childNamePrefix+encodeURIComponent(lostName));
    }
  }
}

exports.ArrayElementEntry = class FirestoreArrayElementEntry {
  constructor(docRef, fieldPath, arrayIdx, dataType) {
    this.docRef = docRef;
    this.fieldPath = fieldPath;
    this.arrayIdx = arrayIdx;
    this.dataType = dataType;
  }
  docSnapToEntry(docSnap) {
    const fieldValue = docSnap.get(this.fieldPath);
    const elemValue = (fieldValue || [])[this.arrayIdx];

    switch (true) {
      case elemValue == null:
        return null;
      case this.dataType === String:
        return {Type: 'String', StringValue: `${elemValue}`};
      default:
        throw new Error(`TODO: ArrayElementEntry docSnapToEntry() default case`);
    }
  }
  async get() {
    Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: 'array-element/get'});
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);
  }
  async put(input) {
    Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: 'array-element/put'});
    const docSnap = await this.docRef.get();
    const array = docSnap.get(this.fieldPath) || [];

    // support deletion
    switch (true) {

      case input == null:
        array[this.arrayIdx] = null;
        break;

      case this.dataType === String:
        if (input.Type !== 'String') throw new Error(
          `string fields must be put as String entries`);
        array[this.arrayIdx] = input.StringValue || '';
        break;

      default:
        throw new Error(`unrecognized put field type for element of ${this.fieldPath}`);
    }

    const doc = {};
    doc[this.fieldPath] = array;

    console.log('setting fields', doc, 'on', this.docRef.path);
    Datadog.countFireOp('write', this.docRef, {fire_op: 'merge', method: 'array-element/put'});
    await this.docRef.set(doc, {
      mergeFields: [this.fieldPath],
    });
  }
}

exports.FieldEntry = class FirestoreFieldEntry {
  constructor(docRef, fieldPath, dataType) {
    this.docRef = docRef;
    this.fieldPath = fieldPath;
    this.dataType = dataType;
  }
  async getEntry(path) {
    switch (true) {
      // Support grabbing array children
      case this.dataType.constructor === Array:
        const index = parseInt(path.slice(1));
        if (index > 0 && path === `/${index}`) {
          return new exports.ArrayElementEntry(this.docRef, this.fieldPath, index-1, this.dataType[0]);
        }

      default:
        console.log('Getting subpath', path, 'from FIELD', this.fieldPath);
        return null;
    }
  }
  docSnapToEntry(docSnap) {
    const fieldValue = docSnap.get(this.fieldPath);
    // console.log('FieldEntry', this.fieldPath, {fieldValue, dataType: this.dataType});

    switch (true) {
      case this.dataType.constructor === Array && this.dataType[0] === String:
        return {
          Name: 'todo',
          Type: 'Folder',
          Children: (fieldValue === undefined ? [] : fieldValue)
            .map((raw, idx) => ({
              Name: `${idx+1}`,
              Type: 'String',
              StringValue: raw,
            })),
        };
      case fieldValue === undefined:
        return null;
      case this.dataType === Array:
        throw new Error(`TODO: docSnapToEntry() for Array types`);
      case this.dataType === Number:
        return {Type: 'String', StringValue: `${fieldValue}`};
      case this.dataType === Boolean:
        return {Type: 'String', StringValue: fieldValue ? 'yes' : 'no'};
      case this.dataType === Date:
        return {Type: 'String', StringValue: fieldValue.toDate().toISOString()};
      case this.dataType === String:
        return {Type: 'String', StringValue: fieldValue};
      case this.dataType.Type === 'Blob':
        throw new Error(`TODO: docSnapToEntry() for Blob types`);
      default:
        throw new Error(`TODO: docSnapToEntry() default case`);
    }
  }
  async get() {
    Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: 'field/get'});
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);
  }
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      const state = new PublicationState(c);
      // TODO: check Depth
      // console.log('TODO FirestoreFieldEntry#subscribe', {Depth}, this.fieldPath);
      Datadog.countFireOp('stream', this.docRef, {fire_op: 'onSnapshot', method: 'field/subscribe'});
      const stopSnapsCb = this.docRef.onSnapshot(docSnap => {
        Datadog.countFireOp('read', this.docRef, {fire_op: 'watched', method: 'field/subscribe'});
        const entry = this.docSnapToEntry(docSnap);
        if (entry) {
          state.offerPath('', entry);
        } else {
          state.removePath('');
        }
        state.markReady();
      },
      error => {
        console.error('WARN: FirestoreFieldEntry#subscribe snap error:',
            error.code, error.stack || error.message);
        state.markCrashed(error);
      });
      c.onStop(stopSnapsCb);
    });
  }
  async enumerate(enumer, knownDocSnap=null) {
    const getSnapshot = async () => {
      if (knownDocSnap) return knownDocSnap;
      Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: 'field/enumerate'});
      knownDocSnap = await this.docRef.get();
      return knownDocSnap;
    }

    switch (true) {

      // 'primitive' types (never have children)
      case [Array,Number,Boolean,Date,String].includes(this.dataType):
        let docSnap = await getSnapshot();
        let entry = this.docSnapToEntry(docSnap);
        if (entry) {
          enumer.visit(entry);
        }
        break;

      case this.dataType.constructor === Array && this.dataType[0] === String:
        enumer.visit({Type: 'Folder'});
        if (enumer.canDescend()) {
          const docSnap = await getSnapshot();
          const fieldValue = docSnap.get(this.fieldPath);
          (fieldValue||[]).forEach((innerVal, idx) => {
            enumer.descend(`${idx+1}`);
            enumer.visit({Type: 'String', StringValue: `${innerVal}`});
            enumer.ascend();
          });
        }
        break;

      default:
        throw new Error(`TODO: FirestoreDocEntry enumerate() default case`);
    }
  }
  async put(input) {
    const doc = {};

    // support deletion
    if (!input) {
      doc[this.fieldPath] = null;
      console.log('clearing fields', doc, 'on', this.docRef.path);
      Datadog.countFireOp('write', this.docRef, {fire_op: 'merge', method: 'field/put'});
      await this.docRef.set(doc, {
        mergeFields: [this.fieldPath],
      });
      return;
    }

    switch (true) {

      case this.dataType === String:
        if (input.Type !== 'String') throw new Error(
          `string fields must be put as String entries`);
        doc[this.fieldPath] = input.StringValue || '';
        break;

      case this.dataType === Boolean:
        if (input.Type !== 'String') throw new Error(
          `boolean fields must be put as String entries`);
        doc[this.fieldPath] = input.StringValue === 'yes';
        break;

      case this.dataType === Date:
        if (input.Type !== 'String') throw new Error(
          `date fields must be put as String entries`);
        doc[this.fieldPath] = parseDateStringOrThrow(input.StringValue);
        break;

      case this.dataType === Number:
        if (input.Type !== 'String') throw new Error(
          `number fields must be put as String entries`);
        doc[this.fieldPath] = parseFloat(input.StringValue);
        break;

      default:
        throw new Error(`unrecognized put field type for ${this.fieldPath}`);
    }

    console.log('setting fields', doc, 'on', this.docRef.path);
    Datadog.countFireOp('write', this.docRef, {fire_op: 'merge', method: 'field/put'});
    await this.docRef.set(doc, {
      mergeFields: [this.fieldPath],
    });
  }
}

const docCache = new Map;
const cachableDocPathPattern = /^users\/[^/]+\/irc networks\/[^/]+\/(channels|queries|logs)\/[^/]+\/partitions\/[^/]+\/entries\/[0-9]+$/;

exports.DocEntry = class FirestoreDocEntry {
  constructor(docRef, subPaths) {
    this.docRef = docRef;
    this.subPaths = subPaths;
  }
  async getSnapshot(logReason) {
    if (cachableDocPathPattern.test(this.docRef.path)) {
      if (docCache.has(this.docRef.path)) {
        Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: logReason, cache: 'hit'});
        return docCache.get(this.docRef.path);
      } else {
        Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: logReason, cache: 'miss'});
        const docSnap = await this.docRef.get();
        // TODO: create our own copy of the snapshot?
        docCache.set(this.docRef.path, docSnap);
        return docSnap;
      }
    } else {
      Datadog.countFireOp('read', this.docRef, {fire_op: 'get', method: logReason});
      return await this.docRef.get();
    }
  }

  docSnapToEntry(docSnap) {
    if (!docSnap.exists) return null;
    const entry = {Type: 'Folder', Children: []};
    for (const childPath in this.subPaths) {
      const fieldKey = childPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
      const pathType = this.subPaths[childPath];

      let childEntry;
      // Functions named like a path are to be constructed with the current ref
      if (typeof pathType === 'function' && pathType.name.startsWith('/')) {
        const innerMapping = pathType(this.docRef);
        const fieldObj = innerMapping.getEntry('');
        if ('docSnapToEntry' in fieldObj) {
          console.log({childPath}, fieldObj)
          childEntry = fieldObj.docSnapToEntry(docSnap);
        }
      } else {
        const fieldObj = new Firestore.FieldEntry(this.docRef, fieldKey, pathType);
        childEntry = fieldObj.docSnapToEntry(docSnap);
      }

      if (childEntry) {
        childEntry.Name = childPath.slice(1);
        entry.Children.push(childEntry);
      }
    }
    return entry;
  }
  async get() {
    return this.docSnapToEntry(await this.getSnapshot('doc/get'));
  }
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      const state = new PublicationState(c);
      // TODO: check Depth
      // console.log('TODO FirestoreDocEntry#subscribe', {Depth}, this.subPaths)
      Datadog.countFireOp('stream', this.docRef, {fire_op: 'onSnapshot', method: 'doc/subscribe'});
      const stopSnapsCb = this.docRef.onSnapshot(docSnap => {
        Datadog.countFireOp('read', this.docRef, {fire_op: 'watched', method: 'doc/subscribe'});
        const entry = this.docSnapToEntry(docSnap);
        if (entry) {
          state.offerPath('', entry);
        } else {
          state.removePath('');
        }
        state.markReady();
      },
      error => {
        console.error('WARN: FirestoreDocEntry#subscribe snap error:',
            error.code, error.stack || error.message);
        state.markCrashed(error);
      });
      c.onStop(stopSnapsCb);
      // for (const entry of enumer.toOutput().Children) {
    });
  }
  async enumerate(enumer, knownDocSnap=null) {
    enumer.visit({Type: 'Folder'});
    if (enumer.canDescend()) {
      const docSnap = knownDocSnap || await this.getSnapshot('doc/enumerate');
      for (const childPath in this.subPaths) {
        enumer.descend(childPath.slice(1));

        const fieldKey = childPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
        const pathType = this.subPaths[childPath];

        // Functions named like a path are to be constructed with the current ref
        if (typeof pathType === 'function' && pathType.name.startsWith('/')) {
          const innerMapping = pathType(this.docRef);
          // TODO: this works around inners being either entries or mappings
          const fieldEntry = innerMapping.getEntry ? innerMapping.getEntry('') : innerMapping;
          if ('enumerate' in fieldEntry) {
            await fieldEntry.enumerate(enumer, {
              exists() { return docSnap.exists; },
              get(path) { return docSnap.get(childPath.slice(1))[path]; },
            });
          } else {
            console.warn('WARN: "enumerate" not impl by complex path', childPath);
          }
        } else {
          const fieldEntry = new Firestore.FieldEntry(this.docRef, fieldKey, pathType);
          await fieldEntry.enumerate(enumer, docSnap);
        }

        enumer.ascend();
      }
    }
    return;
  }
  entryToFieldValue(input) {
    if (!input) return null;
    if (input.Type !== 'Folder') throw new Error(`documents can't be put as non-folders`);
    // console.log('PUT', input, 'over', this.subPaths);
    const doc = {};
    for (const child of input.Children) {
      if (!child) continue;
      const pathType = this.subPaths['/'+child.Name];
      if (pathType == undefined) throw new Error(`no known type for field ${child.Name}`);
      const fieldKey = child.Name.replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
      switch (true) {
        case Number === pathType:
          doc[fieldKey] = parseFloat(child.StringValue);
          break;
        case Boolean === pathType:
          doc[fieldKey] = child.StringValue === 'yes';
          break;
        case Date === pathType:
          doc[fieldKey] = parseDateStringOrThrow(child.StringValue);
          break;
        case String === pathType:
          doc[fieldKey] = child.StringValue || '';
          break;
        case pathType.constructor === Array && pathType[0] === String:
          doc[fieldKey] = child.Children.map(x => x.StringValue || ''); // TODO: type check
          break;
        // Functions named like a path are to be constructed with the current ref
        case typeof pathType === 'function' && pathType.name.startsWith('/'):
          const innerMapping = pathType(this.docRef);
          if ('entryToFieldValue' in innerMapping) {
            doc[fieldKey] = innerMapping.entryToFieldValue(child);
          } else throw new Error(
            `unrecognized nested firestore mapping for ${child.Name}`);
          break;
        default:
          throw new Error(`unrecognized field type for ${child.Name}`);
      }
      console.log(child, pathType);
    }
    return doc;
  }
  async put(input) {
    if (!input) {
      // TODO: support deleting nested mappings, if any
      Datadog.countFireOp('write', this.docRef, {fire_op: 'delete', method: 'doc/put'});
      await this.docRef.delete();
      return;
    } else {
      const doc = this.entryToFieldValue(input);
      Datadog.countFireOp('write', this.docRef, {fire_op: 'set', method: 'doc/put'});
      await this.docRef.set(doc);
      // cache a fake snapshot
      if (cachableDocPathPattern.test(this.docRef.path)) {
        const fakeSnap = new Map;
        fakeSnap.exists = true;
        for (const key in doc) {
          if (doc[key] && doc[key].constructor === Date) {
            fakeSnap.set(key, {toDate(){return doc[key];}});
          } else {
            fakeSnap.set(key, doc[key]);
          }
        }
        console.log('caching fake snap', fakeSnap);
        docCache.set(this.docRef.path, fakeSnap);
      }
    }
  }
}

exports.DocMapping = class FirestoreDocMapping {
  constructor(docRef, subPaths) {
    this.docRef = docRef;
    this.subPaths = subPaths;
  }
  async getEntry(path) {
    console.log('Getting subpath', path, 'from document mapping');// with', this.subPaths);
    if (path === '') {
      return new Firestore.DocEntry(this.docRef, this.subPaths);
    }

    // quick check for direct lookups
    if (path in this.subPaths) {
      const fieldKey = path.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
      const pathType = this.subPaths[path];

      // Functions named like a path are to be constructed with the current ref
      if (typeof pathType === 'function' && pathType.name.startsWith('/')) {
        const innerMapping = pathType(this.docRef);
        return innerMapping.getEntry('');
      } else {
        return new Firestore.FieldEntry(this.docRef, fieldKey, pathType);
      }
    }

    // slower check for accessing children, if applicable
    for (const subPath of Object.keys(this.subPaths)) {
      if (path.startsWith(subPath+'/')) {
        const pathType = this.subPaths[subPath];
        // Functions named like a path are to be constructed with the current ref
        if (typeof pathType === 'function' && pathType.name.startsWith('/')) {
          const innerMapping = pathType(this.docRef);
          return innerMapping.getEntry(path.slice(subPath.length));
        } else {
          // support complex document fields like arrays
          const fieldKey = subPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
          const fieldEntry = new Firestore.FieldEntry(this.docRef, fieldKey, pathType);
          return fieldEntry.getEntry(path.slice(subPath.length));
        }
      }
    }
    return null;
  }
}

exports.CollEntry = class FirestoreCollEntry {
  constructor(collRef, subPaths) {
    this.collRef = collRef;
    this.subPaths = subPaths;
  }
  async get() {
    // we always exist
    return {Name: 'collection', Type: 'Folder'};
  }
  async enumerate(enumer) {
    enumer.visit({Type: 'Folder'});
    if (!enumer.canDescend()) return;

    const querySnap = await this.collRef.get();
    Datadog.countFireOp('read', this.collRef, {fire_op: 'getall', method: 'collection/get'}, querySnap.size||1);
    for (const queryDocSnap of querySnap.docs) {
      enumer.descend(queryDocSnap.id);
      if (enumer.canDescend()) {
        console.log('TODO: FirestoreCollEntry deep enumerate()');
      } else {
        enumer.visit({Type: 'Folder'});
      }
      enumer.ascend();
    }
  }
  // TODO: when should replacement be allowed? should put() ever be accumulative?
  // TODO: more latency-efficient impl
  // TODO: delete via DocumentMapping to handle sub-collections
  async put(input) {
    if (input) {
      if (input.Type !== 'Folder') throw new Error(
        `collections can't be put as non-folders`);
    }

    // first: delete everything
    const querySnap = await this.collRef.get();
    Datadog.countFireOp('read', this.collRef, {fire_op: 'getall', method: 'collection/put'}, querySnap.size||1);
    Datadog.countFireOp('write', this.collRef, {fire_op: 'delete', method: 'collection/put'}, querySnap.size);
    console.log('deleting', querySnap.size, 'entries from', this.collRef.path);
    for (const innerDoc of querySnap.docs) {
      await innerDoc.ref.delete();
    }

    // second: write everything
    if (input) {
      for (const entry of input.Children) {
        const docMapping = new Firestore.DocMapping(this.collRef.doc(entry.Name), this.subPaths);
        const docEntry = await docMapping.getEntry('');
        await docEntry.put(entry);
      }
      console.log('wrote', input.Children.length, 'entries into', this.collRef.path);
    }
  }
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      console.log({Depth})
      const state = new PublicationState(c);
      Datadog.countFireOp('stream', this.collRef, {fire_op: 'onSnapshot', method: 'collection/subscribe'});
      const stopSnapsCb = this.collRef.onSnapshot(querySnap => {
        state.offerPath('', {Type: 'Folder'});

        // console.log('onSnapshot', querySnap.docChanges());
        Datadog.countFireOp('read', this.collRef, {fire_op: 'watched', method: 'collection/subscribe'}, querySnap.docChanges().length);
        for (const docChange of querySnap.docChanges()) {
          switch (docChange.type) {
            case 'added':
            case 'modified':
              state.offerPath(docChange.doc.id, {Type: 'Folder'});
              if (Depth > 1) {
                for (const subPath in this.subPaths) {
                  const fieldKey = subPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
                  const fieldVal = docChange.doc.get(fieldKey);
                  const fieldPath = docChange.doc.id+subPath;
                  switch (true) {

                    case this.subPaths[subPath].constructor === Array && this.subPaths[subPath][0] === String:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'Folder',
                      });
                      if (Depth > 2) {
                        const aryMap = new Map;
                        (fieldVal||[]).forEach((innerVal, idx) => {
                          aryMap.set(`${idx+1}`, {
                            Type: 'String',
                            StringValue: innerVal,
                          });
                        });
                        state.offerPathChildren(fieldPath, aryMap);
                      }
                      break;

                    case this.subPaths[subPath] === String:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'String',
                        StringValue: fieldVal || '',
                      });
                      break;
                    case this.subPaths[subPath] === Boolean:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'String',
                        StringValue: fieldVal === undefined ? '' : (fieldVal ? 'yes' : 'no'),
                      });
                      break;
                    case this.subPaths[subPath] === Date:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'String',
                        StringValue: fieldVal === undefined ? '' : fieldVal.toDate().toISOString(),
                      });
                      break;
                    case this.subPaths[subPath] === Number:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'String',
                        StringValue: fieldVal === undefined ? '' : `${fieldVal}`,
                      });
                      break;
                    default:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'Error',
                        Code: 'unhandled-sub',
                        Authority: 'skychat-api/firestore-lib',
                        StringValue: `TODO: subscriptions on field ${fieldKey}`,
                      });
                      console.log('SUB TODO', fieldKey, subPath);
                      // fieldval
                      // this.subPaths[subPath] === fieldType
                  }
                }
              }
              break;
            case 'removed':
              state.removePath(docChange.doc.id);
              break;
            default:
              throw new Error(`weird docChange.type ${docChange.type}`);
          }
        }

        state.markReady();
      },
      error => {
        console.error('WARN: FirestoreDocEntry#subscribe snap error:',
            error.code, error.stack || error.message);
        state.markCrashed(error);
      });
      c.onStop(stopSnapsCb);

      // for (const entry of enumer.toOutput().Children) {
      //   const fullName = entry.Name;
      //   entry.Name = 'entry';
      // }
      // c.error(new StringEntry('nosub',
      //     `This entry does not implement reactive subscriptions`));
    });
  }
}

exports.CollMapping = class FirestoreCollMapping {
  constructor(collRef, subPaths) {
    this.collRef = collRef;
    this.subPaths = subPaths;
  }
  getEntry(path) {
    if (path === '') {
      console.log('Getting subpath', path, 'from collection mapping');// with', this.subPaths);
      return new Firestore.CollEntry(this.collRef, this.subPaths);
    }
    const slashIdx = path.indexOf('/', 1);
    const docId = path.slice(1, slashIdx < 0 ? undefined : slashIdx);

    const docMapping = new Firestore.DocMapping(this.collRef.doc(decodeURIComponent(docId)), this.subPaths);
    const subPath = path.slice(docId.length+1);
    // console.log('collection getEntry', {docId, subPath});
    return docMapping.getEntry(subPath);
  }
}
