// A cursor read that fails rejects with the driver's error, so a caller can tell it from an empty
// result (https://github.com/meteor/meteor/issues/14794).

Tinytest.addAsync('asynchronous cursor - fetchAsync rejects when the read fails', async test => {
  const collection = new Mongo.Collection(`asyncCursorFetch${test.id}`);
  await collection.insertAsync({ a: 1 });

  await test.throwsAsync(
    () => collection.find({ $foo: 1 }).fetchAsync(),
    /unknown top level operator/
  );
});

Tinytest.addAsync('asynchronous cursor - findOneAsync rejects when the read fails', async test => {
  const collection = new Mongo.Collection(`asyncCursorFindOne${test.id}`);
  await collection.insertAsync({ a: 1 });

  await test.throwsAsync(
    () => collection.findOneAsync({ $foo: 1 }),
    /unknown top level operator/
  );
});

Tinytest.addAsync('asynchronous cursor - forEachAsync rejects when the read fails', async test => {
  const collection = new Mongo.Collection(`asyncCursorForEach${test.id}`);
  await collection.insertAsync({ a: 1 });

  await test.throwsAsync(
    () => collection.find({ $foo: 1 }).forEachAsync(() => {}),
    /unknown top level operator/
  );
});

Tinytest.addAsync('asynchronous cursor - a read that fails while the cursor closes ends it', async test => {
  let failNext;
  const cursor = asynchronousCursorWith(
    test,
    () => new Promise((resolve, reject) => { failNext = reject; })
  );

  const read = cursor._rawNextObjectPromise();
  cursor._closing = true;
  failNext(new Error('cursor killed'));

  test.isTrue((await read) == null);
});

Tinytest.addAsync('asynchronous cursor - a timed read that fails rejects without an unhandled rejection', async test => {
  const cursor = asynchronousCursorWith(test, () => Promise.reject(new Error('connection closed')));
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    await test.throwsAsync(() => cursor._nextObjectPromiseWithTimeout(10000), /connection closed/);
    await new Promise(resolve => setTimeout(resolve, 50));

    test.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// An AsynchronousCursor whose driver cursor answers next() with the given function.
function asynchronousCursorWith(test, next) {
  const collection = new Mongo.Collection(`asyncCursorStub${test.id}`);
  const meteorCursor = collection.find();
  const cursor = meteorCursor._mongo._createAsynchronousCursor(meteorCursor._cursorDescription);
  cursor._dbCursor = { next, close() {}, rewind() {} };
  return cursor;
}
