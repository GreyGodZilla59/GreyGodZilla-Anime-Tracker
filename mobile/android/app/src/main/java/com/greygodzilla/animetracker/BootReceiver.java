package com.greygodzilla.animetracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Re-schedules drop alerts after reboot / app update / timezone change. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (action == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            NotifyReceiver.ensureChannel(context);
            NotifyStore.rescheduleAll(context);
            TodayWidgetProvider.refreshAll(context);
        }
    }
}
