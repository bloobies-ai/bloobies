// A minimal WebSocket server (RFC 6455) on top of node:http, so the bridge has no dependencies. Text frames only,
// no extensions. Enough for one page listening to a local event stream (and, in phase 5, sending a few commands).
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Accept an upgrade request. Returns a socket wrapper, or null if the request isn't a valid WebSocket handshake. */
export function accept(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') return null
  const hash = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${hash}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  return new Peer(socket)
}

class Peer {
  constructor(socket) {
    this.socket = socket
    this.open = true
    this.onmessage = null
    this.onclose = null
    this.buf = Buffer.alloc(0)
    socket.on('data', (d) => this.read(d))
    socket.on('close', () => this.closed())
    socket.on('error', () => this.closed())
  }

  send(text) {
    if (!this.open) return
    const data = Buffer.from(text)
    const n = data.length
    const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    if (n >= 126 && n < 65536) {
      head[0] = 0x81
      head[1] = 126
      head.writeUInt16BE(n, 2)
    } else if (n >= 65536) {
      head[0] = 0x81
      head[1] = 127
      head.writeBigUInt64BE(BigInt(n), 2)
    }
    this.socket.write(Buffer.concat([head, data]))
  }

  close() {
    if (!this.open) return
    this.socket.end(Buffer.from([0x88, 0]))
    this.closed()
  }

  closed() {
    if (!this.open) return
    this.open = false
    this.onclose?.()
  }

  read(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const op = b[0] & 0x0f
      const masked = b[1] & 0x80
      let len = b[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        at = 10
      }
      // (pages only ever send small commands: anything huge is a broken or hostile client)
      if (len > 1 << 20) return this.close()
      const mask = masked ? b.subarray(at, at + 4) : null
      if (masked) at += 4
      if (b.length < at + len) return
      const data = Buffer.from(b.subarray(at, at + len))
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3]
      this.buf = b.subarray(at + len)
      if (op === 0x8) return this.close()
      if (op === 0x9) this.socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]))
      else if (op === 0x1) this.onmessage?.(data.toString('utf8'))
    }
  }
}
