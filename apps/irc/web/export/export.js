Vue.component('export-tool', {
  template: '#export-tool',
  data() {
    return {
      network: '',
      context: '',
      dates: [],
      clicked: false,
    };
  },
  methods: {
    preview() {
      if (this.clicked) {
        alert('oh and now you think i programmed preview too. cute.');
      } else {
        alert('lol you thought i coded preview already?');
        this.clicked = true;
      }
    },
    submit() {
      if (this.clicked) {
        alert('oh and now you think i programmed download too. cute.');
      } else {
        alert('lol you thought i coded download already?');
        this.clicked = true;
      }
    },
  },
});