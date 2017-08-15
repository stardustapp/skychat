"use strict";

class Skylink {
  constructor(prefix, endpoint) {
    this.prefix = prefix || '';

    if (endpoint && endpoint.constructor === Skylink) {
      // If given a skylink, inherit its context/transport
      this.prefix = endpoint.prefix + this.prefix;
      this.endpoint = endpoint.endpoint;
      this.protocol = endpoint.protocol;
      this.transport = endpoint.transport;
    } else {
      // If given string or nothing, make a new transport
      this.endpoint = endpoint || '/~~export';
      this.protocol = 'http';
      if (this.endpoint.startsWith('ws')) {
        this.protocol = 'ws';
      }
      this.startTransport();
    }
  }

  static openChart(chartOverride) {
    var chartName = 'public';
    if (chartOverride) {
      chartName = chartOverride;
    } else if (location.pathname.startsWith('/~~')) {
      throw new Error("Core routes don't have a chart");
    } else if (location.pathname.startsWith('/~')) {
      chartName = location.pathname.split('/')[1].slice(1);
    }

    const endpoint = 'ws' + location.origin.slice(4) + '/~~export/ws';
    const skychart = new Skylink('', endpoint);
    const promise = skychart
      .invoke('/pub/open/invoke', Skylink.String('', chartName), '/tmp/chart')
      .then(() => skychart.invoke('/tmp/chart/launch/invoke'))
      .then(x => {
        skychart.stopTransport();
        return x.StringValue;
      })
      .then(x => new Skylink('/pub/sessions/' + x, endpoint));
    promise.chartName = chartName;
    return promise;
  }

  //////////////////////////////////////
  // First-order operations

  ping() {
    return this.exec({Op: 'ping'}).then(x => x.Ok);
  }

  get(path) {
    return this.exec({
      Op: 'get',
      Path: (this.prefix + path) || '/',
    }).then(x => x.Output);
  }

  enumerate(path, opts={}) {
    const maxDepth = opts.maxDepth == null ? 1 : +opts.maxDepth;
    const shapes = opts.shapes || [];
    return this.exec({
      Op: 'enumerate',
      Path: this.prefix + path,
      Depth: maxDepth,
      Shapes: shapes,
    }).then(res => {
      const list = res.Output.Children;
      if (opts.includeRoot === false) {
        list.splice(0, 1);
      }
      return list;
    });
  }

  store(path, entry) {
    return this.exec({
      Op: 'store',
      Dest: this.prefix + path,
      Input: entry,
    });
  }

  storeRandom(parentPath, entry) {
    const name = Skylink.randomId();
    const fullPath = parentPath + '/' + name;
    return this
      .store(fullPath, Skylink.toEntry(name, entry))
      .then(() => name);
  }

  invoke(path, input, outputPath) {
    return this.exec({
      Op: 'invoke',
      Path: this.prefix + path,
      Input: input,
      Dest: outputPath ? (this.prefix + outputPath) : '',
    }).then(x => x.Output);
  }

  copy(path, dest) {
    return this.exec({
      Op: 'copy',
      Path: this.prefix + path,
      Dest: this.prefix + dest,
    });
  }

  unlink(path) {
    return this.exec({
      Op: 'unlink',
      Path: this.prefix + path,
    });
  }

  //////////////////////////////////////
  // Helpers using the core operations

  fetchShape(path) {
    return this.enumerate(path, {
      maxDepth: 3,
    }).then(x => {
      const shape = {
        path: path,
      };
      const props = new Map();

      x.forEach(item => {
        const parts = item.Name.split('/');
        if (item.Name === 'type') {
          shape.type = item.StringValue;
        } else if (item.Name === 'props') {
          shape.props = true;
        } else if (parts[0] === 'props' && parts.length == 2) {
          if (item.Type === 'String') {
            props.set(parts[1], {
              name: parts[1],
              type: item.StringValue,
              shorthand: true,
            });
          } else if (item.Type === 'Folder') {
            props.set(parts[1], {
              name: parts[1],
              shorthand: false,
            });
          }
        } else if (parts[0] === 'props' && parts[2] === 'type') {
          props.get(parts[1]).type = item.StringValue;
        } else if (parts[0] === 'props' && parts[2] === 'optional') {
          props.get(parts[1]).optional = item.StringValue === 'yes';
        }
      });

      if (shape.props) {
        shape.props = [];
        props.forEach(prop => shape.props.push(prop));
      }
      return shape;
    });
  }

  mkdirp(path) {
    const parts = path.slice(1).split('/');
    var path = '';
    const nextPart = () => {
      if (parts.length === 0) {
        return true;
      }
      const part = parts.shift();
      path += '/' + part;
      return this.get(path)
        .then(x => true, x => {
          console.log('mkdirp got failure', x);
          if (x.Ok === false) {
            return this.store(path, Skylink.Folder(part));
          }
          return Promise.reject(x);
        })
        .then(nextPart);
    };
    return nextPart();
  }

  // File-based API

  putFile(path, data) {
    const nameParts = path.split('/');
    const name = nameParts[nameParts.length - 1];
    return this.store(path, Skylink.File(name, data));
  }

  loadFile(path) {
    return this.get(path).then(x => {
      if (x.Type !== 'File') {
        return Promise.reject(`Expected ${path} to be a File but was ${x.Type}`);
      } else {
        const encoded = base64js.toByteArray(x.FileData || '');
        return new TextDecoder('utf-8').decode(encoded);
      }
    });
  }

  // String-based API

  putString(path, value) {
    const nameParts = path.split('/');
    const name = nameParts[nameParts.length - 1];
    return this.store(path, Skylink.String(name, value));
  }

  loadString(path) {
    return this.get(path).then(x => {
      if (x.Type !== 'String') {
        return Promise.reject(`Expected ${path} to be a String but was ${x.Type}`);
      } else {
        return x.StringValue || '';
      }
    }, err => {
      // missing entries should be empty
      if (err.Ok === false) {
        return '';
      } else {
        throw err;
      }
    });
  }

  //////////////////////////////////////
  // Helpers to build an Input

  static toEntry(name, obj) {
    if (obj == null) return null;
    if (obj.Type) return obj;
    switch (obj.constructor) {
      case String:
        return Skylink.String(name, obj);
      case Object:
        const children = Object.keys(obj)
          .map(x => Skylink.toEntry(x, obj[x]));
        return Skylink.Folder(name, children);
      default:
        throw new Error(`Skylink can't toEntry a ${obj.constructor}`);
    }
  }

  static String(name, value) {
    return {
      Name: name,
      Type: 'String',
      StringValue: value,
    };
  }

  static Link(name, target) {
    return {
      Name: name,
      Type: 'Link',
      StringValue: target,
    };
  }

  static File(name, data) {
    const encodedData = new TextEncoder('utf-8').encode(data);
    return {
      Name: name,
      Type: 'File',
      FileData: base64js.fromByteArray(encodedData),
    };
  }

  static Folder(name, children) {
    return {
      Name: name,
      Type: 'Folder',
      Children: children || [],
    };
  }

  static randomId() {
    return [
      Date.now().toString(36),
      Math.random().toString(36).slice(2).slice(-4),
    ].join('_');
  }

  //////////////////////////////////////
  // The actual transport

  startTransport() {
    switch (this.protocol) {
      case 'ws':
        this.transport = new SkylinkWsTransport(this.endpoint, () => this.get(''));
        break;
      case 'http':
        this.transport = new SkylinkHttpTransport(this.endpoint, () => this.get(''));
        break;
      default:
        alert(`Unknown Skylink transport protocol "${this.protocol}"`);
        return
    }
    return this.transport.start();
  }

  stopTransport() {
    this.transport.stop();
    this.transport = null;
  }

  exec(request) {
    if (!this.transport) {
      console.log("No Skylink transport is started, can't exec", request);
      return Promise.reject("The Skylink transport is not started");
    } else {
      return this.transport.exec(request);
    }
  }
}

class SkylinkWsTransport {
  constructor(endpoint, healthcheck) {
    this.endpoint = endpoint;
    this.healthcheck = healthcheck;
    this.waitingReceivers = [];

    this.reset();

    this.pingTimer = setInterval(() => this.exec({Op: 'ping'}), 30 * 1000);
  }

  // TODO: report the state discontinuity downstream
  reset() {
    if (this.ws) {
      console.log('Resetting Websocket transport');
      this._stop();
    }

    this.connPromise = new Promise((resolve, reject) => {
      console.log(`Starting Skylink Websocket to ${this.endpoint}`);

      this.ws = new WebSocket(this.endpoint);
      this.ws.onmessage = msg => {
        const d = JSON.parse(msg.data);
        const receiver = this.waitingReceivers.shift();
        if (receiver) {
          receiver.resolve(d);
        } else {
          alert(`Received skylink payload without receiver:\n\n${JSON.stringify(d)}`);
        }
      };

      this.ws.onopen = () => resolve();
      this.ws.onclose = () => {
        if (this.ws != null) {
          // this was unexpected
          console.log('Auto-reconnecting Skylink websocket post-close');
          this.reset();
        }
      };
      this.ws.onerror = () => {
        this.ws = null; // prevent reconnect onclose
        reject(new Error(`Error opening skylink websocket. Will not retry.`));
      };

      return this.connPromise;
    })

    // make sure the new connection has what downstream needs
    this.connPromise
      .then(() => this.healthcheck())
      .then(() => {
        console.log('Websocket connection ready - state checks passed');
      }, err => {
        alert(`New Skylink connection failed the healthcheck.\nYou may need to restart the app.\n\n${err}`);
        console.log('Websocket connection checks failed', err);
      });
  }

  // gets a promise for a live connection, possibly making it
  getConn() {
    if (this.ws && this.ws.readyState > 1) {
      console.warn(`Reconnecting Skylink websocket on-demand due to readyState`);
      this.reset();
    }
    if (this.connPromise !== null) {
      return this.connPromise;
    } else {
      return Promise.reject(`Websocket transport is stopped.`);
    }
  }

  start() {
    return this.getConn()
    .then(() => this.exec({Op: 'ping'}));
  }

  _stop() {
    this.ws = null;

    const error = new Error(`Interrupted: Skylink WS transport was stopped`);
    this.waitingReceivers.forEach(x => {
      x.reject(error);
    });
    this.waitingReceivers.length = 0;
  }

  stop() {
    console.log('Shutting down Websocket transport');
    if (this.ws) {
      this.ws.close();
    }
    clearInterval(this.pingTimer);

    this._stop();
    this.connPromise = null;
  }

  exec(request) {
    return this.getConn()
      .then(() => new Promise((resolve, reject) => {
        this.waitingReceivers.push({resolve, reject});
        this.ws.send(JSON.stringify(request));
      }))
      .then(this.checkOk);
  }

  // Chain after a json promise with .then()
  checkOk(obj) {
    if (obj.ok === true || obj.Ok === true) {
      return obj;
    } else {
      //alert(`Stardust operation failed:\n\n${obj}`);
      return Promise.reject(obj);
    }
  }
}

class SkylinkHttpTransport {
  constructor(endpoint, healthcheck) {
    this.endpoint = endpoint;
    this.healthcheck = healthcheck;
  }

  start() {
    return this.healthcheck();
  }

  stop() {
    // noop. TODO: prevent requests until started again
  }

  exec(request) {
    return fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    })
    .then(this.checkHttpOk)
    .then(x => x.json())
    .then(this.checkOk);
  }

  // Chain after a fetch() promise with .then()
  checkHttpOk(resp) {
    if (resp.status >= 200 && resp.status < 400) {
      return resp;
    } else {
      return Promise.reject(`Stardust op failed with HTTP ${resp.status}`);
    }
  }

  // Chain after a json() promise with .then()
  checkOk(obj) {
    if (obj.ok === true || obj.Ok === true) {
      return obj;
    } else {
      //alert(`Stardust operation failed:\n\n${obj}`);
      return Promise.reject(obj);
    }
  }
}

// Base64, bleh.
(function(r){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=r()}else if(typeof define==="function"&&define.amd){define([],r)}else{var e;if(typeof window!=="undefined"){e=window}else if(typeof global!=="undefined"){e=global}else if(typeof self!=="undefined"){e=self}else{e=this}e.base64js=r()}})(function(){var r,e,t;return function r(e,t,n){function o(i,a){if(!t[i]){if(!e[i]){var u=typeof require=="function"&&require;if(!a&&u)return u(i,!0);if(f)return f(i,!0);var d=new Error("Cannot find module '"+i+"'");throw d.code="MODULE_NOT_FOUND",d}var c=t[i]={exports:{}};e[i][0].call(c.exports,function(r){var t=e[i][1][r];return o(t?t:r)},c,c.exports,r,e,t,n)}return t[i].exports}var f=typeof require=="function"&&require;for(var i=0;i<n.length;i++)o(n[i]);return o}({"/":[function(r,e,t){"use strict";t.byteLength=c;t.toByteArray=v;t.fromByteArray=s;var n=[];var o=[];var f=typeof Uint8Array!=="undefined"?Uint8Array:Array;var i="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";for(var a=0,u=i.length;a<u;++a){n[a]=i[a];o[i.charCodeAt(a)]=a}o["-".charCodeAt(0)]=62;o["_".charCodeAt(0)]=63;function d(r){var e=r.length;if(e%4>0){throw new Error("Invalid string. Length must be a multiple of 4")}return r[e-2]==="="?2:r[e-1]==="="?1:0}function c(r){return r.length*3/4-d(r)}function v(r){var e,t,n,i,a;var u=r.length;i=d(r);a=new f(u*3/4-i);t=i>0?u-4:u;var c=0;for(e=0;e<t;e+=4){n=o[r.charCodeAt(e)]<<18|o[r.charCodeAt(e+1)]<<12|o[r.charCodeAt(e+2)]<<6|o[r.charCodeAt(e+3)];a[c++]=n>>16&255;a[c++]=n>>8&255;a[c++]=n&255}if(i===2){n=o[r.charCodeAt(e)]<<2|o[r.charCodeAt(e+1)]>>4;a[c++]=n&255}else if(i===1){n=o[r.charCodeAt(e)]<<10|o[r.charCodeAt(e+1)]<<4|o[r.charCodeAt(e+2)]>>2;a[c++]=n>>8&255;a[c++]=n&255}return a}function l(r){return n[r>>18&63]+n[r>>12&63]+n[r>>6&63]+n[r&63]}function h(r,e,t){var n;var o=[];for(var f=e;f<t;f+=3){n=(r[f]<<16)+(r[f+1]<<8)+r[f+2];o.push(l(n))}return o.join("")}function s(r){var e;var t=r.length;var o=t%3;var f="";var i=[];var a=16383;for(var u=0,d=t-o;u<d;u+=a){i.push(h(r,u,u+a>d?d:u+a))}if(o===1){e=r[t-1];f+=n[e>>2];f+=n[e<<4&63];f+="=="}else if(o===2){e=(r[t-2]<<8)+r[t-1];f+=n[e>>10];f+=n[e>>4&63];f+=n[e<<2&63];f+="="}i.push(f);return i.join("")}},{}]},{},[])("/")});
