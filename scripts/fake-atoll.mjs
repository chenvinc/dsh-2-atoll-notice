/**
 * A dependency-free stand-in for Atoll's WebSocket JSON-RPC server.
 *
 * It exists so the Host plugin can be tested end to end (real sockets, real
 * frames, real JSON-RPC) on machines without Atoll, and so CI never needs a
 * Mac app. Only the small subset of RFC 6455 that a JSON-RPC client uses is
 * implemented: one text frame at a time, masking, ping/pong, close.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Encode a text frame as the server side (never masked). */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** Decode one client frame; returns { opcode, payload, rest } or undefined. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return undefined
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
  const start = offset + maskLength
  const payload = Buffer.from(buffer.subarray(start, start + length))
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, rest: buffer.subarray(start + length) }
}

/**
 * Start a fake Atoll RPC server.
 * @param {{ port?: number, responder?: (call: any) => any }} [options]
 */
export function startFakeAtoll(options = {}) {
  const calls = []
  const responder = options.responder ?? defaultResponder
  const server = createServer((request, response) => {
    response.writeHead(404).end()
  })

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    let pending = Buffer.alloc(0)
    const send = (value) => {
      if (socket.destroyed) return
      socket.write(encodeText(typeof value === 'string' ? value : JSON.stringify(value)))
    }
    server.emit('client', { send })

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const frame = decodeFrame(pending)
        if (!frame) break
        pending = frame.rest
        if (frame.opcode === 0x8) {
          socket.end()
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]))
          continue
        }
        if (frame.opcode !== 0x1) continue
        let message
        try {
          message = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        calls.push(message)
        const reply = responder(message)
        if (reply !== undefined) send(reply)
      }
    })
    socket.on('error', () => {})
  })

  const listening = new Promise((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve(server.address().port))
  })

  return {
    calls,
    get port() {
      return server.address()?.port ?? 0
    },
    ready: listening,
    /** Resolve once the given predicate matches a recorded call. */
    waitFor(predicate, timeoutMs = 5_000) {
      const started = Date.now()
      return new Promise((resolve, reject) => {
        const tick = () => {
          const found = calls.find(predicate)
          if (found) return resolve(found)
          if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for call'))
          setTimeout(tick, 20)
        }
        tick()
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Answer the RPC methods the Host plugin can send. */
function defaultResponder(message) {
  const id = message?.id ?? null
  const method = message?.method ?? ''
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
  switch (method) {
    case 'atoll.getVersion':
      return ok({ version: '0.0.0-fake' })
    case 'atoll.requestAuthorization':
    case 'atoll.checkAuthorization':
      return ok({ authorized: true, bundleIdentifier: message?.params?.bundleIdentifier })
    case 'atoll.presentLiveActivity':
    case 'atoll.updateLiveActivity':
      return ok({ activityID: message?.params?.descriptor?.id ?? 'unknown' })
    case 'atoll.dismissLiveActivity':
      return ok({ dismissed: true })
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}

export { defaultResponder, encodeText, decodeFrame }

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = startFakeAtoll({ port: Number(process.env.PORT ?? 9020) })
  fake.ready.then((port) => {
    console.log(`[fake-atoll] listening on ws://127.0.0.1:${port}`)
    console.log('[fake-atoll] press Ctrl+C to stop')
  })
  process.on('SIGINT', () => {
    console.log(`[fake-atoll] received ${fake.calls.length} call(s)`)
    process.exit(0)
  })
}
