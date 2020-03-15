const path = require('path');
const fs = require('fs').promises;

class FilesystemDevice {
  constructor(fsRoot) {
    this.fsRoot = path.resolve(fsRoot);
  }

  getEntry(subPath) {
    const realPath = path.resolve(this.fsRoot, subPath.slice(1));
    if (realPath === this.fsRoot || realPath.startsWith(this.fsRoot+'/')) {
      return new FilesystemEntry(realPath);
    } else throw new Error(
      `Security Exception: FilesystemDevice refused subPath "${subPath}"`);
  }

  static fromUri(uri) {
    if (!uri.startsWith('file://')) throw new Error(
      `BUG: FilesystemDevice given non-file:// URI of scheme "${uri.split('://')[0]}"`);

    return new FilesystemDevice(uri.slice(7));
  }
}

class FilesystemEntry {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }

  async get() {
    const stat = await fs.stat(this.fsPath);
    switch (true) {

      case stat.isFile():
        return {
          Type: 'Blob',
          Mime: 'application/octet-stream',
          Data: await fs.readFile(this.fsPath, {encoding: 'base64'}),
        };

      case stat.isDirectory():
        return {Type: 'Folder'};

      default: throw new Error(
        `BUG: Stat of "${fsPath}" was unidentified`);
    }
  }

  // async enumerate(enumer) {
  //   const response = await this.remote.volley({
  //     Op: 'enumerate',
  //     Path: this.path||'/',
  //     Depth: enumer.remainingDepth(),
  //   });
  //   if (!response.Ok) throw response;
  //
  //   // transclude the remote enumeration
  //   enumer.visitEnumeration(response.Output);
  // }
  //
  // async put(value) {
  //   const response = await this.remote.volley((value === null) ? {
  //     Op: 'unlink',
  //     Path: this.path,
  //   } : {
  //     Op: 'store',
  //     Dest: this.path,
  //     Input: value,
  //   });
  //   if (!response.Ok) throw response;
  // }
  //
  // async invoke(value) {
  //   const response = await this.remote.volley({
  //     Op: 'invoke',
  //     Path: this.path,
  //     Input: value,
  //   });
  //   if (!response.Ok) throw response;
  //   return response.Output;
  // }

  // async subscribe(depth, newChan) {
  //   const response = await this.remote.volley({
  //     Op: 'subscribe',
  //     Path: this.path,
  //     Depth: depth,
  //   });
  //   return response.Output;
  // }
}

module.exports = {
  FilesystemDevice,
  FilesystemEntry,
};
