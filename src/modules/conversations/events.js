export function conversationEvents() {
  const subscribers = new Map();

  return {
    subscribe(userId, token, response) {
      const streams = subscribers.get(userId) ?? new Set();
      const stream = { token, response };
      streams.add(stream);
      subscribers.set(userId, streams);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
      // Reconnect periodically so the session is authenticated again.
      const expires = setTimeout(() => response.end(), 60000);
      response.once('close', () => {
        clearInterval(heartbeat);
        clearTimeout(expires);
        streams.delete(stream);
        if (!streams.size) subscribers.delete(userId);
      });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
    },

    publish(...userIds) {
      for (const userId of new Set(userIds)) {
        for (const { response } of subscribers.get(userId) ?? []) {
          if (!response.writableEnded && !response.destroyed && !response.write('data: {}\n\n')) response.end();
        }
      }
    },

    disconnect(token) {
      if (!token) return;
      for (const streams of subscribers.values()) {
        for (const stream of streams) if (stream.token === token) stream.response.end();
      }
    },

    close() {
      for (const streams of subscribers.values()) {
        for (const { response } of streams) response.end();
      }
    },
  };
}
