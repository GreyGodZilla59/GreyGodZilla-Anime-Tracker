package com.greygodzilla.animetracker;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Free local notifications (no Firebase / no paid services).
 * Schedules exact alarms for upcoming drops using Android AlarmManager.
 * Persists schedules for boot-safe restore.
 */
@CapacitorPlugin(
        name = "GgzNotify",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class NotifyPlugin extends Plugin {

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        requestPermissionForAlias("notifications", call, "permResult");
    }

    @PermissionCallback
    private void permResult(PluginCall call) {
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        NotifyStore.cancelRange(getContext());
        NotifyStore.saveItems(getContext(), new JSONArray());
        call.resolve();
    }

    @PluginMethod
    public void persistSchedule(PluginCall call) {
        JSArray items = call.getArray("items");
        try {
            JSONArray arr = items != null ? new JSONArray(items.toString()) : new JSONArray();
            NotifyStore.saveItems(getContext(), arr);
            JSObject r = new JSObject();
            r.put("ok", true);
            r.put("count", arr.length());
            call.resolve(r);
        } catch (JSONException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void rescheduleFromStore(PluginCall call) {
        NotifyReceiver.ensureChannel(getContext());
        int n = NotifyStore.rescheduleAll(getContext());
        JSObject r = new JSObject();
        r.put("scheduled", n);
        call.resolve(r);
    }

    @PluginMethod
    public void updateWidget(PluginCall call) {
        String title = call.getString("title", "GGZ Anime · Today");
        JSArray lines = call.getArray("lines");
        int count = call.getInt("count", 0);
        try {
            JSONArray arr = lines != null ? new JSONArray(lines.toString()) : new JSONArray();
            NotifyStore.saveWidget(getContext(), title, arr, count);
            TodayWidgetProvider.refreshAll(getContext());
            JSObject r = new JSObject();
            r.put("ok", true);
            call.resolve(r);
        } catch (JSONException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void scheduleMany(PluginCall call) {
        NotifyReceiver.ensureChannel(getContext());
        JSArray items = call.getArray("items");
        if (items == null) {
            call.reject("Missing items");
            return;
        }
        AlarmManager am = (AlarmManager) getContext().getSystemService(android.content.Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }
        int scheduled = 0;
        JSONArray persist = new JSONArray();
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                int id = o.optInt("id", 1000 + i);
                String title = o.optString("title", "GGZ Anime");
                String body = o.optString("body", "A release is soon.");
                long atMs = o.optLong("at", 0);
                int malId = o.optInt("mal_id", 0);
                String media = o.optString("media", "anime");
                String openTitle = o.optString("open_title", title);
                String action = o.optString("action", "watch");
                if (atMs <= System.currentTimeMillis() + 15_000) continue;

                // Keep for boot restore
                JSONObject store = new JSONObject();
                store.put("id", id);
                store.put("title", title);
                store.put("body", body);
                store.put("at", atMs);
                store.put("mal_id", malId);
                store.put("media", media);
                store.put("open_title", openTitle);
                store.put("action", action);
                persist.put(store);

                PendingIntent pi = NotifyStore.pendingFor(
                        getContext(), id, title, body, malId, media, openTitle, action
                );
                if (pi == null) continue;

                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                    } else {
                        am.setExact(AlarmManager.RTC_WAKEUP, atMs, pi);
                    }
                    scheduled++;
                } catch (SecurityException se) {
                    am.set(AlarmManager.RTC_WAKEUP, atMs, pi);
                    scheduled++;
                }
            }
            NotifyStore.saveItems(getContext(), persist);
        } catch (JSONException e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("scheduled", scheduled);
        call.resolve(r);
    }
}
