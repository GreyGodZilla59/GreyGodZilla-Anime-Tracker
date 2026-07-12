package com.greygodzilla.animetracker;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * Fully in-app player with free rotation, fullscreen, PiP, and media-session notification.
 * Media3/ExoPlayer sends Referer so AnimeHeaven CDN works.
 */
@UnstableApi
public class NativePlayerActivity extends AppCompatActivity {
    public static final String EXTRA_URLS = "urls";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_TITLE = "title";

    private ExoPlayer player;
    private MediaSession mediaSession;
    private TextView statusView;
    private LinearLayout toolbar;
    private PlayerView playerView;
    private ArrayList<String> urls = new ArrayList<>();
    private int urlIndex = 0;
    private String referer = "https://animeheaven.me/";
    private String playTitle = "Now playing";
    private boolean immersive = false;
    private boolean landscapeForced = false;
    private boolean inPip = false;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_native_player);

        toolbar = findViewById(R.id.player_toolbar);
        TextView titleView = findViewById(R.id.player_title);
        statusView = findViewById(R.id.player_status);
        playerView = findViewById(R.id.player_view);
        ImageButton close = findViewById(R.id.btn_close);
        ImageButton fsBtn = findViewById(R.id.btn_fullscreen);
        ImageButton rotBtn = findViewById(R.id.btn_rotate);
        ImageButton pipBtn = findViewById(R.id.btn_pip);

        close.setOnClickListener(v -> finish());
        fsBtn.setOnClickListener(v -> toggleImmersive());
        rotBtn.setOnClickListener(v -> {
            landscapeForced = !landscapeForced;
            setRequestedOrientation(landscapeForced
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
            statusView.setText(landscapeForced ? "Landscape lock" : "Rotation unlocked");
        });
        if (pipBtn != null) {
            boolean pipOk = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
            pipBtn.setVisibility(pipOk ? View.VISIBLE : View.GONE);
            pipBtn.setOnClickListener(v -> enterPipMode());
        }

        String title = getIntent().getStringExtra(EXTRA_TITLE);
        if (title == null || title.isEmpty()) title = "Now playing";
        playTitle = title;
        titleView.setText(title);

        String ref = getIntent().getStringExtra(EXTRA_REFERER);
        if (ref != null && !ref.isEmpty()) referer = ref;

        ArrayList<String> list = getIntent().getStringArrayListExtra(EXTRA_URLS);
        if (list != null && !list.isEmpty()) {
            urls.addAll(list);
        } else {
            String single = getIntent().getStringExtra(EXTRA_URL);
            if (single != null && !single.isEmpty()) urls.add(single);
        }

        if (urls.isEmpty()) {
            statusView.setText("No stream URL — go back and try another episode.");
            return;
        }

        String origin = "https://animeheaven.me";
        try {
            Uri refUri = Uri.parse(referer);
            if (refUri != null && refUri.getScheme() != null && refUri.getHost() != null) {
                origin = refUri.getScheme() + "://" + refUri.getHost();
            }
        } catch (Exception ignored) { }

        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", referer != null ? referer : origin + "/");
        headers.put("Origin", origin);
        headers.put(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 "
                        + "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
        );
        headers.put("Accept", "*/*");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        headers.put("Connection", "keep-alive");

        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(headers)
                .setConnectTimeoutMs(25000)
                .setReadTimeoutMs(45000)
                .setAllowCrossProtocolRedirects(true)
                .setUserAgent(headers.get("User-Agent"));

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
                .build();
        playerView.setPlayer(player);
        playerView.setControllerHideOnTouch(true);
        playerView.setControllerShowTimeoutMs(3000);
        playerView.setFullscreenButtonClickListener(isFull -> toggleImmersive());

        // Media session → lock-screen / notification controls
        try {
            Intent sessionIntent = new Intent(this, NativePlayerActivity.class);
            PendingIntent sessionPi = PendingIntent.getActivity(
                    this,
                    0,
                    sessionIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            mediaSession = new MediaSession.Builder(this, player)
                    .setSessionActivity(sessionPi)
                    .setId("ggz-player-" + System.currentTimeMillis())
                    .build();
        } catch (Exception ignored) {
            mediaSession = null;
        }

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    statusView.setText("Buffering…");
                } else if (state == Player.STATE_READY) {
                    statusView.setText(inPip
                            ? "Playing in picture-in-picture"
                            : "Playing · Home for PiP · rotate for landscape");
                } else if (state == Player.STATE_ENDED) {
                    statusView.setText("Episode finished.");
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                urlIndex++;
                if (urlIndex < urls.size()) {
                    statusView.setText("Source failed · trying " + (urlIndex + 1) + "/" + urls.size() + "…");
                    playCurrent();
                } else {
                    String msg = error != null ? error.getErrorCodeName() : "unknown";
                    statusView.setText("All sources failed (" + msg + "). Close and pick another episode.");
                }
            }
        });

        playCurrent();
    }

    private void playCurrent() {
        if (player == null || urlIndex >= urls.size()) return;
        String url = urls.get(urlIndex);
        statusView.setText("Loading source " + (urlIndex + 1) + "/" + urls.size() + "…");
        MediaItem item = new MediaItem.Builder()
                .setUri(Uri.parse(url))
                .setMediaMetadata(new MediaMetadata.Builder()
                        .setTitle(playTitle)
                        .setArtist("Grey GodZilla Anime App")
                        .build())
                .build();
        player.setMediaItem(item);
        player.prepare();
        player.play();
    }

    private void enterPipMode() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return;
        try {
            PictureInPictureParams.Builder b = new PictureInPictureParams.Builder();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                b.setAspectRatio(new Rational(16, 9));
            }
            enterPictureInPictureMode(b.build());
        } catch (Exception e) {
            if (statusView != null) statusView.setText("PiP not available on this device");
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Auto PiP when user presses Home while playing
        if (player != null && player.isPlaying()) {
            enterPipMode();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPip = isInPictureInPictureMode;
        if (toolbar != null) toolbar.setVisibility(isInPictureInPictureMode ? View.GONE : View.VISIBLE);
        if (statusView != null) statusView.setVisibility(isInPictureInPictureMode ? View.GONE : View.VISIBLE);
        if (playerView != null) {
            playerView.setUseController(!isInPictureInPictureMode);
        }
    }

    private void toggleImmersive() {
        immersive = !immersive;
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (immersive) {
            if (toolbar != null) toolbar.setVisibility(View.GONE);
            if (statusView != null) statusView.setVisibility(View.GONE);
            if (c != null) {
                c.hide(WindowInsetsCompat.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } else {
            if (toolbar != null) toolbar.setVisibility(View.VISIBLE);
            if (statusView != null) statusView.setVisibility(View.VISIBLE);
            if (c != null) {
                c.show(WindowInsetsCompat.Type.systemBars());
            }
            setRequestedOrientation(landscapeForced
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        }
    }

    @Override
    public void onBackPressed() {
        if (immersive) {
            toggleImmersive();
            return;
        }
        if (player != null && player.isPlaying()
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            enterPipMode();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Keep playing in PiP; pause only when fully leaving
        if (!inPip && player != null) {
            player.pause();
        }
    }

    @Override
    protected void onDestroy() {
        if (mediaSession != null) {
            try { mediaSession.release(); } catch (Exception ignored) { }
            mediaSession = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
