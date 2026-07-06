// An ExecutionGroup manages a set of method calls that execute together.
// Groups are processed sequentially by the connection — all methods in a
// group must complete before the next group is sent.
//
// The group owns the DDP two-phase completion protocol:
//   - Tracks 'result' wire messages per method
//   - Tracks 'updated' wire messages per method (for quiescence)
//   - Tracks data visibility per method (for callback firing)
//   - Tells each MethodInvoker when to fire its callback
//
// The group does NOT handle transport (sending/retrying) — that's the
// invoker's job. The group does NOT handle scheduling (which group runs
// next) — that's the connection's job.
export class ExecutionGroup {
  // atomic: if true, data messages are buffered while this group runs,
  //         and the group cannot be merged with adjacent groups.
  constructor({ atomic = false }) {
    this.atomic = atomic;
    this._methods = [];

    // Per-method two-phase tracking. Keyed by methodId.
    this._completion = new Map();
  }

  get methods() {
    return this._methods;
  }

  // -- Group management ------------------------------------------------------

  addMethod(invoker) {
    this._methods.push(invoker);
    this._completion.set(invoker.methodId, {
      gotResult: false,
      gotUpdated: false,   // wire: 'updated' message received
      dataVisible: false,  // local: data flushed to minimongo
      err: undefined,
      result: undefined,
    });
  }

  removeMethod(invoker) {
    const idx = this._methods.indexOf(invoker);
    if (idx !== -1) {
      this._methods.splice(idx, 1);
    }
    this._completion.delete(invoker.methodId);
  }

  // Transfer a method from another group, preserving its completion state.
  // Used during reconnect when merging old groups into new ones.
  transferMethod(invoker, fromGroup) {
    this._methods.push(invoker);
    const existingEntry = fromGroup._completion.get(invoker.methodId);
    if (existingEntry) {
      this._completion.set(invoker.methodId, existingEntry);
      fromGroup._completion.delete(invoker.methodId);
    } else {
      this._completion.set(invoker.methodId, {
        gotResult: false,
        gotUpdated: false,
        dataVisible: false,
        err: undefined,
        result: undefined,
      });
    }
  }

  hasMethodId(methodId) {
    return this._completion.has(methodId);
  }

  isEmpty() {
    return this._methods.length === 0;
  }

  // Reset wire-level state on reconnect. Preserves result (which was already
  // received and won't be re-sent), but clears updated/dataVisible since those
  // need to arrive fresh on the new connection.
  resetForReconnect() {
    for (const [, entry] of this._completion) {
      entry.gotUpdated = false;
      entry.dataVisible = false;
    }
  }

  // -- Two-phase completion --------------------------------------------------

  // Called when the server sends a 'result' message for a method in this group.
  receiveResult(methodId, err, result) {
    const entry = this._completion.get(methodId);
    if (!entry) return;
    entry.gotResult = true;
    entry.err = err;
    entry.result = result;

    // Let the invoker forward the result to the caller's onResultReceived
    // callback (eager result access, before data visibility).
    const invoker = this._methods.find(m => m.methodId === methodId);
    if (invoker) {
      invoker.notifyResultReceived(err, result);
    }

    this._maybeComplete(methodId);
  }

  // Called when the 'updated' wire message arrives for this method ID, or
  // when the connection force-marks a method whose result arrived before a
  // reconnect (no fresh 'updated' will ever come for it). This is quiescence
  // bookkeeping only — it does NOT mean the data is visible locally; that is
  // markDataVisible / flushCompleted.
  receiveUpdated(methodId) {
    const entry = this._completion.get(methodId);
    if (!entry) return;
    entry.gotUpdated = true;
  }

  // Called when data written by this method is actually visible in minimongo.
  // For non-atomic groups, this is called in the same tick as receiveUpdated.
  // For atomic groups, this is called after quiescence ends and data is flushed.
  markDataVisible(methodId) {
    const entry = this._completion.get(methodId);
    if (!entry) return;
    entry.dataVisible = true;
    this._maybeComplete(methodId);
  }

  // For atomic groups: called after quiescence ends and buffered data has been
  // flushed to minimongo. Marks all updated methods as data-visible and
  // completes any that also have their result.
  flushCompleted() {
    for (const [methodId, entry] of this._completion) {
      if (entry.gotUpdated) {
        entry.dataVisible = true;
        this._maybeComplete(methodId);
      }
    }
  }

  // True if all methods in this group have received their 'updated' wire message.
  // Used by the connection to decide when to stop buffering data (quiescence).
  isQuiesced() {
    for (const [, entry] of this._completion) {
      if (!entry.gotUpdated) return false;
    }
    return true;
  }

  // True if a specific method has received its result.
  hasResult(methodId) {
    const entry = this._completion.get(methodId);
    return entry ? entry.gotResult : false;
  }

  // -- Internal --------------------------------------------------------------

  // Complete the invoker if it has both result AND data visible. The invoker
  // reports its own terminal state to the connection, which removes it from
  // this group.
  _maybeComplete(methodId) {
    const entry = this._completion.get(methodId);
    if (!entry || !entry.gotResult || !entry.dataVisible) return;

    const invoker = this._methods.find(m => m.methodId === methodId);
    if (!invoker || invoker.isDone()) return;

    invoker.complete(entry.err, entry.result);
  }
}
