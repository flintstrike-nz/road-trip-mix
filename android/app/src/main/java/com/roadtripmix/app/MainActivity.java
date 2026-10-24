package com.roadtripmix.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.roadtripmix.app.jam.JamRelayPlugin;
import com.roadtripmix.app.jam.SpotifyRemotePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JamRelayPlugin.class);
        registerPlugin(SpotifyRemotePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
