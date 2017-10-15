// Discover appId from app's HTML document
const appIdMeta = document.querySelector('meta[name=x-stardust-appid]');
if (!(appIdMeta && appIdMeta.content)) {
  alert('Application error: AppID meta tag is not specified');
  throw new Error('add <meta name=x-stardust-appid ...> tag');
}
const appId = appIdMeta.content;

// Discover chartName from current URL
if (location.pathname.startsWith('/~~')) {
  throw new Error("Core routes don't have a chart");
} else if (!location.pathname.startsWith('/~')) {
  throw new Error("Unscoped routes don't have a chart");
}
const chartName = location.pathname.split('/')[1].slice(1);

// Discover saved secret from localStorage, if any
var secret;
const secretKey = `skychart.${chartName}.secret`;
if (localStorage[secretKey]) {
  secret = Skylink.String('secret', localStorage[secretKey]);
}

console.log('Configuring chart', chartName, '- app', appId);

const session = {
  status: 'Pending',

  domain: location.hostname,
  chart: chartName,
  appId: appId,

  ownerName: '',
  ownerEmail: '',
  homeDomain: '',
  uri: '',
};

// Control-plane skylink for chart metadata/API
const endpoint = 'ws' + location.origin.slice(4) + '/~~export/ws';
const skychart = new Skylink('', endpoint);
const promise = skychart
  .invoke('/pub/open/invoke', Skylink.String('', chartName), '/tmp/chart')
  .then(() => {
    session.status = 'Launching';
    skychart
      .loadString('/tmp/chart/owner-name')
      .then(x => session.ownerName = x);
    skychart
      .loadString('/tmp/chart/owner-email')
      .then(x => session.ownerEmail = x);
    skychart
      .loadString('/tmp/chart/home-domain')
      .then(x => session.homeDomain = x);
    return skychart
      .invoke('/tmp/chart/launch/invoke', secret);
  })
  .then(x => {
    if (x.Name === 'error') {
      session.status = 'Failed: ' + x.StringValue;
      var pass = prompt(x.StringValue + `\n\nInput a secret:`);
      if (pass) {
        return skychart.invoke('/tmp/chart/launch/invoke', Skylink.String('secret', pass));
      }
    }
    return x;
  })
  .then(x => {
    if (x.Name === 'error') {
      session.status = 'Failed: ' + x.StringValue;
      alert(`Couldn't open chart. Server said: ${x.StringValue}`);
      return Promise.reject('Server said: ' + x.StringValue);
    }
    return x;
  })
  .then(x => {
    skychart.stopTransport();

    session.status = 'Ready';
    session.uri = '/sessions/' + x.StringValue + '/mnt';
    return new Skylink('/pub' + session.uri, endpoint);
  });

/*
  status: 'Pending',

  domain: location.hostname,
  chart: chartName,
  appId: appId,

  ownerName: '',
  ownerEmail: '',
  homeDomain: '',
  uri: '',
*/

Vue.component('sky-session', {
  data: () => ({
    sess: session,
    stats: {},
  }),
  created() {
    promise.then(x => this.stats = x.stats);
  },
  template: `
  <div class="sky-session">
    <div :class="'indicator status-'+sess.status" />
    <span class="chart">{{sess.chart}}</span>@{{sess.homeDomain || sess.domain}}/{{sess.appId}}
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
  }),
  created() {
    promise
      .then(skylink => skylink.subscribe('/'+this.path, {maxDepth: 2}))
      .then(chan => {
        const sub = new RecordSubscription(chan, {
          basePath: this.path,
          filter: this.filter,
          fields: this.fields.split(' '),
        });
        console.log('sub started');
        this.items = sub.items;
        this.stats = sub.stats;
      });
  },
  template: `
  <component :is="el">
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

//promise.then(() => {
  var app = new Vue({
    el: '#app',
    router,
    data: {
      dataPath: '/persist',
    },
    methods: {
      load() {
        /*
        this.sub = skylink
          .subscribe('/todo')
          .route('/todo/:id/:field', {
            groupBy: 'id',
            observe: {
              created(id, obj) {
                obj._id = id;
                list.push(obj)
              },
              changed(id, obj) {
                const idx = list
                  .findIndex(x => x._id is id);
                if (idx != -1) {
                  list[idx] = obj;
                }
              },
              removed(id) {
                const idx = list
                  .findIndex(x => x._id is id);
                if (idx != -1) {
                  list[idx] = obj;
                }
              },
            }},
          ]);
        */
      },
    },
    created() {
      //this.load());
    },
  });
//});
