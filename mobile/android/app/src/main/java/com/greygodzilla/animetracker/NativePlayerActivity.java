package com.greygodzilla.animetracker;

import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

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
 * Fully in-app player (stays inside Grey GodZilla).
 * Free Media3/ExoPlayer with custom Referer so AnimeHeaven CDN allows playback.
 */
public class NativePlayerActivity extends AppCompatActivity {
    public static final String EXTRA_URLS = "urls";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_TITLE = "title";

    private ExoPlayer player;
    private TextView statusView;
    private ArrayList<String> urls = new ArrayList<>();
    private int urlIndex = 0;
    private String referer = "https://animeheaven.me/";

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_native_player);

        TextView titleView = findViewById(R.id.player_title);
        statusView = findViewById(R.id.player_status);
        PlayerView playerView = findViewById(R.id.player_view);
        ImageButton close = findViewById(R.id.btn_close);
        close.setOnClickListener(v -> finish());

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

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    statusView.setText("Buffering…");
                } else if (state == Player.STATE_READY) {
                    statusView.setText("Playing in Grey GodZilla · free in-app stream");
                } else if (state == Player.STATE_ENDED) {
                    statusView.setText("Episode finished.");
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                // Try next CDN mirror automatically
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
    protected void onStop() {
        super.onStop();
        if (player != null) {
            player.pause();
        }
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
