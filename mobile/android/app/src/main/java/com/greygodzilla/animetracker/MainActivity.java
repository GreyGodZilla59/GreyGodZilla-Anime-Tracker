package com.greygodzilla.animetracker;

import android.content.pm.ActivityInfo;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AhPlayerPlugin.class);
        registerPlugin(NotifyPlugin.class);
        super.onCreate(savedInstanceState);
        // Allow rotation in the main app (stream overlay / lists)
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
    }
}
