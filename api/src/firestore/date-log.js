const Firestore = require('./../firestore-lib.js');

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
