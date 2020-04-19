class TraceContext {
  constructor(id) {
    this.id = id;
    this.nextTraceNum = 1;
  }

  newTrace(tags) {
    const traceNum = this.nextTraceNum++;
    const traceId = this.id + '-' + traceNum;
    return new CallTrace(this, traceId, tags);
  }

  submitTrace(trace) {
    // TODO: opt-in method of recording traces

    const baseTime = trace.eventLog[0][0];
    const endTime = trace.eventLog.slice(-1)[0][0];
    // TODO: trace.originalStack has line number
    console.log(`${trace.id}\tTRACE\t${endTime-baseTime}ms\t${JSON.stringify(trace.eventLog[0][3])}`);
    // for (const [time, id, type, data] of trace.eventLog.slice(1, -1)) {
    //   console.log(`${id}\t${time-baseTime}ms\t${type}\t${JSON.stringify(data)}`);
    // }
    // console.log();
  }
}

class CallTrace {
  constructor(context, id, tags={}) {
    this.context = context;
    this.id = id;

    this.nextStepNum = 1;
    this.stepStack = new Array; // child steps go FIRST (shift/unshift)
    this.eventLog = new Array;

    this.eventLog.push([new Date, this.id, 'start', tags]);
  }

  startStep(tags={}) {
    const stepNum = this.nextStepNum++;
    const stepId = this.id + '-' + stepNum;
    this.stepStack.unshift(stepId);
    this.eventLog.push([new Date, stepId, 'start', tags]);
  }

  log(tags={}) {
    this.eventLog.push([new Date, this.stepStack[0], 'log', tags]);
  }

  endStep(tags) {
    if (tags) this.log(tags);
    const stepId = this.stepStack.shift();
    this.eventLog.push([new Date, stepId, 'end', {}]);
    //if (this.stepStack.length === 0) this.end();
  }

  /*async*/ end() {
    if (this.stepStack.length > 0)
      throw new Error(`BUG: CallTrace is being finalized before being completed`);
    if (this.stepStack === null)
      throw new Error(`BUG: CallTrace is being double-finalized`);
    this.stepStack = null;

    this.eventLog.push([new Date, this.id, 'end', {}]);
    return this.context.submitTrace(this);
  }
}

module.exports = {
  TraceContext,
  CallTrace,
};