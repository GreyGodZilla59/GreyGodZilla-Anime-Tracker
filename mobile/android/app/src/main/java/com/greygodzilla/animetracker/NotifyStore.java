package com.greygodzilla.animetracker;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Persists scheduled alerts so BootReceiver can restore them after reboot / process death.
 */
public final class NotifyStore {
    public static final String PREFS = "ggz_notify_store";
    public static final String KEY_ITEMS = "items_json";
    public static final String KEY_WIDGET_TITLE = "widget_title";
    public static final String KEY_WIDGET_LINES = "widget_lines_json";
    public static final String KEY_WIDGET_COUNT = "widget_count";

    private NotifyStore() {}

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static void saveItems(Context ctx, JSONArray items) {
        prefs(ctx).edit().putString(KEY_ITEMS, items != null ? items.toString() : "[]").apply();
    }

    public static JSONArray loadItems(Context ctx) {
        try {
            String raw = prefs(ctx).getString(KEY_ITEMS, "[]");
            return new JSONArray(raw != null ? raw : "[]");
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public static void saveWidget(Context ctx, String title, JSONArray lines, int count) {
        prefs(ctx).edit()
                .putString(KEY_WIDGET_TITLE, title != null ? title : "GGZ Anime · Today")
                .putString(KEY_WIDGET_LINES, lines != null ? lines.toString() : "[]")
                .putInt(KEY_WIDGET_COUNT, count)
                .apply();
    }

    public static int rescheduleAll(Context ctx) {
        JSONArray items = loadItems(ctx);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return 0;
        int scheduled = 0;
        long now = System.currentTimeMillis();
        for (int i = 0; i < items.length(); i++) {
            try {
                JSONObject o = items.getJSONObject(i);
                int id = o.optInt("id", 1000 + i);
                String title = o.optString("title", "GGZ Anime");
                String body = o.optString("body", "A release is soon.");
                long atMs = o.optLong("at", 0);
                int malId = o.optInt("mal_id", 0);
                String media = o.optString("media", "anime");
                String openTitle = o.optString("open_title", title);
                String action = o.optString("action", "watch");
                if (atMs <= now + 15_000) continue;

                PendingIntent pi = pendingFor(ctx, id, title, body, malId, media, openTitle, action);
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
            } catch (Exception ignored) {
            }
        }
        return scheduled;
    }

    public static void cancelRange(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        for (int id = 1000; id < 1200; id++) {
            PendingIntent pi = pendingFor(ctx, id, "", "", 0, "anime", "", "watch");
            if (pi != null) am.cancel(pi);
        }
    }

    public static PendingIntent pendingFor(
            Context ctx,
            int id,
            String title,
            String body,
            int malId,
            String media,
            String openTitle,
            String action
    ) {
        Intent intent = new Intent(ctx, NotifyReceiver.class);
        intent.setAction(NotifyReceiver.ACTION_ALERT);
        intent.putExtra("id", id);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        intent.putExtra("mal_id", malId);
        intent.putExtra("media", media != null ? media : "anime");
        intent.putExtra("open_title", openTitle != null ? openTitle : title);
        intent.putExtra("action", action != null ? action : "watch");
        return PendingIntent.getBroadcast(
                ctx,
                id,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
