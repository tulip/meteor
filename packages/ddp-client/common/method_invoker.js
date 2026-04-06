// MethodInvoker state enum. Transitions are enforced — callers go through
// public methods rather than flipping boolean flags.
const InvokerState = Object.freeze({
  // Created but not yet sent to the server.
  PENDING: 'PENDING',
  // Message sent on the current connection, waiting for result and updated.
  IN_FLIGHT: 'IN_FLIGHT',
  // Result received from the server, waiting for data visibility (updated).
  RESULT_RECEIVED: 'RESULT_RECEIVED',
  // Data visible (updated arrived), waiting for result.
  DATA_VISIBLE: 'DATA_VISIBLE',
  // Connection dropped; waiting to be re-sent on the next connection.
  WAITING_FOR_RESEND: 'WAITING_FOR_RESEND',
  // Fully complete — both result and data visible, callback fired.
  COMPLETE: 'COMPLETE',
  // Aborted — timed out, noRetry, maxRetries exceeded, or connection torn down.
  ABORTED: 'ABORTED',
});

export { InvokerState };

// A MethodInvoker manages sending a method to the server and calling the user's
// callbacks. On construction, it registers itself in the connection's
// _methodInvokers map; it removes itself once the method is fully finished and
// the callback is invoked. This occurs when it has both received a result,
// and the data written by it is fully visible.
//
// State machine (two-phase completion: result and updated can arrive in
// either order):
//
//   PENDING ──sendMessage()──► IN_FLIGHT
//                                  │
//                    ┌─────────────┼──────────────┐
//               receiveResult() onReconnect()  dataVisible()
//                    │             │               │
//                    ▼             ▼               ▼
//             RESULT_RECEIVED  WAITING_FOR     DATA_VISIBLE
//                    │          _RESEND            │
//               dataVisible()    │           receiveResult()
//                    │      sendMessage()          │
//                    ▼     ┌────┴─────┐           ▼
//                 COMPLETE retry?  no retry    COMPLETE
//                          │         │
//                          ▼         ▼
//                      IN_FLIGHT  ABORTED
//
// Any state may transition to ABORTED via abort() (disconnect teardown).
export class MethodInvoker {
  constructor(options) {
    this.methodId = options.methodId;
    this._state = InvokerState.PENDING;

    this._callback = options.callback;
    this._connection = options.connection;
    this._message = options.message;
    this._onResultReceived = options.onResultReceived || (() => {});
    this._wait = options.wait;
    this.noRetry = options.noRetry;
    this._maxRetries = options.maxRetries != null ? options.maxRetries : null;
    this._retryCount = 0;
    this._methodResult = null;

    // Register with the connection.
    this._connection._methodInvokers[this.methodId] = this;
  }

  // -- State queries (replace external flag reads) --------------------------

  // True if the method has been sent on the current connection and has not
  // yet completed or been reset for resend. This is the question every
  // external caller was asking via `invoker.sentMessage`.
  isInFlight() {
    return this._state === InvokerState.IN_FLIGHT
      || this._state === InvokerState.RESULT_RECEIVED
      || this._state === InvokerState.DATA_VISIBLE;
  }

  // True if the invoker has reached a terminal state (COMPLETE or ABORTED).
  isDone() {
    return this._state === InvokerState.COMPLETE
      || this._state === InvokerState.ABORTED;
  }

  // True if receiveResult has been called (result available regardless of
  // data visibility).
  gotResult() {
    return !!this._methodResult;
  }

  // -- State transitions (public API) ---------------------------------------

  // Sends the method message to the server. May be called additional times if
  // we lose the connection and reconnect before receiving a result.
  sendMessage() {
    if (this.gotResult())
      throw new Error('sendingMethod is called on method with result');

    // On re-send (reconnect), check whether this method is allowed to retry.
    if (this._state === InvokerState.WAITING_FOR_RESEND) {
      if (!this._shouldRetry()) {
        return;
      }
    }

    this._state = InvokerState.IN_FLIGHT;

    // If this is a wait method, make all data messages be buffered until it is
    // done.
    if (this._wait)
      this._connection._methodsBlockingQuiescence[this.methodId] = true;

    // Actually send the message.
    this._connection._send(this._message);
  }

  // Called by the connection layer when a reconnect occurs. Marks the invoker
  // as needing to be re-sent on the new connection. This replaces the old
  // pattern of externally setting `invoker.sentMessage = false`.
  onReconnect() {
    if (this._state === InvokerState.IN_FLIGHT
        || this._state === InvokerState.DATA_VISIBLE) {
      this._state = InvokerState.WAITING_FOR_RESEND;
    }
    // RESULT_RECEIVED invokers keep their state — they already have the
    // result and just need dataVisible() to complete. The reconnect quiescence
    // logic handles them via gotResult() + dataVisible().
  }

  // Call with the result of the method from the server. Only may be called
  // once; once it is called, you should not call sendMessage again.
  // If the user provided an onResultReceived callback, call it immediately.
  // Then invoke the main callback if data is also visible.
  receiveResult(err, result) {
    if (this.gotResult())
      throw new Error('Methods should only receive results once');
    this._methodResult = [err, result];
    // If dataVisible() already arrived, go straight to COMPLETE.
    this._state = this._state === InvokerState.DATA_VISIBLE
      ? InvokerState.COMPLETE
      : InvokerState.RESULT_RECEIVED;
    this._onResultReceived(err, result);
    this._maybeComplete();
  }

  // Call this when all data written by the method is visible. This means that
  // the method has returned its "data is done" message *AND* all server
  // documents that are buffered at that time have been written to the local
  // cache. Invokes the main callback if the result has been received.
  dataVisible() {
    if (this._state === InvokerState.RESULT_RECEIVED) {
      this._state = InvokerState.COMPLETE;
    } else if (this._state === InvokerState.IN_FLIGHT) {
      this._state = InvokerState.DATA_VISIBLE;
    }
    this._maybeComplete();
  }

  // Force-complete this invoker with an error, regardless of current state.
  // Fires the callback exactly once and cleans up. Callers who need the
  // result before write confirmation should use onResultReceived.
  abort(reason) {
    if (this.isDone()) return;
    this._methodResult = [new Meteor.Error('disconnected', reason), undefined];
    this._state = InvokerState.ABORTED;
    this._fireCallback();
  }

  // -- Internal methods -----------------------------------------------------

  // Decides whether a method should be re-sent on reconnect. Centralizes
  // noRetry and maxRetries logic so the connection layer doesn't need to
  // inspect invoker internals.
  _shouldRetry() {
    if (this.noRetry) {
      this.receiveResult(
        new Meteor.Error(
          'invocation-failed',
          'Method invocation might have failed due to dropped connection. ' +
          'Failing because `noRetry` option was passed to Meteor.apply.'
        )
      );
      return false;
    }

    if (this._maxRetries !== null) {
      this._retryCount++;
      if (this._retryCount > this._maxRetries) {
        this.abort(
          'Method retry limit exceeded (' + this._maxRetries + ')'
        );
        return false;
      }
    }

    return true;
  }

  // Fire the callback if we have a result and are in a terminal state.
  _maybeComplete() {
    if (this._methodResult
        && (this._state === InvokerState.COMPLETE
            || this._state === InvokerState.ABORTED)) {
      this._fireCallback();
    }
  }

  // Actually invoke the callback and clean up. Called at most once.
  _fireCallback() {
    this._callback(this._methodResult[0], this._methodResult[1]);

    // Forget about this method.
    delete this._connection._methodInvokers[this.methodId];

    // Let the connection know that this method is finished, so it can try to
    // move on to the next block of methods.
    this._connection._outstandingMethodFinished();
  }
}
