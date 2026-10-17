package io.github.adityatakuli.flowlabs;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * FlowLabs for Android: the FlowLabs web app in a WebView.
 *
 * The app and Python (Pyodide with pandas and scikit-learn) are served from the APK's assets at
 * https://appassets.androidplatform.net/, a secure origin, so models train on the phone with no
 * internet. Users can also connect to a `flowlabs engine` on their computer to use its GPU.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int PICK_FILE = 42;
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("zip", "application/zip");
        TYPES.put("whl", "application/zip");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("woff", "font/woff");
        TYPES.put("txt", "text/plain");
        TYPES.put("map", "application/json");
    }

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(7, 8, 10));
        getWindow().setNavigationBarColor(Color.rgb(10, 11, 14));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(7, 8, 10));
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // lets the app reach an engine on the local network (http://192.168.x.x:8899)
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "FlowLabsAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                return HOST.equals(url.getHost()) ? asset(url.getPath()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url)); // e.g. the GitHub link
                } catch (Exception ignored) {
                    // no browser installed
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) {
                    pendingPick.onReceiveValue(null);
                }
                pendingPick = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a file"), PICK_FILE);
                } catch (Exception error) {
                    pendingPick = null;
                    return false;
                }
                return true;
            }
        });
        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(START);
        }
    }

    private WebResourceResponse asset(String path) {
        String name = (path == null || path.equals("/") || path.isEmpty()) ? "index.html" : path.substring(1);
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        String type = TYPES.containsKey(extension) ? TYPES.get(extension) : "application/octet-stream";
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", name.equals("index.html") ? "no-cache" : "max-age=31536000");
        try {
            InputStream stream = getAssets().open("www/" + name);
            return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, stream);
        } catch (IOException missing) {
            if (!name.contains(".")) { // an app route: serve the app
                return asset("/index.html");
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                    new ByteArrayInputStream(new byte[0]));
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && pendingPick != null) {
            pendingPick.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            pendingPick = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    /** Called from the web app: exports and scored files are saved to Downloads. */
    private class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime) {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FlowLabs");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) {
                        return "error: could not create the file";
                    }
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                    where = "Downloads/FlowLabs/" + safe;
                } else {
                    File folder = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File file = new File(folder, safe);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(bytes);
                    }
                    where = file.getAbsolutePath();
                }
                final String message = "Saved to " + where;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show());
                return where;
            } catch (Exception error) {
                return "error: " + error.getMessage();
            }
        }
    }
}
