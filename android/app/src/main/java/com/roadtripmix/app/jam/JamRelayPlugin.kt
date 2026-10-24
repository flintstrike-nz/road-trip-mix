package com.roadtripmix.app.jam

import android.Manifest
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Bridges lib/jam/native.ts to the relay: start/stop the hotspot and the local server, and move
 * text frames between joiner devices and the host engine running in the WebView.
 */
@CapacitorPlugin(
    name = "JamRelay",
    permissions = [
        Permission(strings = [Manifest.permission.ACCESS_FINE_LOCATION], alias = "location"),
        Permission(strings = ["android.permission.NEARBY_WIFI_DEVICES"], alias = "nearby"),
    ]
)
class JamRelayPlugin : Plugin() {
    private var server: RelayServer? = null
    private var hotspot: HotspotController? = null

    private val permissionAlias get() = if (Build.VERSION.SDK_INT >= 33) "nearby" else "location"

    @PluginMethod
    fun start(call: PluginCall) {
        if (call.getBoolean("hotspot", true) == true && getPermissionState(permissionAlias) != PermissionState.GRANTED) {
            requestPermissionForAlias(permissionAlias, call, "permissionResult")
        } else {
            doStart(call)
        }
    }

    // Start either way: if the user declines, the jam still runs on whatever network is available
    // and the console shows why there's no hotspot.
    @PermissionCallback
    private fun permissionResult(call: PluginCall) = doStart(call)

    private fun doStart(call: PluginCall) {
        stopAll()
        val wantHotspot = call.getBoolean("hotspot", true) == true
        val port = call.getInt("port", 8787) ?: 8787

        Thread {
            try {
                val relay = RelayServer(port, ::loadAsset, object : RelayServer.Listener {
                    override fun onConnected(clientId: String) = emit("connected", clientId)
                    override fun onMessage(clientId: String, data: String) = emit("message", clientId, data)
                    override fun onDisconnected(clientId: String) = emit("disconnected", clientId)
                })
                val bound = relay.start()
                server = relay
                JamForegroundService.start(context)

                if (!wantHotspot) return@Thread finish(call, bound, null, null)

                val before = ipv4Addresses()
                val controller = HotspotController(context).also { hotspot = it }
                controller.start { result ->
                    Thread {
                        result.onSuccess { info ->
                            waitForNewAddress(before)
                            finish(call, bound, info, null)
                        }.onFailure { e -> finish(call, bound, null, e.message) }
                    }.start()
                }
            } catch (e: Exception) {
                stopAll()
                call.reject("Couldn't start the jam relay: ${e.message}")
            }
        }.start()
    }

    private fun finish(call: PluginCall, port: Int, info: HotspotController.Info?, hotspotError: String?) {
        val urls = JSArray()
        ipv4Addresses().sortedBy { priority(it.first) }.forEach { urls.put("http://${it.second}:$port") }
        val res = JSObject()
        res.put("port", port)
        res.put("urls", urls)
        if (info != null) {
            res.put("hotspot", JSObject().put("ssid", info.ssid).put("password", info.password))
        } else {
            res.put("hotspot", JSObject.NULL)
        }
        if (hotspotError != null) res.put("hotspotError", hotspotError)
        call.resolve(res)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopAll()
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val id = call.getString("clientId")
        val data = call.getString("data")
        if (id != null && data != null) server?.send(id, data)
        call.resolve()
    }

    @PluginMethod
    fun broadcast(call: PluginCall) {
        call.getString("data")?.let { server?.broadcast(it) }
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        call.getString("clientId")?.let { server?.close(it) }
        call.resolve()
    }

    override fun handleOnDestroy() {
        stopAll()
        super.handleOnDestroy()
    }

    private fun stopAll() {
        server?.stop()
        server = null
        hotspot?.stop()
        hotspot = null
        JamForegroundService.stop(context)
    }

    private fun emit(type: String, clientId: String, data: String? = null) {
        val e = JSObject().put("type", type).put("clientId", clientId)
        if (data != null) e.put("data", data)
        notifyListeners("relayEvent", e)
    }

    private fun loadAsset(path: String): RelayServer.Asset? = try {
        val bytes = context.assets.open("jam-client/$path").use { it.readBytes() }
        RelayServer.Asset(bytes, mimeFor(path))
    } catch (_: Exception) {
        null
    }

    private fun mimeFor(path: String) = when (path.substringAfterLast('.', "")) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "svg" -> "image/svg+xml"
        "json" -> "application/json"
        "png" -> "image/png"
        else -> "application/octet-stream"
    }

    private fun ipv4Addresses(): List<Pair<String, String>> =
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { nic ->
                nic.inetAddresses.toList()
                    .filter { it is Inet4Address && !it.isLinkLocalAddress }
                    .map { nic.name to it.hostAddress!! }
            }

    // The hotspot's interface shows up a moment after Android reports it started.
    private fun waitForNewAddress(before: List<Pair<String, String>>) {
        repeat(20) {
            if (ipv4Addresses().any { it !in before }) return
            Thread.sleep(150)
        }
    }

    // Hotspot/AP interfaces first, then Wi-Fi, then everything else (mobile data is useless to joiners).
    private fun priority(ifName: String) = when {
        ifName.startsWith("ap") || ifName.startsWith("swlan") || ifName.startsWith("softap") || ifName == "wlan1" -> 0
        ifName.startsWith("wlan") -> 1
        ifName.startsWith("rmnet") || ifName.startsWith("ccmni") -> 3
        else -> 2
    }
}
