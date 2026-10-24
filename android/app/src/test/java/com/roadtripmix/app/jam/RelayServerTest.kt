package com.roadtripmix.app.jam

import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Exercises the relay over real sockets with an independent WebSocket client implementation. */
class RelayServerTest {
    private class Events : RelayServer.Listener {
        val log = LinkedBlockingQueue<String>()
        override fun onConnected(clientId: String) { log.add("connected:$clientId") }
        override fun onMessage(clientId: String, data: String) { log.add("message:$clientId:$data") }
        override fun onDisconnected(clientId: String) { log.add("disconnected:$clientId") }
        fun next(): String = log.poll(3, TimeUnit.SECONDS) ?: error("timed out waiting for an event")
    }

    private class Client(url: String) : WebSocketClient(URI.create(url)) {
        val received = LinkedBlockingQueue<String>()
        val closedCode = CompletableFuture<Int>()
        override fun onOpen(handshake: ServerHandshake?) {}
        override fun onMessage(message: String) { received.add(message) }
        override fun onClose(code: Int, reason: String?, remote: Boolean) { closedCode.complete(code) }
        override fun onError(ex: Exception?) {}
        fun next(): String = received.poll(3, TimeUnit.SECONDS) ?: error("timed out waiting for a message")
    }

    private lateinit var events: Events
    private lateinit var server: RelayServer
    private var port = 0
    private val clients = CopyOnWriteArrayList<Client>()

    @Before
    fun setUp() {
        events = Events()
        server = RelayServer(
            0,
            { path -> if (path == "index.html") RelayServer.Asset("<h1>jam</h1>".toByteArray(), "text/html") else null },
            events,
            maxClients = 2,
            maxFrameBytes = 1024,
            maxMsgsPerSec = 5,
        )
        port = server.start()
    }

    @After
    fun tearDown() {
        clients.forEach { try { it.closeBlocking() } catch (_: Exception) {} }
        server.stop()
    }

    private fun connect(): Client {
        val c = Client("ws://127.0.0.1:$port/ws")
        clients.add(c)
        assertTrue("handshake", c.connectBlocking(3, TimeUnit.SECONDS))
        return c
    }

    private fun get(path: String): Pair<Int, String> {
        val conn = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
        val code = conn.responseCode
        val body = (if (code < 400) conn.inputStream else conn.errorStream)?.readBytes()?.decodeToString() ?: ""
        return code to body
    }

    @Test
    fun servesTheJoinerPage() {
        assertEquals(200 to "<h1>jam</h1>", get("/"))
        assertEquals(200, get("/index.html").first)
        assertEquals(404, get("/missing.js").first)
    }

    @Test
    fun refusesPathTraversal() {
        assertEquals(403, get("/..%2f..%2fetc/passwd").first)
        assertEquals(403, get("/a/../index.html").first)
    }

    @Test
    fun relaysMessagesBothWaysAndReportsDisconnects() {
        val c = connect()
        val id = events.next().removePrefix("connected:")
        c.send("""{"t":"hello"}""")
        assertEquals("message:$id:{\"t\":\"hello\"}", events.next())

        server.send(id, "to-one")
        assertEquals("to-one", c.next())
        server.broadcast("to-all")
        assertEquals("to-all", c.next())

        c.closeBlocking()
        assertEquals("disconnected:$id", events.next())
    }

    @Test
    fun handlesUnicodeAndLargeServerFrames() {
        val c = connect()
        val id = events.next().removePrefix("connected:")
        c.send("héllo 🎵")
        assertEquals("message:$id:héllo 🎵", events.next())
        val big = "x".repeat(70_000) // forces the 8-byte length encoding
        server.send(id, big)
        assertEquals(big, c.next())
    }

    @Test
    fun closesClientsThatSendOversizedFrames() {
        val c = connect()
        events.next()
        c.send("y".repeat(5000))
        assertEquals(1009, c.closedCode.get(3, TimeUnit.SECONDS))
    }

    @Test
    fun dropsFloodsBeyondTheRateLimit() {
        val c = connect()
        val id = events.next().removePrefix("connected:")
        repeat(20) { c.send("m$it") }
        Thread.sleep(500)
        val delivered = events.log.count { it.startsWith("message:$id") }
        assertTrue("delivered $delivered", delivered in 1..5)
    }

    @Test
    fun enforcesTheClientLimitAndLetsTheHostCloseClients() {
        val a = connect(); val ida = events.next().removePrefix("connected:")
        connect(); events.next()
        val third = Client("ws://127.0.0.1:$port/ws")
        assertFalse(third.connectBlocking(2, TimeUnit.SECONDS))

        server.close(ida)
        assertEquals(4000, a.closedCode.get(3, TimeUnit.SECONDS))
        assertEquals("disconnected:$ida", events.next())
    }
}
