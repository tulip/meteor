// MethodInvoker state enum.
const InvokerState = Object.freeze({
  PENDING: 'PENDING',
  IN_FLIGHT: 'IN_FLIGHT',
  WAITING_FOR_RESEND: 'WAITING_FOR_RESEND',
  COMPLETE: 'COMPLETE',
  ABORTED: 'ABORTED',
});

export { InvokerState };

// A MethodInvoker manages the transport lifecycle of a single DDP method call:
// sending the message, consuming the retry budget on reconnect, and firing the
// user callback exactly once when it reaches a terminal state.
//
// The invoker does NOT track two-phase completion (result + updated) — that is
// the ExecutionGroup's responsibility. The group calls complete() when both
// conditions are met.
//
// Every terminal transition (COMPLETE or ABORTED) reports back to the
// connection through the onComplete delegate, so connection bookkeeping
// happens in exactly one place no matter how the method ends.
//
// State machine:
//
//   PENDING ──sendMessage()──► IN_FLIGHT ──complete()──► COMPLETE
//                                  │
//                             onReconnect()
//                                  │
//                                  ▼
//                          WAITING_FOR_RESEND
//                                  │
//                            sendMessage()
//                          ┌───────┴────────┐
//                   consumeRetry()    consumeRetry()
//                    returns true      returns false
//                          │                  │
//                          ▼                  ▼
//                      IN_FLIGHT           ABORTED
//
// Any non-terminal state may also transition to ABORTED via abort().
export class MethodInvoker {
  constructor(options) {
    this.methodId = options.methodId;
    this._state = InvokerState.PENDING;

    this._callback = options.callback;
    this._message = options.message;
    this._onResultReceived = options.onResultReceived || (() => {});
    this.noRetry = options.noRetry;
    this._maxRetries = options.maxRetries != null ? options.maxRetries : null;
    this._retryCount = 0;

    // Delegates: physically send a DDP message on the wire, and report a
    // terminal state to the connection for bookkeeping.
    this._send = options.send;
    this._onComplete = options.onComplete;
  }

  // -- State queries ---------------------------------------------------------

  isInFlight() {
    return this._state === InvokerState.IN_FLIGHT;
  }

  isAwaitingResend() {
    return this._state === InvokerState.WAITING_FOR_RESEND;
  }

  isDone() {
    return this._state === InvokerState.COMPLETE
      || this._state === InvokerState.ABORTED;
  }

  // -- State transitions -----------------------------------------------------

  // Sends the method message to the server. Called again when a dropped
  // connection is recovered; the re-send consumes one retry, and the method
  // fails once the budget (noRetry / maxRetries) is exhausted.
  sendMessage() {
    if (this.isDone()) return;

    if (this._state === InvokerState.WAITING_FOR_RESEND && !this.consumeRetry()) {
      this._state = InvokerState.ABORTED;
      this._callback(
        new Meteor.Error(
          'invocation-failed',
          'Method invocation might have failed due to dropped connection. ' +
          (this.noRetry
            ? 'Failing because `noRetry` option was passed to Meteor.apply.'
            : 'Failing because the `maxRetries` limit was reached.')
        ),
        undefined
      );
      this._onComplete(this);
      return;
    }

    this._state = InvokerState.IN_FLIGHT;
    this._send(this._message);
  }

  // Called when a dropped connection has been recovered and this method,
  // which had already been sent, is about to be re-sent. Consumes one retry
  // from the maxRetries budget. Returns false if the method may not be
  // re-sent: either noRetry was set, or the method has already been re-sent
  // maxRetries times. An unset maxRetries allows unlimited re-sends.
  consumeRetry() {
    if (this.noRetry) return false;
    if (this._maxRetries === null) return true;
    this._retryCount++;
    return this._retryCount <= this._maxRetries;
  }

  // Called by the connection layer when a reconnect occurs.
  onReconnect() {
    if (this._state === InvokerState.IN_FLIGHT) {
      this._state = InvokerState.WAITING_FOR_RESEND;
    }
  }

  // Called by the ExecutionGroup as soon as the server's result arrives,
  // possibly before the data it wrote is visible locally. Forwards to the
  // caller's onResultReceived callback.
  notifyResultReceived(err, result) {
    this._onResultReceived(err, result);
  }

  // Called by the ExecutionGroup when both the result and data visibility
  // conditions are met. Fires the user callback.
  complete(err, result) {
    if (this.isDone()) return;
    this._state = InvokerState.COMPLETE;
    this._callback(err, result);
    this._onComplete(this);
  }

  // Force-complete with a 'disconnected' error. Used when a non-retrying
  // connection tears down. A result that already arrived is not delivered
  // here; callers that need it before write confirmation should use
  // onResultReceived.
  abort(reason) {
    if (this.isDone()) return;
    this._state = InvokerState.ABORTED;
    this._callback(new Meteor.Error('disconnected', reason), undefined);
    this._onComplete(this);
  }
}
