export function createCdpClient(socket, { timeoutMs = 5_000 } = {}) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function onMessage(event) {
    let reply;
    try {
      reply = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Number.isInteger(reply?.id)) return;

    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    request.resolve(reply);
  }

  function onClose() {
    closed = true;
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    rejectPending(new Error('WebView debugger connection closed.'));
  }

  function onError() {
    closed = true;
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    rejectPending(new Error('WebView debugger connection failed.'));
  }

  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);

  return {
    async evaluate(expression) {
      if (closed) throw new Error('WebView debugger connection is closed.');
      const requestId = ++nextId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(requestId)) {
            reject(new Error('Timed out waiting for WebView evaluation response.'));
          }
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
      });

      try {
        socket.send(
          JSON.stringify({
            id: requestId,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      } catch (error) {
        const request = pending.get(requestId);
        if (request) {
          pending.delete(requestId);
          clearTimeout(request.timer);
          request.reject(error);
        }
      }

      const reply = await response;
      if (reply.error) {
        throw new Error(`WebView evaluation failed (${reply.error.code}): ${reply.error.message}`);
      }
      const exception = reply.result?.exceptionDetails;
      if (exception) {
        throw new Error(
          `WebView evaluation failed: ${exception.exception?.description ?? exception.text}`,
        );
      }
      return reply.result?.result?.value;
    },

    close() {
      if (closed) return;
      closed = true;
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      rejectPending(new Error('WebView debugger connection closed.'));
      socket.close();
    },
  };
}
