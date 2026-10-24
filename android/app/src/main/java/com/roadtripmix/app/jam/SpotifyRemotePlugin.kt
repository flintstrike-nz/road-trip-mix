package com.roadtripmix.app.jam

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.spotify.android.appremote.api.ConnectionParams
import com.spotify.android.appremote.api.Connector
import com.spotify.android.appremote.api.SpotifyAppRemote
import com.spotify.protocol.types.PlayerState

/**
 * Spotify App Remote SDK: controls the installed Spotify app and reports player changes the instant
 * they happen (so the rotation and play history don't wait for the next poll). The Web API still
 * does search and playlist edits; this is the "now playing" fast path and basic transport.
 */
@CapacitorPlugin(name = "SpotifyRemote")
class SpotifyRemotePlugin : Plugin() {
    private var remote: SpotifyAppRemote? = null

    @PluginMethod
    fun connect(call: PluginCall) {
        val clientId = call.getString("clientId")
        val redirectUri = call.getString("redirectUri")
        if (clientId.isNullOrBlank() || redirectUri.isNullOrBlank()) {
            return call.reject("clientId and redirectUri are required")
        }
        val params = ConnectionParams.Builder(clientId)
            .setRedirectUri(redirectUri)
            .showAuthView(true)
            .build()
        SpotifyAppRemote.connect(context, params, object : Connector.ConnectionListener {
            override fun onConnected(appRemote: SpotifyAppRemote) {
                remote = appRemote
                appRemote.playerApi.subscribeToPlayerState().setEventCallback { state ->
                    notifyListeners("playerState", toJs(state))
                }
                call.resolve()
            }

            override fun onFailure(error: Throwable) {
                call.reject(error.message ?: "Couldn't connect to the Spotify app. Is it installed and signed in?")
            }
        })
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        remote?.let { SpotifyAppRemote.disconnect(it) }
        remote = null
        call.resolve()
    }

    @PluginMethod
    fun play(call: PluginCall) = withRemote(call) { it.playerApi.play(call.getString("uri")) }

    @PluginMethod
    fun queue(call: PluginCall) = withRemote(call) { it.playerApi.queue(call.getString("uri")) }

    @PluginMethod
    fun pause(call: PluginCall) = withRemote(call) { it.playerApi.pause() }

    @PluginMethod
    fun resume(call: PluginCall) = withRemote(call) { it.playerApi.resume() }

    @PluginMethod
    fun skipNext(call: PluginCall) = withRemote(call) { it.playerApi.skipNext() }

    @PluginMethod
    fun getPlayerState(call: PluginCall) {
        val r = remote ?: return call.reject("Not connected to the Spotify app")
        r.playerApi.playerState
            .setResultCallback { call.resolve(toJs(it)) }
            .setErrorCallback { call.reject(it.message) }
    }

    override fun handleOnDestroy() {
        remote?.let { SpotifyAppRemote.disconnect(it) }
        remote = null
        super.handleOnDestroy()
    }

    private fun withRemote(call: PluginCall, action: (SpotifyAppRemote) -> Unit) {
        val r = remote ?: return call.reject("Not connected to the Spotify app")
        try {
            action(r)
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message)
        }
    }

    private fun toJs(state: PlayerState) = JSObject()
        .put("paused", state.isPaused)
        .put("positionMs", state.playbackPosition)
        .put("trackUri", state.track?.uri ?: JSObject.NULL)
}
