package com.greygodzilla.animetracker;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Free local notifications (no Firebase / no paid services).
 * Schedules exact alarms for upcoming drops using Android AlarmManager.
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
        // Best-effort: cancel a range of possible IDs used by the app
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            for (int id = 1000; id < 1200; id++) {
                PendingIntent pi = pendingFor(id, "", "");
                if (pi != null) am.cancel(pi);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void scheduleMany(PluginCall call) {
        NotifyReceiver.ensureChannel(getContext());
        JSArray items = call.getArray("items");
        if (items == null) {
            call.reject("Missing items");
            return;
        }
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }
        int scheduled = 0;
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                int id = o.optInt("id", 1000 + i);
                String title = o.optString("title", "GGZ Anime");
                String body = o.optString("body", "A release is soon.");
                long atMs = o.optLong("at", 0);
                if (atMs <= System.currentTimeMillis() + 15_000) continue;

                PendingIntent pi = pendingFor(id, title, body);
                if (pi == null) continue;

                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                    } else {
                        am.setExact(AlarmManager.RTC_WAKEUP, atMs, pi);
                    }
                    scheduled++;
                } catch (SecurityException se) {
                    // Fallback without exact alarm permission
                    am.set(AlarmManager.RTC_WAKEUP, atMs, pi);
                    scheduled++;
                }
            }
        } catch (JSONException e) {
            call.reject(e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("scheduled", scheduled);
        call.resolve(r);
    }

    private PendingIntent pendingFor(int id, String title, String body) {
        Intent intent = new Intent(getContext(), NotifyReceiver.class);
        intent.setAction(NotifyReceiver.ACTION_ALERT);
        intent.putExtra("id", id);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        return PendingIntent.getBroadcast(
                getContext(),
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
