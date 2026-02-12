let Status = {
  SUCCESS_HEADER: -1,
  SUCCESS_EOF: -2,
  ERROR_TIMEOUT: -3,
  ERROR_EXCEPTION: -4,
};

let connections = new Map();
let nextConnectionID = 1;
const encoder = new TextEncoder();

self.addEventListener("message", async function (event) {
  if (event.data.close) {
    let connectionID = event.data.close;
    connections.delete(connectionID);
    return;
  } else if (event.data.getMore) {
    let connectionID = event.data.getMore;
    let { curOffset, value, reader, intBuffer, byteBuffer } =
      connections.get(connectionID);
    // if we still have some in buffer, then just send it back straight away
    if (!value || curOffset >= value.length) {
      // read another buffer if required
      try {
        let readResponse = await reader.read();

        if (readResponse.done) {
          // read everything - clear connection and return
          connections.delete(connectionID);
          Atomics.store(intBuffer, 0, Status.SUCCESS_EOF);
          Atomics.notify(intBuffer, 0);
          // finished reading successfully
          // return from event handler
          return;
        }
        curOffset = 0;
        connections.get(connectionID).value = readResponse.value;
        value = readResponse.value;
      } catch (error) {
        console.log("Request exception:", error);
        let errorBytes = encoder.encode(error.message);
        let written = errorBytes.length;
        byteBuffer.set(errorBytes);
        intBuffer[1] = written;
        Atomics.store(intBuffer, 0, Status.ERROR_EXCEPTION);
        Atomics.notify(intBuffer, 0);
      }
    }

    // send as much buffer as we can
    let curLen = value.length - curOffset;
    if (curLen > byteBuffer.length) {
      curLen = byteBuffer.length;
    }
    byteBuffer.set(value.subarray(curOffset, curOffset + curLen), 0);

    Atomics.store(intBuffer, 0, curLen); // store current length in bytes
    Atomics.notify(intBuffer, 0);
    curOffset += curLen;
    connections.get(connectionID).curOffset = curOffset;

    return;
  } else {
    // start fetch
    let connectionID = nextConnectionID;
    nextConnectionID += 1;
    const intBuffer = new Int32Array(event.data.buffer);
    const byteBuffer = new Uint8Array(event.data.buffer, 8);
    try {
      const response = await fetch(event.data.url, event.data.fetchParams);
      // return the headers first via textencoder
      var headers = [];
      for (const pair of response.headers.entries()) {
        headers.push([pair[0], pair[1]]);
      }
      let headerObj = {
        headers: headers,
        status: response.status,
        connectionID,
      };
      const headerText = JSON.stringify(headerObj);
      let headerBytes = encoder.encode(headerText);
      let written = headerBytes.length;
      byteBuffer.set(headerBytes);
      intBuffer[1] = written;
      // make a connection
      connections.set(connectionID, {
        reader: response.body.getReader(),
        intBuffer: intBuffer,
        byteBuffer: byteBuffer,
        value: undefined,
        curOffset: 0,
      });
      // set header ready
      Atomics.store(intBuffer, 0, Status.SUCCESS_HEADER);
      Atomics.notify(intBuffer, 0);
      // all fetching after this goes through a new postmessage call with getMore
      // this allows for parallel requests
    } catch (error) {
      console.log("Request exception:", error);
      let errorBytes = encoder.encode(error.message);
      let written = errorBytes.length;
      byteBuffer.set(errorBytes);
      intBuffer[1] = written;
      Atomics.store(intBuffer, 0, Status.ERROR_EXCEPTION);
      Atomics.notify(intBuffer, 0);
    }
  }
});
self.postMessage({ inited: true });
