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
// sending the message, handling retries on reconnect, and firing the user
// callback when told to by the ExecutionGroup.
//
// The invoker does NOT track two-phase completion (result + updated) — that's
// the ExecutionGroup's responsibility. The invoker just sends messages and
// fires callbacks.
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
//                           sendMessage()
//                          ┌───────┴────────┐
//                    _shouldRetry()     _shouldRetry()
//                      returns true      returns false
//                          │                  │
//                          ▼                  ▼
//                      IN_FLIGHT           ABORTED
//
// Any state may transition to ABORTED via abort().
export class MethodInvoker {
  constructor(options) {
    this.methodId = options.methodId;
    this._state = InvokerState.PENDING;

    this._callback = options.callback;
    this._message = options.message;
    this._onResultReceived = options.onResultReceived || null;
    this.noRetry = options.noRetry;
    this._maxRetries = options.maxRetries != null ? options.maxRetries : null;
    this._retryCount = 0;

    // Delegate: physically send a DDP message on the wire.
    this._send = options.send;
  }

  // -- State queries ---------------------------------------------------------

  isInFlight() {
    return this._state === InvokerState.IN_FLIGHT;
  }

  isDone() {
    return this._state === InvokerState.COMPLETE
      || this._state === InvokerState.ABORTED;
  }

  // -- State transitions -----------------------------------------------------

  // Sends the method message to the server. May be called additional times
  // on reconnect.
  sendMessage() {
    if (this.isDone()) return;

    // On re-send (reconnect), check whether this method is allowed to retry.
    if (this._state === InvokerState.WAITING_FOR_RESEND) {
      if (!this._shouldRetry()) {
        return;
      }
    }

    this._state = InvokerState.IN_FLIGHT;
    this._send(this._message);
  }

  // Called by the connection layer when a reconnect occurs.
  onReconnect() {
    if (this._state === InvokerState.IN_FLIGHT) {
      this._state = InvokerState.WAITING_FOR_RESEND;
    }
  }

  // Called by the ExecutionGroup when both result and data visibility
  // conditions are met. Fires the user callback.
  complete(err, result) {
    if (this.isDone()) return;
    this._state = InvokerState.COMPLETE;
    this._callback(err, result);
  }

  // Force-complete with an error. Used on disconnect teardown and when
  // retry limits are exceeded.
  abort(reason) {
    if (this.isDone()) return;
    this._state = InvokerState.ABORTED;
    this._callback(new Meteor.Error('disconnected', reason), undefined);
  }

  // -- Internal --------------------------------------------------------------

  _shouldRetry() {
    if (this.noRetry) {
      this._state = InvokerState.ABORTED;
      this._callback(
        new Meteor.Error(
          'invocation-failed',
          'Method invocation might have failed due to dropped connection. ' +
          'Failing because `noRetry` option was passed to Meteor.apply.'
        ),
        undefined
      );
      return false;
    }

    if (this._maxRetries !== null) {
      this._retryCount++;
      if (this._retryCount > this._maxRetries) {
        this.abort('Method retry limit exceeded (' + this._maxRetries + ')');
        return false;
      }
    }

    return true;
  }
}
