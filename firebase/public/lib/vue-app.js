window.orbiter = new Orbiter();
var promise = orbiter.autoLaunch()
  .then(() => {
    window.skylink = orbiter.skylink;
    return window.skylink
  }, err => {
    alert(`Couldn't open chart. Server said: ${err}`);
  });

Vue.component('sky-session', {
  data: () => ({
    orbiter: orbiter,
    launcher: orbiter.launcher,
    stats: {},
  }),
  created() {
    promise.then(x => this.stats = x.stats);
  },
  template: `
  <div class="sky-session">
    <div :class="'indicator status-'+orbiter.status" />
    <span class="chart">{{launcher.chartName}}</span>@{{launcher.domainName}}/{{launcher.appId}}
    <div class="filler" />
    <!--{{sess.ownerName}} | {{sess.uri}}-->
      {{stats.ops}} ops
    | {{stats.chans}} chans
    | {{stats.pkts}} pkts
    | {{stats.fails}} fails
  </div>`,
});

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

      switch (this.action) {

        case 'store-child-folder':
          console.log('submitting', input, 'to', '/'+this.path);
          promise.then(skylink => {
            skylink.mkdirp('/'+this.path)
              .then(() => skylink.storeRandom('/'+this.path, input))
              .then((id) => {
                evt.target.reset();
                this.status = 'Ready';
              }, (err) => {
                this.status = 'Failed';
                throw err;
              });
          });
          break;

        case 'invoke-with-folder':
          console.log('submitting', input, 'to', '/'+this.path);
          promise.then(skylink => {
            skylink.invoke('/'+this.path, input)
              .then((id) => {
                evt.target.reset();
                this.status = 'Ready';
              }, (err) => {
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
        .then(skylink => skylink.subscribe('/'+this.path, {maxDepth: 2}))
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
      promise.then(x => x.putString('/'+path, value));
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
  },
  methods: {
  },
  created() {
  },
});