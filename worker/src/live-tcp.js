/*
 * worker/src/live-tcp.js - TCP transport for the /live relay.
 *
 * The Workers runtime can open an outbound TCP socket, which is exactly what
 * MQTT needs (Cloudflare's docs name MQTT as the motivating case). One request
 * opens one short-lived session, reads the retained frame, and disconnects.
 *
 * The public broker occasionally accepts a TCP connection and then never
 * answers CONNECT (about one session in eight while this was written), so the
 * whole attempt is capped and retried once with a fresh session. That keeps a
 * slow broker from turning into a stalled HTTP request.
 *
 * Only imported from the /live handler, so the Node tests never load the
 * cloudflare:sockets module.
 */
import { connect } from 'cloudflare:sockets';
import { LiveReader } from './live.js';

const HOST = 'broker.hivemq.com';
const PORT = 1883;                 // plain MQTT; the public broker needs no auth
const ATTEMPT_MS = 3000;           // connect + CONNACK + the retained frame
const ATTEMPTS = 2;                // one retry covers a silently dropped session
const SETTLE_MS = 300;             // let the retained status follow the data

export async function readLive(key) {
  let last = { error: 'live-timeout' };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    last = await readOnce(key);
    if (!last.error) return last;
    // A refusal is a broker answer; a second session would be refused too.
    if (last.error === 'broker-refused') return last;
  }
  return last;
}

// One TCP session. Resolves with {ok, ...} or {error}, and always closes the
// socket, even when the deadline fires while CONNECT is still in flight.
function readOnce(key) {
  return new Promise((resolve) => {
    const reader = new LiveReader(key);
    let socket = null;
    let writer = null;
    let input = null;
    let settle = null;
    let finished = false;

    const finish = async (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (settle) clearTimeout(settle);

      const value = error ? { error }
        : reader.error ? { error: reader.error }
        : reader.result();

      if (writer) {
        try { await writer.write(reader.drop()); } catch (e) { /* closing */ }
        try { await writer.close(); } catch (e) { /* closing */ }
      }
      try { if (socket) await socket.close(); } catch (e) { /* closing */ }
      try { if (input) input.releaseLock(); } catch (e) { /* a read is pending */ }

      resolve(value
        ? { ok: true, retrieved_ms: Date.now(), ...value }
        : { error: 'live-timeout' });
    };

    const deadline = setTimeout(() => finish(), ATTEMPT_MS);

    (async () => {
      try {
        socket = connect({ hostname: HOST, port: PORT });
        await socket.opened;
        if (finished) return;                       // deadline won the race

        writer = socket.writable.getWriter();
        input = socket.readable.getReader();

        const write = async () => {
          for (const packet of reader.takeOut()) await writer.write(packet);
        };
        await write();                              // CONNECT

        while (!finished) {
          const chunk = await input.read();
          if (chunk.done) break;
          if (!chunk.value || !chunk.value.length) continue;

          reader.push(chunk.value);
          await write();                            // SUBSCRIBE after CONNACK
          if (reader.error) return finish();

          if (reader.hasFrame) {
            if (reader.hasStatus) return finish();
            if (!settle) settle = setTimeout(finish, SETTLE_MS);
          }
        }
      } catch (e) {
        // Connect failed, or the socket closed under a pending read.
        if (!finished) return finish('broker-unreachable');
      }
      finish();
    })();
  });
}
