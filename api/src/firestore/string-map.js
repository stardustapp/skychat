class StringMapElementEntry {
  constructor(docRef, fieldName, keyName, dataType) {
    this.docRef = docRef;
    this.fieldName = fieldName;
    this.keyName = keyName;
    this.dataType = dataType;
  }
  docSnapToEntry(docSnap) {
    const fieldValue = docSnap.get(this.fieldName);
    const elemValue = (fieldValue || {})[this.keyName];

    switch (true) {
      case elemValue == null:
        return null;
      case this.dataType === String:
        return {Type: 'String', StringValue: `${elemValue}`};
      default:
        throw new Error(`TODO: StringMapElementEntry docSnapToEntry() default case`);
    }
  }
  async get() {
    const docSnap = await this.docRef.get();
    return this.docSnapToEntry(docSnap);docSnapToEntry
  }
  async put(input) {
    const docSnap = await this.docRef.get();
    const array = docSnap.get(this.fieldName) || {};

    // support deletion
    switch (true) {

      case input == null:
        delete array[this.keyName];
        break;

      case this.dataType === String:
        if (input.Type !== 'String') throw new Error(
          `string fields must be put as String entries`);
        array[this.keyName] = input.StringValue || '';
        break;

      default:
        throw new Error(`unrecognized put field type for element of ${this.fieldName}`);
    }

    const doc = {};
    doc[this.fieldName] = array;

    console.log('setting fields', doc, 'on', this.docRef.path);
    await this.docRef.set(doc, {
      mergeFields: [this.fieldName],
    });
  }
}

class StringMapField {
  constructor(docRef, fieldName, valueType) {
    this.docRef = docRef;
    this.fieldName = fieldName;
    this.valueType = valueType;

    if (valueType !== String) throw new Error(
      `TODO: StringMapField only supports String valueType`);
  }

  getEntry(path) {
    const parts = path.split('/').slice(1);
    if (parts.length === 1) {
      return new StringMapElementEntry(this.docRef, this.fieldName, decodeURIComponent(parts[0]), this.valueType);
    }
    if (path !== '') throw new Error(
      `TODO: StringMapField child entries (for "${path}")`);

    return {

      get() {
        return {Type: 'Folder'};
      },

      enumerate: (enumer, docSnap) => {
        console.log(this.fieldName, this.valueType, docSnap.get(this.fieldName));
        // throw new Error(`TODO: StringMapField root enumerate()`);
      },

      put: async (entry) => {
        const doc = {};
        doc[this.fieldName] = entry
          ? this.entryToFieldValue(entry)
          : null;

        await this.docRef.set(doc, {
          mergeFields: [this.fieldName],
        });
      },
    };
  }

  entryToFieldValue(entry) {
    if (entry.Type !== 'Folder') throw new Error(
      `StringMapField given non-Folder "${entry.Type}"`);

    const value = {};
    for (const child of entry.Children) {
      value[child.Name] = child.StringValue;
    }
    return value;
  }
}

module.exports = {
  StringMapField,
};
