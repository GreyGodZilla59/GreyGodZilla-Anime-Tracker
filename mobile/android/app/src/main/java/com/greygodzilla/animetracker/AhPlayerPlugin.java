package com.greygodzilla.animetracker;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Free bridge: open AnimeHeaven episode/show in a dedicated WebView Activity.
 * No paid SDKs, no API keys — uses the site's own free player.
 */
@CapacitorPlugin(name = "AhPlayer")
public class AhPlayerPlugin extends Plugin {

    @PluginMethod
    public void openEpisode(PluginCall call) {
        String gateHash = call.getString("gateHash", "");
        String url = call.getString("url", "");
        String title = call.getString("title", "Watch");

        if ((gateHash == null || gateHash.isEmpty()) && (url == null || url.isEmpty())) {
            call.reject("Missing gateHash or url");
            return;
        }

        Intent intent = new Intent(getContext(), EpisodeWebViewActivity.class);
        intent.putExtra("gateHash", gateHash != null ? gateHash : "");
        intent.putExtra("url", url != null ? url : "");
        intent.putExtra("title", title != null ? title : "Watch");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("mode", "webview");
        call.resolve(ret);
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        Intent intent = new Intent(getContext(), EpisodeWebViewActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("gateHash", "");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("mode", "webview");
        call.resolve(ret);
    }
}
