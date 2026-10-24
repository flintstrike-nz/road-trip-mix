package com.roadtripmix.app.jam

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Local jam relay: serves the static joiner page and shuttles WebSocket text frames between joiner
 * devices and the host app. It never looks inside a message (the host engine in the WebView does
 * all validation). Pure JVM — no Android imports — so it is unit-tested on the host machine.
 *
 *   GET /        static joiner page, from [assets]
 *   GET /ws      WebSocket upgrade; each text frame is handed to [Listener.onMessage]
 *
 * Mirrors scripts/jam-relay.ts, which is the same relay for running the host from a browser.
 */
class RelayServer(
    private val port: Int,
    private val assets: (path: String) -> Asset?,
    private val listener: Listener,
    private val maxClients: Int = 32,
    private val maxFrameBytes: Int = 16 * 1024,
    private val maxMsgsPerSec: Int = 30,
) {
    class Asset(val bytes: ByteArray, val mime: String)

    interface Listener {
        fun onConnected(clientId: String)
        fun onMessage(clientId: String, data: String)
        fun onDisconnected(clientId: String)
    }

    private class Conn(val id: String, val socket: Socket, val out: OutputStream) {
        @Volatile var open = true
        fun write(opcode: Int, payload: ByteArray) {
            synchronized(out) {
                if (!open) return
                val header = ByteArrayOutputStream(10)
                header.write(0x80 or opcode)
                when {
                    payload.size < 126 -> header.write(payload.size)
                    payload.size <= 0xFFFF -> {
                        header.write(126); header.write(payload.size shr 8); header.write(payload.size and 0xFF)
                    }
                    else -> {
                        header.write(127)
                        for (shift in 56 downTo 0 step 8) header.write(((payload.size.toLong() shr shift) and 0xFF).toInt())
                    }
                }
                out.write(header.toByteArray())
                out.write(payload)
                out.flush()
            }
        }

        fun close(code: Int) {
            if (!open) return
            try { write(0x8, byteArrayOf((code shr 8).toByte(), (code and 0xFF).toByte())) } catch (_: Exception) {}
            open = false
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private var server: ServerSocket? = null
    private val clients = ConcurrentHashMap<String, Conn>()
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "jam-relay").apply { isDaemon = true } }
    private val pinger: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "jam-relay-ping").apply { isDaemon = true } }

    /** Binds and starts accepting. Returns the bound port (useful when [port] is 0). */
    fun start(): Int {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(port))
        server = s
        pool.execute {
            while (!s.isClosed) {
                val socket = try { s.accept() } catch (_: SocketException) { break }
                pool.execute { handle(socket) }
            }
        }
        pinger.scheduleAtFixedRate({ clients.values.forEach { c -> try { c.write(0x9, ByteArray(0)) } catch (_: Exception) {} } }, 15, 15, TimeUnit.SECONDS)
        return s.localPort
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        clients.values.forEach { it.close(1001) }
        pinger.shutdownNow()
        pool.shutdownNow()
    }

    fun send(clientId: String, data: String) {
        val c = clients[clientId] ?: return
        try { c.write(0x1, data.toByteArray(Charsets.UTF_8)) } catch (_: Exception) { c.close(1011) }
    }

    fun broadcast(data: String) = clients.keys.forEach { send(it, data) }

    fun close(clientId: String) {
        clients[clientId]?.close(4000)
    }

    // --- HTTP ---------------------------------------------------------------

    private fun handle(socket: Socket) {
        try {
            socket.soTimeout = 10_000
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val head = readHead(input) ?: return socket.close()
            val lines = head.split("\r\n")
            val parts = lines[0].split(" ")
            if (parts.size < 3) return respond(socket, 400, "Bad Request")
            val method = parts[0]
            val rawPath = parts[1].substringBefore('?')
            val headers = lines.drop(1).filter { it.contains(':') }
                .associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }

            if (rawPath == "/ws" && headers["upgrade"]?.lowercase() == "websocket") {
                upgrade(socket, input, headers)
            } else if (method == "GET" || method == "HEAD") {
                serveStatic(socket, method == "HEAD", rawPath)
            } else {
                respond(socket, 405, "Method Not Allowed")
            }
        } catch (_: Exception) {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun readHead(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        var matched = 0
        val end = byteArrayOf(13, 10, 13, 10)
        while (buf.size() < 8192) {
            val b = input.read()
            if (b < 0) return null
            buf.write(b)
            matched = if (b == end[matched].toInt()) matched + 1 else if (b == 13) 1 else 0
            if (matched == 4) return buf.toString(Charsets.ISO_8859_1.name()).trimEnd()
        }
        return null
    }

    private fun serveStatic(socket: Socket, headOnly: Boolean, rawPath: String) {
        val path = try { URLDecoder.decode(rawPath, "UTF-8") } catch (_: Exception) { return respond(socket, 400, "Bad Request") }
        val segments = path.split('/').filter { it.isNotEmpty() }
        // Never let a request name anything but plain file names under the web root.
        if (segments.any { it == ".." || it == "." || it.contains('\\') || it.contains('\u0000') }) {
            return respond(socket, 403, "Forbidden")
        }
        val rel = if (segments.isEmpty()) "index.html" else segments.joinToString("/")
        val asset = assets(rel) ?: return respond(socket, 404, "Not found")
        val out = socket.getOutputStream()
        out.write(
            ("HTTP/1.1 200 OK\r\nContent-Type: ${asset.mime}\r\nContent-Length: ${asset.bytes.size}\r\n" +
                "Cache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")
                .toByteArray(Charsets.ISO_8859_1)
        )
        if (!headOnly) out.write(asset.bytes)
        out.flush()
        socket.close()
    }

    private fun respond(socket: Socket, status: Int, text: String) {
        val body = text.toByteArray()
        socket.getOutputStream().apply {
            write("HTTP/1.1 $status $text\r\nContent-Type: text/plain\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
            write(body)
            flush()
        }
        socket.close()
    }

    // --- WebSocket ------------------------------------------------------------

    private fun upgrade(socket: Socket, input: InputStream, headers: Map<String, String>) {
        val key = headers["sec-websocket-key"]
        if (key == null || headers["sec-websocket-version"] != "13") return respond(socket, 400, "Bad Request")
        if (clients.size >= maxClients) return respond(socket, 503, "Service Unavailable")

        val accept = Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray())
        )
        val out = socket.getOutputStream()
        out.write(
            ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n")
                .toByteArray()
        )
        out.flush()
        socket.soTimeout = 45_000 // server pings every 15s; any frame (incl. pong) resets this

        val conn = Conn(UUID.randomUUID().toString(), socket, out)
        clients[conn.id] = conn
        listener.onConnected(conn.id)
        try {
            readFrames(conn, input)
        } catch (_: Exception) {
            // Timeout, reset or malformed frame: fall through to cleanup.
        } finally {
            conn.open = false
            try { socket.close() } catch (_: Exception) {}
            if (clients.remove(conn.id) != null) listener.onDisconnected(conn.id)
        }
    }

    private fun readFully(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(buf, off, n - off)
            if (r < 0) throw EOFException()
            off += r
        }
        return buf
    }

    private fun readFrames(conn: Conn, input: InputStream) {
        var windowStart = System.currentTimeMillis()
        var inWindow = 0
        val fragments = ByteArrayOutputStream()

        while (conn.open) {
            val h = readFully(input, 2)
            val fin = h[0].toInt() and 0x80 != 0
            val opcode = h[0].toInt() and 0x0F
            val masked = h[1].toInt() and 0x80 != 0
            var len = (h[1].toInt() and 0x7F).toLong()
            if (len == 126L) {
                val e = readFully(input, 2)
                len = ((e[0].toInt() and 0xFF) shl 8 or (e[1].toInt() and 0xFF)).toLong()
            } else if (len == 127L) {
                val e = readFully(input, 8)
                len = e.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 0xFF) }
            }
            if (!masked) return conn.close(1002) // clients must mask
            if (len < 0 || len > maxFrameBytes) return conn.close(1009) // too big, refuse before allocating
            val mask = readFully(input, 4)
            val payload = readFully(input, len.toInt())
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()

            when (opcode) {
                0x8 -> return conn.close(1000)
                0x9 -> conn.write(0xA, payload)
                0xA -> Unit
                0x1, 0x0 -> {
                    if (opcode == 0x1) fragments.reset()
                    fragments.write(payload)
                    if (fragments.size() > maxFrameBytes) return conn.close(1009)
                    if (fin) {
                        val data = fragments.toString(Charsets.UTF_8.name())
                        fragments.reset()
                        val now = System.currentTimeMillis()
                        if (now - windowStart >= 1000) { windowStart = now; inWindow = 0 }
                        // Drop floods instead of handing them to the host.
                        if (++inWindow <= maxMsgsPerSec) listener.onMessage(conn.id, data)
                    }
                }
                else -> Unit // binary and reserved opcodes are ignored
            }
        }
    }
}
