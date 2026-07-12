package com.greygodzilla.animetracker;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Delivers scheduled free local episode alerts. */
public class NotifyReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "ggz_episode_alerts";
    public static final String ACTION_ALERT = "com.greygodzilla.animetracker.EPISODE_ALERT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        int id = intent.getIntExtra("id", (int) (System.currentTimeMillis() & 0x7fffffff));
        if (title == null) title = "GGZ Anime";
        if (body == null) body = "A tracked title is about to drop.";

        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
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
