const Firestore = exports;

const {FolderLiteral, StringLiteral, BlobLiteral, InflateSkylinkLiteral}
  = require('@dustjs/standard-machine-rt/src/old/core/api-entries.js');
// FIXME: patches bug in core-ops.js
const {EnumerateIntoSubscription} = require('@dustjs/standard-machine-rt/src/old/core/enumeration.js');
global.EnumerateIntoSubscription = EnumerateIntoSubscription;
// FIXME: patches bug in ext-channel.js
global.StringLiteral = StringLiteral;

class PublicationState {
  constructor(chanApi) {
    this.chanApi = chanApi;
    this.sentPaths = new Map;
    this.isReady = false;
  }
  markCrashed(err) {
    this.chanApi.error(new FolderLiteral('error', [
      new StringLiteral('type', 'Error'),
      new StringLiteral('message', err.message),
      new StringLiteral('name', err.name),
    ]));
    this.chanApi = null;
  }
  markDone() {
    this.chanApi.done();
    this.chanApi = null;
  }
  markReady() {
    if (this.isReady) return;
    this.chanApi.next(new FolderLiteral('notif', [
      new StringLiteral('type', 'Ready'),
    ]));
    this.isReady = true;
  }
  removePath(path) {
    const exists = this.sentPaths.has(path);
    if (!exists) return;
    // throw new Error(`TODO: walk sentPaths to remove all children of ${path}`);
    this.chanApi.next(new FolderLiteral('notif', [
      new StringLiteral('type', 'Removed'),
      new StringLiteral('path', path),
    ]));
    this.sentPaths.delete(path);

    // walk what we've sent looking for any children, to remove
    const childPathPrefix = path ? `${path}/` : ``;
    for (const [knownPath] of this.sentPaths) {
      if (path !== knownPath && knownPath.startsWith(childPathPrefix)) {
        // TODO: do we actually need to transmit child removals? clients can assume them
        this.chanApi.next(new FolderLiteral('notif', [
          new StringLiteral('type', 'Removed'),
          new StringLiteral('path', knownPath),
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

    this.chanApi.next(new FolderLiteral('notif', [
      new StringLiteral('type', exists ? 'Changed' : 'Added'),
      new StringLiteral('path', path),
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
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);
  }
  async put(input) {
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
      case this.dataType === String:
        return {Type: 'String', StringValue: fieldValue};
      case this.dataType.Type === 'Blob':
        throw new Error(`TODO: docSnapToEntry() for Blob types`);
      default:
        throw new Error(`TODO: docSnapToEntry() default case`);
    }
  }
  async get() {
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);
  }
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      const state = new PublicationState(c);
      // TODO: check Depth
      // console.log('TODO FirestoreFieldEntry#subscribe', {Depth}, this.fieldPath);
      // TODO: support cancelling the snapshot: c.onStop(()=>{})
      const stopSnapsCb = this.docRef.onSnapshot(docSnap => {
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
            err.code, err.stack || err.message);
        state.markCrashed(error);
      });
    });
  }
  async enumerate(enumer, knownDocSnap=null) {
    switch (true) {

      // 'primitive' types (never have children)
      case [Array,Number,Boolean,Date,String].includes(this.dataType):
        let docSnap = knownDocSnap || await this.docRef.get();
        let entry = this.docSnapToEntry(docSnap);
        if (entry) {
          enumer.visit(entry);
        }
        break;

      case this.dataType.constructor === Array && this.dataType[0] === String:
        enumer.visit({Type: 'Folder'});
        if (enumer.canDescend()) {
          const docSnap = knownDocSnap || await this.docRef.get();
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

      case this.dataType === Number:
        if (input.Type !== 'String') throw new Error(
          `number fields must be put as String entries`);
        doc[this.fieldPath] = parseFloat(input.StringValue);
        break;

      default:
        throw new Error(`unrecognized put field type for ${this.fieldPath}`);
    }

    console.log('setting fields', doc, 'on', this.docRef.path);
    await this.docRef.set(doc, {
      mergeFields: [this.fieldPath],
    });
  }
}

exports.DocEntry = class FirestoreDocEntry {
  constructor(docRef, subPaths) {
    this.docRef = docRef;
    this.subPaths = subPaths;
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
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);
  }
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      const state = new PublicationState(c);
      // TODO: check Depth
      // console.log('TODO FirestoreDocEntry#subscribe', {Depth}, this.subPaths)
      // TODO: support cancelling the snapshot: c.onStop(()=>{})
      const stopSnapsCb = this.docRef.onSnapshot(docSnap => {
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
      // for (const entry of enumer.toOutput().Children) {
    });
  }
  async enumerate(enumer) {
    enumer.visit({Type: 'Folder'});
    if (enumer.canDescend()) {
      const docSnap = await this.docRef.get();
      for (const childPath in this.subPaths) {
        enumer.descend(childPath.slice(1));

        const fieldKey = childPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
        const pathType = this.subPaths[childPath];

        // Functions named like a path are to be constructed with the current ref
        if (typeof pathType === 'function' && pathType.name.startsWith('/')) {
          const innerMapping = pathType(this.docRef);
          const fieldEntry = innerMapping.getEntry('');
          if ('enumerate' in fieldEntry) {
            await fieldEntry.enumerate(enumer, docSnap);
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
  async put(input) {
    if (!input) throw new Error(`TODO: document deletion`);
    if (input.Type !== 'Folder') throw new Error(`documents can't be put as non-folders`);
    // console.log('PUT', input, 'over', this.subPaths);
    const doc = {};
    for (const child of input.Children) {
      if (!child) continue;
      const pathType = this.subPaths['/'+child.Name];
      if (pathType == undefined) throw new Error(`no known type for field ${child.Name}`);
      const fieldKey = child.Name.replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
      switch (true) {
        case Boolean === pathType:
          doc[fieldKey] = child.StringValue === 'yes';
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
    console.log('writing to', this.docRef.path);
    await this.docRef.set(doc);
    // console.log('hmm...', doc);
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
  subscribe(Depth, newChannel) {
    return newChannel.invoke(async c => {
      console.log({Depth})
      const state = new PublicationState(c);
      // TODO: support cancelling the snapshot
      this.collRef.onSnapshot(querySnap => {
        state.offerPath('', {Type: 'Folder'});

        // console.log('onSnapshot', querySnap.docChanges());
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
                    case this.subPaths[subPath] === Number:
                      state.offerPath(fieldPath, {
                        Name: subPath.slice(1),
                        Type: 'String',
                        StringValue: fieldVal === undefined ? '' : `${fieldVal}`,
                      });
                      break;
                    default:
                      console.log('SUB TODO', fieldKey, subPath, fieldVal, this.subPaths[subPath]);
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
            err.code, err.stack || err.message);
        state.markCrashed(error);
      });

      // for (const entry of enumer.toOutput().Children) {
      //   const fullName = entry.Name;
      //   entry.Name = 'entry';
      // }
      // c.error(new StringLiteral('nosub',
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

    const docMapping = new Firestore.DocMapping(this.collRef.doc(docId), this.subPaths);
    const subPath = path.slice(docId.length+1);
    // console.log('collection getEntry', {docId, subPath});
    return docMapping.getEntry(subPath);
  }
}
