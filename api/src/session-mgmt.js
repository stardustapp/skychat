const {AsyncCache} = require('@dustjs/standard-machine-rt');

exports.SessionMgmt =
class SessionMgmt {
  constructor(rootRef, sessionLoader) {
    this.rootRef = rootRef;

    this.sessionCache = new AsyncCache({
      loadFunc: async sessId => {
        const sessRef = this.rootRef.doc(sessId);
        console.log('>> firestore get', 'session/load', sessRef.path);
        const sessData = await sessRef.get();
        // console.log([sessRef, sessData]);
        return sessionLoader(sessData);
      },
    });
  }

  async createSession(uid, metadata={}) {
    const now = new Date;
    console.log('>> firestore add', 'session/create', this.rootRef.path);
    const sessionRef = await this.rootRef.add({
      uid, ...metadata,
      createdAt: now,
      expiresAt: new Date(+now + (1/*days*/ * 24 * 60 * 60 * 1000)),
    });
    return sessionRef.id;
  }

  async getEntry(path) {
    if (path.length < 2) return null;
    const secondSlash = path.indexOf('/', 1);
    if (secondSlash < 2) return null;
    const sessionId = path.slice(1, secondSlash);
    const subPath = path.slice(secondSlash);
    // console.log('session access:', sessionId, subPath);

    const session = await this.sessionCache.get(sessionId);
    return await session.env.getEntry(subPath);
  }

    // // direct name, load it up
    // const domainRef = this
    //   .adminApp.firestore()
    //   .collection('domains')
    //   .doc(fqdn);
}
