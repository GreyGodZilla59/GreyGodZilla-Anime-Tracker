package com.greygodzilla.animetracker;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

/**
 * In-app fallback player: WebView of AnimeHeaven with Grey GodZilla chrome.
 * Does NOT open Chrome or leave the app process.
 */
public class EpisodeWebViewActivity extends AppCompatActivity {
    private WebView webView;
    private static final String AH = "https://animeheaven.me";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0a0a0a"));
        root.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // Top bar — keep branding so it feels like our app
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#141414"));
        bar.setPadding(16, 24, 16, 16);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        root.addView(bar, barLp);

        ImageButton close = new ImageButton(this);
        close.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setColorFilter(Color.parseColor("#f5f5f5"));
        close.setOnClickListener(v -> finish());
        bar.addView(close, new LinearLayout.LayoutParams(96, 96));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setPadding(16, 0, 0, 0);
        TextView brand = new TextView(this);
        brand.setText("Grey GodZilla · in-app");
        brand.setTextColor(Color.parseColor("#ff6a00"));
        brand.setTextSize(12f);
        TextView title = new TextView(this);
        String t = getIntent().getStringExtra("title");
        title.setText(t != null && !t.isEmpty() ? t : "Watch");
        title.setTextColor(Color.parseColor("#f5f5f5"));
        title.setTextSize(15f);
        title.setMaxLines(1);
        titles.addView(brand);
        titles.addView(title);
        bar.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(UA);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        String gateHash = getIntent().getStringExtra("gateHash");
        String showUrl = getIntent().getStringExtra("url");
        String target;

        if (gateHash != null && !gateHash.trim().isEmpty()) {
            String key = gateHash.trim();
            cookies.setCookie(AH, "key=" + key + "; Path=/");
            cookies.setCookie(AH + "/", "key=" + key + "; Path=/");
            cookies.flush();
            target = AH + "/gate.php";
        } else if (showUrl != null && !showUrl.trim().isEmpty()) {
            target = showUrl.trim();
        } else {
            target = AH + "/";
        }

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.loadUrl(target);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
