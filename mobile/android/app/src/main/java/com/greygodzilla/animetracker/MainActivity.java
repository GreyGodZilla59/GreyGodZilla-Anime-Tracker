package com.greygodzilla.animetracker;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AhPlayerPlugin.class);
        registerPlugin(NotifyPlugin.class);
        super.onCreate(savedInstanceState);
        // Allow rotation in the main app (stream overlay / lists)
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        // Restore alarms if process was killed
        try {
            NotifyStore.rescheduleAll(this);
        } catch (Exception ignored) {
        }
        handleDeepLinkIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLinkIntent(intent);
    }

    private boolean deepLinkConsumed = false;

    @Override
    public void onResume() {
        super.onResume();
        // Deliver once WebView is ready (first resume only if still pending)
        if (!deepLinkConsumed) {
            handleDeepLinkIntent(getIntent());
        }
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null || deepLinkConsumed) return;
        int malId = intent.getIntExtra("mal_id", 0);
        String media = intent.getStringExtra("media");
        String openTitle = intent.getStringExtra("open_title");
        String action = intent.getStringExtra("action");
        String section = intent.getStringExtra("section");

        if (malId == 0 && intent.getData() != null) {
            try {
                String qMal = intent.getData().getQueryParameter("mal_id");
                if (qMal != null) malId = Integer.parseInt(qMal);
                if (media == null) media = intent.getData().getQueryParameter("media");
                if (action == null) action = intent.getData().getQueryParameter("action");
                if (openTitle == null) openTitle = intent.getData().getQueryParameter("title");
                if (section == null) section = intent.getData().getQueryParameter("section");
            } catch (Exception ignored) {
            }
        }

        // Nothing useful to open
        if (malId == 0 && (section == null || section.isEmpty()) && (openTitle == null || openTitle.isEmpty()) && action == null) {
            return;
        }

        try {
            JSONObject o = new JSONObject();
            o.put("mal_id", malId);
            o.put("media", media != null ? media : "anime");
            o.put("open_title", openTitle != null ? openTitle : "");
            o.put("title", openTitle != null ? openTitle : "");
            o.put("action", action != null ? action : (malId > 0 ? "watch" : "open"));
            if (section != null) o.put("section", section);
            final String js =
                    "window.__ggzDeepLink = " + o.toString() + ";"
                    + "try{window.dispatchEvent(new CustomEvent('ggz-deeplink',{detail:window.__ggzDeepLink}));}catch(e){};"
                    + "true;";
            runOnUiThread(() -> {
                try {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        WebView wv = getBridge().getWebView();
                        wv.postDelayed(() -> wv.evaluateJavascript(js, null), 350);
                        deepLinkConsumed = true;
                    }
                } catch (Exception ignored) {
                }
            });
            // Clear so we don't re-fire forever
            intent.removeExtra("mal_id");
            intent.removeExtra("media");
            intent.removeExtra("open_title");
            intent.removeExtra("action");
            intent.removeExtra("section");
            intent.setData(null);
        } catch (Exception ignored) {
        }
    }
}
