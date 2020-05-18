window.orbiter = new Orbiter();
var promise = orbiter.autoLaunch()
  .then(() => {
    window.skylink = orbiter.mountTable.api;
    return window.skylink;
  }, err => {
    alert(`Couldn't open chart. Server said: ${err}`);
    throw err;
  });
window.skylinkP = promise;

// Little box of state for the user's session
var sessionApp = new Vue({
  data: {
    isReady: false,
    currentUser: null,
    // idToken: null,
  },
  methods: {
  },
  created() {
    domLoaded.then(() => {
      firebase.auth().onAuthStateChanged(user => {
        console.log({user});
        this.isReady = true;
        // this.idToken = null;

        if (user) {
          const {uid, displayName, photoURL, email, emailVerified, isAnonymous, metadata, providerData} = user;
          this.currentUser = {uid, displayName, photoURL, email, emailVerified, isAnonymous, metadata, providerData};
          // this.idToken = await user.getIdToken();
          // // TODO: set up orbiter
        } else {
          // TODO: probably support logging out of a running page
          if (this.currentUser) document.location.reload();
          this.currentUser = false;
        }
      });
    });
  },
});

Vue.component('sky-session', {
  data: () => ({
    orbiter: orbiter,
    launcher: orbiter.launcher,
    stats: {},
    session: sessionApp,
  }),
  created() {
    promise.then(() => this.stats = orbiter.skylink.stats);
  },
  methods: {
    signout() {
      firebase.auth().signOut();
    },
  },
  template: `
  <div class="sky-session">
    <div :class="'indicator status-'+orbiter.status" />
    {{orbiter.status}} &mdash;&nbsp;
    <span class="chart">{{launcher.chartName}}</span><!--@{{launcher.domainName}}-->/{{launcher.appId}}
    <div class="filler" />
    <div v-if="session.currentUser" style="padding: 0 0.4em;">
      {{session.currentUser.email}}
      <button type="button" @click="signout">signout</button>
    </div>
    <!--{{sess.ownerName}} | {{sess.uri}}-->
      {{stats.ops}}o
      {{stats.chans}}c
      {{stats.pkts}}p
      {{stats.fails}}f
  </div>`,
});

Vue.component('sky-auth-form', {
  data: () => ({
    isPending: false,
    banner: {},
    session: sessionApp,
  }),
  computed: {
    isVisible() {
      return this.session.currentUser === false;
    },
  },
  methods: {
    startGoogleLogin() {
      if (this.isPending) return;
      const provider = new firebase.auth.GoogleAuthProvider();
      firebase.auth()
        .signInWithPopup(provider)
        .catch(error => this.banner = {
          type: 'error',
          label: 'Error',
          message: error.message,
          code: error.code,
        })
        .then(() => this.isPending = false);
      this.isPending = true;

      this.banner = {
        type: 'info',
        label: 'Auth',
        message: 'Signing in...',
      };
    },
    submitLogin(evt) {
      if (this.isPending) return;
      firebase.auth()
        .signInWithEmailAndPassword(
          evt.target.email.value,
          evt.target.password.value)
        .catch(error => this.banner = {
          type: 'error',
          label: 'Error',
          message: error.message,
          code: error.code,
        })
        .then(() => this.isPending = false);
      this.isPending = true;

      this.banner = {
        type: 'info',
        label: 'Auth',
        message: 'Signing in...',
      };
    },
  },
  template: `
  <div class="sky-auth-form" v-if="isVisible">
    <div :class="banner.type+' banner'" v-if="banner.type">
      <div class="message">
        <strong>{{banner.label}}</strong>:
        {{banner.message}}
        <code v-if="banner.code">{{banner.code}}</code>
      </div>
    </div>

    <form class="modal-form" @submit.prevent="submitLogin">
      <h1>login to <em>skychat</em></h1>

      <!-- button grabbed from https://developers.google.com/identity/sign-in/web/build-button -->
      <div @click.prevent="startGoogleLogin" style="height:50px; margin: 0.25em 1em; font-size: 1.3em;" class="abcRioButton abcRioButtonBlue">
        <div class="abcRioButtonContentWrapper">
          <div class="abcRioButtonIcon" style="padding:15px">
            <div style="width:18px;height:18px;" class="abcRioButtonSvgImageWithFallback abcRioButtonIconImage abcRioButtonIconImage18"><svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="18px" height="18px" viewBox="0 0 48 48" class="abcRioButtonSvg"><g><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path><path fill="none" d="M0 0h48v48H0z"></path></g></svg></div>
          </div>
          <span style="font-size:16px;line-height:48px;" class="abcRioButtonContents">
            <span id="not_signed_in87ksyc5kakim">Sign in with Google</span>
            <span id="connected87ksyc5kakim" style="display:none">Signed in with Google</span>
          </span>
        </div>
      </div>

      <div style="align-self: center; margin: 1em;">
        &mdash; or &mdash;
      </div>

      <input :readonly="isPending" type="email" name="email" placeholder="email address" autocomplete="email" value="test@danopia.net" required autofocus>
      <input :readonly="isPending" type="password" name="password" placeholder="password" autocomplete="current-password" required>
      <button type="submit" :disabled="isPending">log in</button>
    </form>
    <!--div style="align-self: center;">
      <a href="#" @click="showRegister">or register a new account</a>
    </div-->

    <div class="fill"></div>
    <footer>
      powered by the Stardust platform,
      built by
      <a href="https://danopia.net">danopia</a>
    </footer>
  </div>
  `,
})

Vue.component('sky-form', {
  props: {
    action: String,
    path: String,
  },
  data() { return {
    status: 'Ready',
  }},
  methods: {
    submit(evt) {
      if (this.action != 'store-child-folder') {
        alert('invalid form action '+this.action);
        throw new Error('invalid form action');
      }

      // check for double-submit racing
      if (this.status == 'Pending') {
        console.warn('rejecting concurrent submission in sky-form');
        return;
      }

      this.status = 'Pending';
      // construct body to submit
      const {form} = this.$refs;
      const elems = [].slice.call(form.elements);
      const input = {};
      elems.forEach(el => {
        if (el.name) {
          input[el.name] = el.value;
        }
      });

      const setReadonly = (value) =>
        elems.forEach(el => {
          if (el.localName === 'input' && el.type !== 'checkbox') {
            el.readOnly = value;
          } else {
            el.disabled = value;
          }
        });

      switch (this.action) {

        case 'store-child-folder':
          setReadonly(true);
          console.log('submitting', input, 'to', '/'+this.path);
          promise.then(skylink => {
            skylink.mkdirp('/'+this.path)
              .then(() => skylink.storeRandom('/'+this.path, input))
              .then((id) => {
                setReadonly(false);
                evt.target.reset();
                this.status = 'Ready';
              }, (err) => {
                setReadonly(false);
                this.status = 'Failed';
                 throw err;
              });
          });
          break;

        case 'invoke-with-folder':
          setReadonly(true);
          console.log('submitting', input, 'to', '/'+this.path);
          promise.then(skylink => {
            skylink.invoke('/'+this.path, input)
              .then((id) => {
                setReadonly(false);
                evt.target.reset();
                this.status = 'Ready';
              }, (err) => {
                setReadonly(false);
                this.status = 'Failed';
                throw err;
              });
          });
          break;

        default:
          alert('bad sky-form action ' + this.action);
      }
    },
  },
  template: `<form ref="form" :class="'sky-form status-'+this.status" @submit.prevent="submit"><slot/></form>`,
});

Vue.component('sky-datetime-field', {
  props: {
    name: String,
    type: String,
  },
  computed: {
    value() {
      switch (this.type) {
        case 'current-timestamp':
          return new Date().toISOString();
        default:
          alert('bad sky-datetime-field type '+this.type);
          return null;
      }
    },
  },
  template: '<input type="hidden" :name="name" :value="value" />',
});

Vue.component('sky-foreach', {
  props: {
    path: String,
    el: String,
    filter: Object,
    fields: String,
    depth: Number,
  },
  data: () => ({
    items: [],
    stats: {},
    nonce: null,
  }),
  watch: {
    path(path) { this.switchTo(path) },
  },
  created() { this.switchTo(this.path) },
  destroyed() {
    if (this.sub) {
      this.sub.stop();
    }
  },
  methods: {
    switchTo(path) {
      if (this.sub) {
        this.sub.stop();
      }

      // TODO: fetch subs from cache
      console.log('updating sky-foreach to', path);
      this.items = [];
      const nonce = ++this.nonce;

      promise
        .then(skylink => skylink.subscribe('/'+this.path, {maxDepth: this.depth+1}))
        .then(chan => {
          if (this.nonce !== nonce) {
            console.warn('sky-foreach sub on', path, 'became ready, but was cancelled, ignoring');
            return;
          }
          this.nonce = null;

          const sub = new RecordSubscription(chan, {
            basePath: this.path,
            filter: this.filter,
            fields: this.fields.split(' '),
          });
          console.log('sky-foreach sub started');
          this.sub = sub;
          this.items = sub.items;
          this.stats = sub.stats;
        });
    },
  },
  template: `
  <component :is="el||'div'">
    <slot name="header"></slot>
    <slot v-for="item in items" name="item" v-bind="item"></slot>
    <slot v-if="stats.hidden" name="hiddenNotice" :count="stats.hidden"></slot>
  </component>`,
});

Vue.component('sky-action-checkbox', {
  props: {
    path: String,
    checkedValue: String,
  },
  methods: {
    onChange(evt) {
      const {checked} = evt.target;
      if (checked && this.checkedValue) {
        promise.then(x => x.putString('/'+this.path, this.checkedValue));
      }
    },
  },
  template: '<input type="checkbox" @click="onChange" />',
});

/*
Vue.component('sky-show', {
  props: {
    path: String,
  },
  template: '<div>{{path}}</div>',
});
*/

Vue.component('sky-with', {
  props: {
    path: String,
    el: String,
  },
  data: () => ({
    item: null,
    nonce: null,
  }),
  watch: {
    path(path) { this.switchTo(path) },
  },
  created() { this.switchTo(this.path) },
  destroyed() {
    if (this.sub) {
      this.sub.stop();
    }
  },
  methods: {
    switchTo(path) {
      if (this.sub) {
        this.sub.stop();
      }

      // TODO: fetch subs from cache
      console.log('updating sky-with to', path);
      this.item = null;
      const nonce = ++this.nonce;

      promise
        .then(skylink => skylink.subscribe('/'+path, {maxDepth: 1}))
        .then(chan => {
          const sub = new FlatSubscription(chan);
          this.sub = sub;
          return sub.readyPromise;
        })
        .then(fields => {
          if (this.nonce === nonce) {
            this.item = fields;
            this.nonce = null;
          } else {
            console.warn('sky-with sub on', path, 'became ready, but was cancelled, ignoring');
          }
        });
    },
  },
  template: `
  <component :is="el||'div'">
    <slot v-bind="item"></slot>
  </component>`,
});

Vue.mixin({
  methods: {
    skyStoreString(path, value) {
      return promise.then(x => x.putString('/'+path, value));
    },

    // TODO: the sidebar should handle this itself probably, close-on-navigate
    closeNav(evt) {
      const {classList} = document.querySelector('#left-menu');
      if (classList.contains('open')) {
        classList.add('animate');
        classList.remove('open');
      }
    },
  }
});

var router;
if (window.appRouter) {
  router = appRouter;
} else if (window.VueRouter) {
  console.warn(`Creating blank vue router`);
  router = new VueRouter({
    mode: 'hash',
    routes: [
      //{ name: 'context', path: '/network/:network/context/:type/:context', component: ViewContext },
    ],
  });
}

var app = new Vue({
  el: '#app',
  router,
  data: {
    dataPath: '/persist',
    prefs: {},
    ready: false,
  },
  methods: {
  },
  mounted() {
    // apply userstyle.css from persist/<app>/prefs/
    let style = document.createElement('style');
    style.type = 'text/css';
    style.appendChild(document.createTextNode(''));
    document.head.appendChild(style);
    this.userStyleTag = style;
  },
  computed: {
    userStyle() {
      const blob = this.prefs['userstyle.css'];
      if (blob) { return blob.asText(); }
    },
  },
  watch: {
    userStyle(css) {
      if (this.userStyleTag) {
        this.userStyleTag.childNodes[0].textContent = css;
      }
    },
  },
  created() {
    // TODO: i think something else sets this later
    window.app = this;

    promise.then(() => {
      skylink.subscribe(`/config/${orbiter.launcher.appId}/prefs`, {
        maxDepth: 1,
      }).then(chan => {
        const prefChan = chan.channel.map(ent => {
          if (ent.path) {
            ent.path = ent.path.replace(/-(.)/g, (_, char) => char.toUpperCase());
          }
          return ent;
        });
        const sub = new FlatSubscription({
          channel: prefChan,
          stop: chan.stop.bind(chan),
        }, this);
        this.prefSub = sub;
        return sub.readyPromise;
      }).then(prefs => {
        this.prefs = prefs;
      }).finally(() => {
        this.ready = true;
      });
    });
  },
});

// provide helper to set a temp pref
window.setPref = (prefName, value) => {
  app.$set(app.prefs, prefName, value || '');
};
