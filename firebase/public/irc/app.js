const skylink = new Skylink();
const chanLink = new Skylink('/tmp/irc-channel');

Vue.component('send-message', {
  template: '#send-message',
  data() {
    return {
      message: '',
    };
  },
  methods: {
    submit() {
      var match;
      if (match = this.message.match(/^\/w (#[^ ]+)$/)) {
        return app
          .switchChannel(match[1])
          .then(() => this.message = '');
      }
      if (this.message === '/join') {
        chanLink
          .invoke('/join/invoke')
          .then(() => {
            this.message = '';
            alert('joined!');
          });
         return
      }

      chanLink
        .invoke('/send-message/invoke',
                Skylink.String('message',
                               this.message))
        .then(() => {
          this.message = '';
        });
    },
  },
});

var app = new Vue({
  el: '#app',
  data: {
    channel: '',
    scrollback: ['none yet'],
  },
  created() {
    chanLink
      .loadString('/chan-name')
      .then(x => this.channel = x);
    setInterval(this.updateLog.bind(this), 2500);
  },
  methods: {

    updateLog() {
      if (!this.channel) return;
      chanLink
        .invoke('/get-messages/invoke')
        .then(x => this.scrollback = x.StringValue.split('\n'));
    },

    connect() {
      return skylink
        .invoke('/n/irc-client/pub/open/invoke', Skylink.Folder('input', [
                  Skylink.String('hostname', 'chat.freenode.net'),
                  Skylink.String('port', '6667'),
                  Skylink.String('nickname', 'dan[sd]'),
                  Skylink.String('username', 'danopia'),
                  Skylink.String('realname', 'danopia'),
                  Skylink.String('password', ''),
                ]), '/tmp/irc-freenode')
        .then(() => {
          alert('Connected, I guess');
        }, err => {
          alert("irc-client/open failed.\n\n" + err.stack);
        });
    },

    switchChannel(newChan) {
      return skylink
        .invoke('/tmp/irc-freenode/get-channel/invoke',
                Skylink.String('channel', newChan),
                '/tmp/irc-channel')
        .then(() => {
          this.channel = newChan;
        }, err => {
          alert("get-channel failed.\n\n" + err.stack);
        });
    },
  },
});
