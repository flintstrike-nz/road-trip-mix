package com.roadtripmix.app.jam

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper

/**
 * Starts Android's local-only hotspot (API 26+): a private Wi-Fi network for the jam that doesn't
 * touch the phone's own mobile data. Android picks the SSID and password, so the console shows them
 * as a QR code. Needs Location (<= Android 12) or Nearby Wi-Fi devices (13+) permission, and on
 * Android 8–12 the Location switch must be on.
 */
class HotspotController(context: Context) {
    data class Info(val ssid: String, val password: String)

    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

    @SuppressLint("MissingPermission")
    fun start(onResult: (Result<Info>) -> Unit) {
        if (reservation != null) {
            reservation?.let { onResult(Result.success(describe(it))) }
            return
        }
        try {
            wifi.startLocalOnlyHotspot(
                object : WifiManager.LocalOnlyHotspotCallback() {
                    override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
                        reservation = res
                        onResult(Result.success(describe(res)))
                    }

                    override fun onStopped() {
                        reservation = null
                    }

                    override fun onFailed(reason: Int) {
                        onResult(Result.failure(IllegalStateException(failureText(reason))))
                    }
                },
                Handler(Looper.getMainLooper())
            )
        } catch (e: SecurityException) {
            onResult(Result.failure(IllegalStateException("Allow Nearby devices / Location permission to create the hotspot.")))
        } catch (e: IllegalStateException) {
            onResult(Result.failure(IllegalStateException("Android wouldn't start the hotspot: ${e.message}")))
        }
    }

    fun stop() {
        try { reservation?.close() } catch (_: Exception) {}
        reservation = null
    }

    @Suppress("DEPRECATION")
    private fun describe(res: WifiManager.LocalOnlyHotspotReservation): Info =
        if (Build.VERSION.SDK_INT >= 30) {
            val c = res.softApConfiguration
            val ssid = if (Build.VERSION.SDK_INT >= 33) c.wifiSsid?.toString() else c.ssid
            Info((ssid ?: "").trim('"'), c.passphrase ?: "")
        } else {
            val c = res.wifiConfiguration
            Info((c?.SSID ?: "").trim('"'), c?.preSharedKey ?: "")
        }

    private fun failureText(reason: Int) = when (reason) {
        WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "No Wi-Fi channel is free for a hotspot."
        WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "Hotspots are disabled on this device."
        WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE ->
            "Wi-Fi is in a mode that can't host a hotspot (try turning off your own hotspot or Wi-Fi tethering)."
        else -> "The hotspot couldn't start (code $reason). Is Location turned on?"
    }
}
