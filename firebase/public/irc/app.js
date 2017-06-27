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
  },
  created() {
    chanLink
      .loadString('/chan-name')
      .then(x => this.channel = x);
  },
  methods: {
    switchChannel(newChan) {
      return skylink
        .invoke('/tmp/freenode/get-channel/invoke',
                Skylink.String('channel', newChan),
                '/tmp/irc-channel')
        .then(() => {
          this.channel = newChan;
        }, err => {
          alert("get-channel failed.\n\n" + err.stack);
        });
    }
  },
});
