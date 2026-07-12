package com.greygodzilla.animetracker;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONArray;

/** Home-screen "Today" widget — free, no network in the widget itself. */
public class TodayWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            updateOne(context, appWidgetManager, id);
        }
    }

    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        if (mgr == null) return;
        ComponentName cn = new ComponentName(context, TodayWidgetProvider.class);
        int[] ids = mgr.getAppWidgetIds(cn);
        if (ids == null || ids.length == 0) return;
        for (int id : ids) {
            updateOne(context, mgr, id);
        }
    }

    private static void updateOne(Context context, AppWidgetManager mgr, int appWidgetId) {
        SharedPreferences p = NotifyStore.prefs(context);
        String title = p.getString(NotifyStore.KEY_WIDGET_TITLE, "GGZ Anime · Today");
        int count = p.getInt(NotifyStore.KEY_WIDGET_COUNT, 0);
        StringBuilder body = new StringBuilder();
        try {
            JSONArray lines = new JSONArray(p.getString(NotifyStore.KEY_WIDGET_LINES, "[]"));
            int n = Math.min(lines.length(), 5);
            for (int i = 0; i < n; i++) {
                if (i > 0) body.append('\n');
                body.append("• ").append(lines.optString(i, ""));
            }
            if (n == 0) {
                body.append(count > 0
                        ? (count + " drops today — open app")
                        : "Open GGZ Anime to load today’s schedule");
            }
        } catch (Exception e) {
            body.append("Open GGZ Anime");
        }

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_today);
        views.setTextViewText(R.id.widget_title, title != null ? title : "GGZ Anime · Today");
        views.setTextViewText(R.id.widget_body, body.toString());

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra("section", "track");
        PendingIntent pi = PendingIntent.getActivity(
                context,
                appWidgetId,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_root, pi);

        mgr.updateAppWidget(appWidgetId, views);
    }
}
