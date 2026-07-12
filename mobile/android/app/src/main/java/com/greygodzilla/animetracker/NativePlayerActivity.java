package com.greygodzilla.animetracker;

import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
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
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * Fully in-app player with free rotation + fullscreen.
 * Media3/ExoPlayer sends Referer so AnimeHeaven CDN works.
 */
public class NativePlayerActivity extends AppCompatActivity {
    public static final String EXTRA_URLS = "urls";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_TITLE = "title";

    private ExoPlayer player;
    private TextView statusView;
    private LinearLayout toolbar;
    private ArrayList<String> urls = new ArrayList<>();
    private int urlIndex = 0;
    private String referer = "https://animeheaven.me/";
    private boolean immersive = false;
    private boolean landscapeForced = false;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Allow free rotation while watching
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_native_player);

        toolbar = findViewById(R.id.player_toolbar);
        TextView titleView = findViewById(R.id.player_title);
        statusView = findViewById(R.id.player_status);
        PlayerView playerView = findViewById(R.id.player_view);
        ImageButton close = findViewById(R.id.btn_close);
        ImageButton fsBtn = findViewById(R.id.btn_fullscreen);
        ImageButton rotBtn = findViewById(R.id.btn_rotate);

        close.setOnClickListener(v -> finish());
        fsBtn.setOnClickListener(v -> toggleImmersive());
        rotBtn.setOnClickListener(v -> {
            landscapeForced = !landscapeForced;
            setRequestedOrientation(landscapeForced
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
            statusView.setText(landscapeForced ? "Landscape lock · rotate freely with sensor off" : "Rotation unlocked");
        });

        // Double-tap player area also toggles immersive
        playerView.setOnClickListener(v -> {
            // single tap handled by controller; long path via button
        });

        String title = getIntent().getStringExtra(EXTRA_TITLE);
        if (title == null || title.isEmpty()) title = "Now playing";
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

        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", referer);
        headers.put("Origin", "https://animeheaven.me");
        headers.put(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 "
                        + "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
        );
        headers.put("Accept", "*/*");

        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(headers)
                .setConnectTimeoutMs(20000)
                .setReadTimeoutMs(30000)
                .setAllowCrossProtocolRedirects(true)
                .setUserAgent(headers.get("User-Agent"));

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
                .build();
        playerView.setPlayer(player);
        playerView.setControllerHideOnTouch(true);
        playerView.setControllerShowTimeoutMs(3000);
        playerView.setFullscreenButtonClickListener(isFull -> toggleImmersive());

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    statusView.setText("Buffering…");
                } else if (state == Player.STATE_READY) {
                    statusView.setText("Playing in Grey GodZilla · rotate phone for landscape");
                } else if (state == Player.STATE_ENDED) {
                    statusView.setText("Episode finished.");
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                urlIndex++;
                if (urlIndex < urls.size()) {
                    statusView.setText("Retrying source " + (urlIndex + 1) + "/" + urls.size() + "…");
                    playCurrent();
                } else {
                    statusView.setText("Stream failed. Close and try another episode.");
                }
            }
        });

        playCurrent();
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

    private void playCurrent() {
        if (player == null || urlIndex >= urls.size()) return;
        String url = urls.get(urlIndex);
        statusView.setText("Loading source " + (urlIndex + 1) + "/" + urls.size() + "…");
        MediaItem item = MediaItem.fromUri(Uri.parse(url));
        player.setMediaItem(item);
        player.prepare();
        player.play();
    }

    @Override
    public void onBackPressed() {
        if (immersive) {
            toggleImmersive();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (player != null) player.pause();
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
