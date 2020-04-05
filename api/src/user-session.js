const {Environment} = require('@dustjs/skylink');

const Firestore = require('./firestore-lib.js');
const {DatePartitionedLog} = require('./firestore/date-log.js');
const {StringMapField} = require('./firestore/string-map.js');

class UserSession {
  constructor(sessId, userId, authority, userRef) {
    this.sessId = sessId;
    this.userId = userId;
    this.authority = authority;
    this.userRef = userRef;

    this.env = new Environment;
    this.env.bind('/mnt/config/panel/prefs', new Firestore.DocMapping(userRef
      .collection('config')
      .doc('panel')
    , {
      '/userstyle.css': {Type: 'Blob', Mime:'text/css'},
    }));
    this.env.bind('/mnt/config/irc/prefs', new Firestore.DocMapping(userRef
      .collection('config')
      .doc('irc')
    , {
      '/userstyle.css': {Type: 'Blob', Mime:'text/css'},
      '/layout': String,
      '/disable-nicklist': Boolean,
      '/enable-notifs': Boolean,
    }));

    this.env.bind('/mnt/config/irc/networks', new Firestore.CollMapping(userRef
      .collection('config')
      .doc('irc')
      .collection('networks')
    , {
      '/auto-connect': Boolean,
      '/channels': [String],
      '/full-name': String,
      '/hostname': String,
      '/ident': String,
      '/nickname': String,
      '/nickserv-pass': String,
      '/port': Number,
      '/use-tls': Boolean,
      '/username': String,
    }));

    // Reused by various things that contain IRC logs
    const ircEventMapping = {
      // internal usage
      '/source': String, // where the event came from
      '/timestamp': Date, // when the event was observed
      // for events that weren't ever actual IRC (dialing, etc)
      // TODO: just synthesize fake IRC events lol
      '/sender': String,
      '/text': String,
      // standard IRC protocol fields
      '/prefix-name': String,
      '/prefix-user': String,
      '/prefix-host': String,
      '/command': String,
      '/params': [String],
      // IRCv3 addon metadata
      '/tags': entryRef => new StringMapField(entryRef, 'tags', String),
    };

    this.env.bind('/mnt/persist/irc/networks', new Firestore.CollMapping(userRef
      .collection('irc networks')
    , {
      '/avail-chan-modes': String,
      '/avail-user-modes': String,
      '/current-nick': String,
      '/latest-seen': String,
      '/paramed-chan-modes': String,
      '/server-hostname': String,
      '/server-software': String,
      '/umodes': String,
      '/wire-checkpoint': Number,
      '/wire-uri': String,

      '/channels': networkRef => new Firestore.CollMapping(networkRef
        .collection('channels')
      , {
        '/is-joined': Boolean,
        '/latest-activity': String,
        '/latest-mention': String,
        '/latest-seen': String,

        '/log': channelRef => new DatePartitionedLog(channelRef, ircEventMapping),
        '/membership': channelRef => new Firestore.CollMapping(channelRef
          .collection('members')
        , {
          '/host': String,
          '/nick': String,
          '/since': Date,
          '/user': String,
          '/modes': String,
          '/prefix': String,
        }),
        '/modes': channelRef => new StringMapField(channelRef, 'modes', String),
        '/topic': channelRef => new Firestore.DocMapping(channelRef, {
          '/latest': String,
          '/set-at': Date,
          '/set-by': String,
        }),
        // '/topic/latest': String,
        // '/topic/set-at': Date,
        // '/topic/set-by': String,
      }),

      '/queries': networkRef => new Firestore.CollMapping(networkRef
        .collection('queries')
      , {
        '/latest-activity': String,
        // '/latest-mention': String,
        '/latest-seen': String,

        '/log': queryRef => new DatePartitionedLog(queryRef, ircEventMapping),
      }),

      // TODO: graduate into a proper context
      '/mention-log': networkRef => new DatePartitionedLog(networkRef
        .collection('logs')
        .doc('mentions')
      , {
        '/location': String,
        '/sender': String,
        '/text': String,
        '/timestamp': String,
        // TODO: /raw used to be a hardlink
        '/raw': entryRef => new Firestore.DocMapping(entryRef, ircEventMapping),
      }),

      // TODO: graduate into a proper context
      '/server-log': networkRef => new DatePartitionedLog(networkRef
        .collection('logs')
        .doc('server')
      , ircEventMapping),

      '/supported': entryRef => new StringMapField(entryRef, 'supported', String),
    }));
  }
}

module.exports = {
  UserSession,
};
