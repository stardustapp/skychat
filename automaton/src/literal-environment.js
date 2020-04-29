const {PathFragment} = require('@dustjs/skylink');

/// Read-only Environment that just lets you poke at a literal
class LiteralEnvironment {
  constructor(literal) {
    this.rootLiteral = literal;
  }

  getEntry(rawPath) {
    if (this.rootLiteral === null) {
      return null;
    }

    const path = PathFragment.parse(rawPath);
    let entry = this.rootLiteral;

    for (const part of path.parts) {
      if (entry.Children) {
        entry = entry.Children.find(x => x.Name === decodeURIComponent(part));
      // } else if (entry.getEntry) {
      //   return entry.TODO
      } else {
        entry = null;
      }
      if (!entry) throw new Error(
        `getEntry("${rawPath}") missed at "${part}"`);
    }

    return new LiteralEntry(entry);
  }
}

class LiteralEntry {
  constructor(literal) {
    this.literal = literal;
  }

  get() {
    return this.literal;
  }

  enumerate(enumer) {
    if (this.literal.Type === 'Folder') {
      enumer.visit({Type: 'Folder'});
      if (enumer.canDescend()) {
        for (const child of this.literal.Children) {
          enumer.descend(child.Name);
          new LiteralEntry(child).enumerate(enumer);
          enumer.ascend();
        }
      }
    } else {
      enumer.visit(this.literal);
    }
  }
}

module.exports = {
  LiteralEnvironment,
};
