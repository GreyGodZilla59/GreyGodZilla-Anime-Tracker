package com.greygodzilla.animetracker;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Delivers scheduled free local episode alerts with deep-link into the title. */
public class NotifyReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "ggz_episode_alerts";
    public static final String ACTION_ALERT = "com.greygodzilla.animetracker.EPISODE_ALERT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        int id = intent.getIntExtra("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        int malId = intent.getIntExtra("mal_id", 0);
        String media = intent.getStringExtra("media");
        String openTitle = intent.getStringExtra("open_title");
        String action = intent.getStringExtra("action");
        if (title == null) title = "GGZ Anime";
        if (body == null) body = "A tracked title is about to drop.";
        if (media == null) media = "anime";
        if (action == null) action = "watch";
        if (openTitle == null) openTitle = title;

        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("mal_id", malId);
        open.putExtra("media", media);
        open.putExtra("open_title", openTitle);
        open.putExtra("action", action);
        // Also encode as data URI so Capacitor / future handlers can parse
        Uri data = Uri.parse("ggzanime://open")
                .buildUpon()
                .appendQueryParameter("mal_id", String.valueOf(malId))
                .appendQueryParameter("media", media)
                .appendQueryParameter("action", action)
                .appendQueryParameter("title", openTitle)
                .build();
        open.setData(data);

        PendingIntent pi = PendingIntent.getActivity(
                context,
                id,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(pi);

        try {
            NotificationManagerCompat.from(context).notify(id, builder.build());
        } catch (SecurityException ignored) {
            // Permission not granted yet
        }
    }

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Episode & release alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Notify before anime / manga / manhwa releases");
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(channel);
    }
}
