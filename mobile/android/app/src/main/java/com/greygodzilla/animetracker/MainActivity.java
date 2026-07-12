package com.greygodzilla.animetracker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register free in-app AnimeHeaven player before bridge starts.
        registerPlugin(AhPlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
