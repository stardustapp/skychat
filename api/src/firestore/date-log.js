const Firestore = require('./../firestore-lib.js');

// exports.CollEntry = class FirestoreCollEntry {
//   constructor(collRef, subPaths) {
//     this.collRef = collRef;
//     this.subPaths = subPaths;
//   }
//   async get() {
//     // we always exist
//     return {Name: 'collection', Type: 'Folder'};
//   }
//   async enumerate(enumer) {
//     enumer.visit({Type: 'Folder'});
//     if (!enumer.canDescend()) return;
//
//     const querySnap = await this.collRef.get();
//     for (const queryDocSnap of querySnap.docs) {
//       enumer.descend(queryDocSnap.id);
//       if (enumer.canDescend()) {
//         console.log('TODO: FirestoreCollEntry deep enumerate()');
//       } else {
//         enumer.visit({Type: 'Folder'});
//       }
//       enumer.ascend();
//     }
//   }
//   subscribe(Depth, newChannel) {
//     return newChannel.invoke(async c => {
//       console.log({Depth})
//       const state = new PublicationState(c);
//       // TODO: support cancelling the snapshot
//       this.collRef.onSnapshot(querySnap => {
//         state.offerPath('', {Type: 'Folder'});
//
//         // console.log('onSnapshot', querySnap.docChanges());
//         for (const docChange of querySnap.docChanges()) {
//           switch (docChange.type) {
//             case 'added':
//             case 'modified':
//               state.offerPath(docChange.doc.id, {Type: 'Folder'});
//               if (Depth > 1) {
//                 for (const subPath in this.subPaths) {
//                   const fieldKey = subPath.slice(1).replace(/-[a-z]/g, s=>s.slice(1).toUpperCase());
//                   const fieldVal = docChange.doc.get(fieldKey);
//                   const fieldPath = docChange.doc.id+subPath;
//                   switch (true) {
//
//                     case this.subPaths[subPath].constructor === Array && this.subPaths[subPath][0] === String:
//                       state.offerPath(fieldPath, {
//                         Name: subPath.slice(1),
//                         Type: 'Folder',
//                       });
//                       if (Depth > 2) {
//                         const aryMap = new Map;
//                         (fieldVal||[]).forEach((innerVal, idx) => {
//                           aryMap.set(`${idx+1}`, {
//                             Type: 'String',
//                             StringValue: innerVal,
//                           });
//                         });
//                         state.offerPathChildren(fieldPath, aryMap);
//                       }
//                       break;
//
//                     case this.subPaths[subPath] === String:
//                       state.offerPath(fieldPath, {
//                         Name: subPath.slice(1),
//                         Type: 'String',
//                         StringValue: fieldVal || '',
//                       });
//                       break;
//                     case this.subPaths[subPath] === Boolean:
//                       state.offerPath(fieldPath, {
//                         Name: subPath.slice(1),
//                         Type: 'String',
//                         StringValue: fieldVal === undefined ? '' : (fieldVal ? 'yes' : 'no'),
//                       });
//                       break;
//                     case this.subPaths[subPath] === Number:
//                       state.offerPath(fieldPath, {
//                         Name: subPath.slice(1),
//                         Type: 'String',
//                         StringValue: fieldVal === undefined ? '' : `${fieldVal}`,
//                       });
//                       break;
//                     default:
//                       console.log('SUB TODO', fieldKey, subPath, fieldVal, this.subPaths[subPath]);
//                   }
//                 }
//               }
//               break;
//             case 'removed':
//               state.removePath(docChange.doc.id);
//               break;
//             default:
//               throw new Error(`weird docChange.type ${docChange.type}`);
//           }
//         }
//
//         state.markReady();
//       },
//       error => {
//         console.error('WARN: FirestoreDocEntry#subscribe snap error:',
//             err.code, err.stack || err.message);
//         state.markCrashed(error);
//       });
//
//       // for (const entry of enumer.toOutput().Children) {
//       //   const fullName = entry.Name;
//       //   entry.Name = 'entry';
//       // }
//       // c.error(new StringLiteral('nosub',
//       //     `This entry does not implement reactive subscriptions`));
//     });
//   }
// }

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const indexRegex = /^\d+$/;

class DatePartitionedLog {
  constructor(docRef, docSubPaths) {
    this.docRef = docRef;
    this.docSubPaths = docSubPaths;
  }
  getEntry(path) {
    const parts = path.slice(1).split('/');
    const [partition, index, ...rest] = parts;

    const isValidDate = partition ? dateRegex.test(partition) : false;
    const isValidIndex = index ? indexRegex.test(index) : false;

    switch (true) {

      case path === '':
        return {
          get() {
            return {Type: 'Folder'};
          },
        };
        throw new Error(`TODO: Log root`);

      // TODO: validate that these are date-ish (w/ the regex)
      case parts.length === 1 && partition === 'horizon':
        return new Firestore.FieldEntry(this.docRef, 'logHorizon', String);
      case parts.length === 1 && partition === 'latest':
        return new Firestore.FieldEntry(this.docRef, 'logLatest', String);

      case parts.length === 1 && isValidDate:
        return {
          get() {
            return {Type: 'Folder'};
          },
        };
        throw new Error(`TODO: Log part root`);

      case parts.length === 2 && isValidDate && index === 'horizon':
        return new Firestore.FieldEntry(this.docRef
          .collection('partitions')
          .doc(partition)
        , 'logHorizon', Number);
      case parts.length === 2 && isValidDate && index === 'latest':
        return new Firestore.FieldEntry(this.docRef
          .collection('partitions')
          .doc(partition)
        , 'logLatest', Number);

      case parts.length > 2:
        throw new Error(`TODO: Log part entry subpathing`);

      case parts.length >= 2 && isValidDate && isValidIndex:
        return new Firestore.DocEntry(this.docRef
          .collection('partitions')
          .doc(partition)
          .collection('entries')
          .doc(index)
        , this.docSubPaths);

      default:
        throw new Error(`TODO: Log default`);
    }

    // if (path === '') {
    //   console.log('Getting subpath', path, 'from collection mapping');// with', this.subPaths);
    //   return new Firestore.CollEntry(this.collRef, this.subPaths);
    // }
    // const slashIdx = path.indexOf('/', 1);
    // const docId = path.slice(1, slashIdx < 0 ? undefined : slashIdx);
    //
    // const docMapping = new Firestore.DocMapping(this.collRef.doc(docId), this.subPaths);
    // const subPath = path.slice(docId.length+1);
    // // console.log('collection getEntry', {docId, subPath});
    // return docMapping.getEntry(subPath);
  }
}

module.exports = {
  DatePartitionedLog,
};
