package com.greygodzilla.animetracker;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.ArrayList;

/**
 * Free in-app player bridge — never opens external Chrome for streaming.
 * Primary: native ExoPlayer with Referer headers.
 * Fallback: in-app WebView with Grey GodZilla chrome.
 */
@CapacitorPlugin(name = "AhPlayer")
public class AhPlayerPlugin extends Plugin {

    @PluginMethod
    public void playNative(PluginCall call) {
        String url = call.getString("url", "");
        String referer = call.getString("referer", "https://animeheaven.me/");
        String title = call.getString("title", "Now playing");
        ArrayList<String> urls = new ArrayList<>();

        JSArray arr = call.getArray("urls");
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    String u = arr.getString(i);
                    if (u != null && !u.isEmpty() && !urls.contains(u)) {
                        urls.add(u);
                    }
                }
            } catch (JSONException ignored) {
            }
        }
        if (url != null && !url.isEmpty() && !urls.contains(url)) {
            urls.add(0, url);
        }
        if (urls.isEmpty()) {
            call.reject("Missing stream url(s)");
            return;
        }

        Intent intent = new Intent(getContext(), NativePlayerActivity.class);
        intent.putStringArrayListExtra(NativePlayerActivity.EXTRA_URLS, urls);
        intent.putExtra(NativePlayerActivity.EXTRA_REFERER, referer != null ? referer : "https://animeheaven.me/");
        intent.putExtra(NativePlayerActivity.EXTRA_TITLE, title != null ? title : "Now playing");
        // Same task — stays in our app stack (not a separate browser app)
        getActivity().startActivity(intent);

        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("mode", "native");
        ret.put("count", urls.size());
        call.resolve(ret);
    }

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
        getActivity().startActivity(intent);

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
        intent.putExtra("title", call.getString("title", "Watch"));
        getActivity().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("native", true);
        ret.put("mode", "native+webview");
        call.resolve(ret);
    }
}
