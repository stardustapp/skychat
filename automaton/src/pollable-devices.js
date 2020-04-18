const {Channel, FolderEntry, StringEntry} = require('@dustjs/skylink');

class Pollable {
  constructor() {
    this.currentEntry = null;
    this.isReady = false;
    this.isUpdated = false;
    this.interestedParties = new Set;
  }

  markUpdated() {
    if (this.isReady && !this.isUpdated) {
      this.isUpdated = true;

      const parties = this.interestedParties;
      if (parties.length < 1) return;

      this.interestedParties = new Set;
      for (const interestedParty of parties) {
        interestedParty(this);
      }
    }
  }

  reset() {
    this.isUpdated = false;
  }

  async getEntry(path) {
    // TODO: add /stop
    if (path !== '/latest') throw new Error(
      `TODO: only /latest is available on these`);

    // TODO: is this racey?
    if (!this.isReady) {
      await new Promise(resolve => {
        this.interestedParties.add(resolve);
      });
    }

    return {
      get: () => {
        if (this.isUpdated) {
          this.reset();
        }
        return this.currentEntry;
      },
    };
  }

}

class PollableSubscribeOne extends Pollable {
  constructor() {
    super();
  }

  stop() {
    this.requestStop();
  }

  async subscribeTo(entry) {
    if (this.requestStop) throw new Error(
      `BUG: subscribe was called a second time`);
    const stopRequestedP = new Promise(resolve => this.requestStop = resolve);

    await entry.subscribe(0, {
      invoke: async (cb) => {
        const channel = this.channel = new Channel('pollable '+(entry.path||'one'));
        return cb({
          next(Output) {
            channel.handle({Status: 'Next', Output});
          },
          error(Output) {
            channel.handle({Status: 'Error', Output});
          },
          done() {
            channel.handle({Status: 'Done'});
          },
          onStop(cb) {
            stopRequestedP.then(() => cb());
          },
        });
      },
    });

    if (!this.channel) throw new Error(
      `BUG: No channel was created in time`);

    this.channel.forEach(notif => {
      const path = notif.getChild('path');
      if (path && path.StringValue !== '') throw new Error(
        `BUG: PollableSubscribeOne received sub event for non-root "${path.StringValue}"`);

      const notifType = notif.getChild('type', true, 'String').StringValue;
      switch (notifType) {

        case 'Added':
          if (this.currentEntry) throw new Error(
            `BUG: Received 'Added' but already had an entry`);
          this.currentEntry = notif.getChild('entry');
          break;

        case 'Changed':
          if (!this.currentEntry) throw new Error(
            `BUG: Received 'Changed' but didn't have an entry yet`);
          this.currentEntry = notif.getChild('entry');
          break;

        case 'Ready':
          if (this.isReady) throw new Error(
            `BUG: Received 'Ready' but already was ready`);
          this.isReady = true;
          break;

        default: throw new Error(
          `TODO: subscription received ${notifType}`);
      }
      this.markUpdated();
    });

    // TODO: handle the channel closing somehow
  }
}

class PollableInterval extends Pollable {
  constructor(milliseconds) {
    super();
    this.milliseconds = milliseconds;

    this.isReady = true;
    this.currentEntry = new StringEntry('timer', new Date().toISOString());
    this.markUpdated();
  }

  reset() {
    super.reset();

    if (this.timeout) {
      console.log('BUG: PollableInterval reset before it was timed out');
      clearTimeout(this.interval);
    }

    this.timeout = setTimeout(() => {
      this.currentEntry = new StringEntry('timer', new Date().toISOString());
      this.markUpdated();
      this.timeout = null;
    }, this.milliseconds);
  }

  stop() {
    clearTimeout(this.interval);
  }
}

async function PerformPoll(devicesEntry, timeoutMs) {
  const readyList = new FolderEntry('Ready');
  const devices = new Map();
  for (const devEntry of devicesEntry.Children) {
    if (devEntry.Type !== 'Device') throw new Error(
      `PerformPoll needs a "Device", was given a "${devEntry.Type}" as "${devEntry.Name}"`);

    if (devEntry._device.isUpdated) {
      readyList.append(new StringEntry(devEntry.Name, 'yes'));
    }
    devices.set(devEntry._device, devEntry.Name);
  }

  if (readyList.Children.length > 0) {
    return readyList;
  }

  // ok we need to wait
  let timeout;
  let myResolve;
  const readyDev = await new Promise(resolve => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    myResolve = resolve;

    for (const devEntry of devices.keys()) {
      devEntry.interestedParties.add(resolve);
    }
  });

  // unregister
  for (const devEntry of devices.keys()) {
    devEntry.interestedParties.delete(myResolve);
  }
  clearTimeout(timeout);

  if (readyDev !== 'timeout') {
    const devName = devices.get(readyDev);
    readyList.append(new StringEntry(devName, 'yes'));
  }

  return readyList;
}

module.exports = {
  PollableSubscribeOne,
  PollableInterval,
  PerformPoll,
};
