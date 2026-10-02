import { ObserveMultiplexer } from '../observe_multiplex';
import { ObserveHandle } from '../observe_handle';

// observeChanges calls for the same cursor share one multiplexer, also while its driver starts.

Tinytest.addAsync('observe sharing - concurrent observeChanges calls for one cursor share a multiplexer', async test => {
  const collection = new Mongo.Collection(`observeSharing${test.id}`);
  await collection.insertAsync({ a: 1 });
  const cursor = collection.find({ a: 1 });

  const [first, second] = await Promise.all([
    cursor.observeChanges({ added() {} }),
    cursor.observeChanges({ added() {} }),
  ]);

  try {
    test.isTrue(first._multiplexer === second._multiplexer);
  } finally {
    await first.stop();
    await second.stop();
  }
});

Tinytest.addAsync('observe sharing - a later call shares the multiplexer after another handle stops', async test => {
  const collection = new Mongo.Collection(`observeSharingStop${test.id}`);
  await collection.insertAsync({ a: 1 });
  const cursor = collection.find({ a: 1 });
  const [first, second] = await Promise.all([
    cursor.observeChanges({ added() {} }),
    cursor.observeChanges({ added() {} }),
  ]);
  await first.stop();

  const third = await cursor.observeChanges({ added() {} });

  try {
    test.isTrue(third._multiplexer === second._multiplexer);
  } finally {
    await second.stop();
    await third.stop();
  }
});

Tinytest.addAsync('observe sharing - queryError fails every handle waiting for ready', async test => {
  const multiplexer = new ObserveMultiplexer({ ordered: false, onStop() {} });
  const waiting = [1, 2].map(() =>
    multiplexer
      .addHandleAndSendInitialAdds(new ObserveHandle(multiplexer, { added() {} }))
      .then(() => 'ready', e => e.message)
  );

  await multiplexer.queryError(new Error('bad selector')).catch(() => {});

  test.equal(await Promise.all(waiting), ['bad selector', 'bad selector']);
  const late = await multiplexer
    .addHandleAndSendInitialAdds(new ObserveHandle(multiplexer, { added() {} }))
    .then(() => 'ready', e => e.message);
  test.equal(late, 'bad selector');
});
