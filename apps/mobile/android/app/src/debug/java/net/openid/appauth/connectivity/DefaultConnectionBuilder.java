/*
 * DEV-ONLY CLASS SHADOW — overrides the library's DefaultConnectionBuilder.
 *
 * The upstream class rejects all non-HTTPS URLs, which prevents OIDC discovery
 * from reaching the local Keycloak server (http://10.0.2.2) during development.
 *
 * This file is in the same package as the library class; the Gradle/D8 toolchain
 * resolves app-level classes before library classes, so this version wins at runtime.
 *
 * IMPORTANT: This file must NEVER be shipped in a production APK.
 * For production, Keycloak must be behind HTTPS and this file must be removed.
 */
package net.openid.appauth.connectivity;

import android.net.Uri;
import androidx.annotation.NonNull;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Development-only replacement for AppAuth's DefaultConnectionBuilder.
 * Allows both HTTP and HTTPS connections (upstream only allows HTTPS).
 */
public class DefaultConnectionBuilder implements ConnectionBuilder {

    public static final DefaultConnectionBuilder INSTANCE = new DefaultConnectionBuilder();

    private DefaultConnectionBuilder() {}

    @NonNull
    @Override
    public HttpURLConnection openConnection(@NonNull Uri uri) throws IOException {
        // Intentionally allows HTTP for local dev (10.0.2.2).
        // Production builds must not include this class.
        return (HttpURLConnection) new URL(uri.toString()).openConnection();
    }
}
