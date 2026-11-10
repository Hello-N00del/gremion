<?php
/**
 * Gremion pilot -- Nextcloud custom configuration.
 *
 * Copied into the image at /usr/src/nextcloud/config/ and so into
 * /var/www/html/config/ on the first start (docker/nextcloud/Dockerfile). Loaded
 * after config.php on every request. Every value that differs per host arrives as
 * an environment variable from docker-compose.yml; this file holds no host name,
 * address or secret.
 */

$CONFIG = [

    // Redis: memory cache, distributed cache and file locking.
    'memcache.local'       => '\OC\Memcache\Redis',
    'memcache.distributed' => '\OC\Memcache\Redis',
    'memcache.locking'     => '\OC\Memcache\Redis',
    'redis' => [
        'host'     => getenv('REDIS_HOST')          ?: 'nextcloud-redis',
        'port'     => (int)(getenv('REDIS_PORT')    ?: 6379),
        'password' => getenv('REDIS_HOST_PASSWORD') ?: '',
        'timeout'  => 1.5,
    ],

    // No public router reaches Nextcloud: gremion-ui and Collabora call it by its
    // in-network name, so every URL it generates is that name over http.
    // 'overwritehost' is what getCollaboraEditorUrl's server-side fetch needs; a
    // before-starting hook (pin-overwrite-host.sh) re-asserts both host keys on
    // every start, because this file reaches a persistent volume only on the first
    // install.
    'overwritehost'     => getenv('NEXTCLOUD_OVERWRITEHOST')    ?: '',
    'overwritewebroot'  => getenv('NEXTCLOUD_OVERWRITEWEBROOT')  ?: '',
    'overwriteprotocol' => getenv('NEXTCLOUD_OVERWRITEPROTOCOL') ?: '',
    'overwrite.cli.url' => getenv('NEXTCLOUD_OVERWRITECLIURL')   ?: '',

    // Trust only the state network's own subnet (docker-compose.yml). The fallback
    // covers Docker's bridge range for a bare run of the image.
    'trusted_proxies' => array_filter(
        explode(',', getenv('NEXTCLOUD_TRUSTED_PROXIES') ?: '172.16.0.0/12')
    ),

    // Regional defaults.
    'default_phone_region' => 'DE',
    'default_locale'       => 'de_DE',
    'default_language'     => 'de',

    // Hardening. Do NOT set 'passwordsalt' or 'secret' here: Nextcloud generates
    // them into config.php on the first install, and an empty value in this file
    // would override the generated one and cause 500s.
    'auth.bruteforce.protection.enabled' => true,
    'updatechecker'      => false,
    'updater.server.url' => '',

    // Sign-in is the user_oidc app, registered per customer realm by
    // `gremion-services wire <slug>` (infra/host/bin/gremion-services); its
    // provider lives in the database, not here.
    'allow_user_to_change_display_name' => false,

    'integrity.check.disabled' => false,

    // Preview generation limits.
    'preview_max_x'           => 2048,
    'preview_max_y'           => 2048,
    'jpeg_quality'            => 80,
    'enabledPreviewProviders' => [
        'OC\Preview\PNG',
        'OC\Preview\JPEG',
        'OC\Preview\GIF',
        'OC\Preview\BMP',
        'OC\Preview\XBitmap',
        'OC\Preview\MP3',
        'OC\Preview\TXT',
        'OC\Preview\MarkDown',
        'OC\Preview\PDF',
    ],
];
