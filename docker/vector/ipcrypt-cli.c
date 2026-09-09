/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Copyright (C) 2026 The Gremion Authors
 *
 * Links against libipcrypt2 (ISC, Copyright (c) 2025-2026 Frank Denis), whose
 * notice is reproduced in the repository's NOTICE file and copied into this
 * image at /usr/share/doc/ipcrypt2/LICENSE.
 */
/*
 * ipcrypt-cli.c — minimal CLI wrapper around libipcrypt2.
 *
 * Upstream ipcrypt-std/ipcrypt2 ships ONLY the static library
 * (libipcrypt2.a) — it has no command-line tool. The Vector log
 * pipeline (process-logs.sh) needs an `ipcrypt nd-encrypt` command to
 * pseudonymise client IPs, so we build this thin wrapper into the image.
 *
 * Usage:
 *   ipcrypt nd-encrypt
 *     Reads one IP address per line from stdin, writes the ipcrypt-nd
 *     (non-deterministic) encrypted form — one hex string per line — to
 *     stdout. The 16-byte key is read as hex from the IPCRYPT_KEY env var.
 *     A fresh 8-byte random tweak is drawn from /dev/urandom per address.
 *
 * Exit: 0 on success; 1 on key/crypto/IO error; 2 on usage error.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "ipcrypt2.h"

/* Decode a hex string into out[]. Non-hex chars (whitespace, CR/LF) are
 * skipped. Returns the number of bytes decoded, or -1 on an odd digit count
 * or overflow. */
static int hex_decode(const char *hex, uint8_t *out, size_t outlen)
{
    size_t n = 0;
    int    hi = -1;

    for (const char *p = hex; *p != '\0'; p++) {
        int v;
        if (*p >= '0' && *p <= '9') {
            v = *p - '0';
        } else if (*p >= 'a' && *p <= 'f') {
            v = *p - 'a' + 10;
        } else if (*p >= 'A' && *p <= 'F') {
            v = *p - 'A' + 10;
        } else {
            continue; /* skip whitespace / newlines */
        }
        if (hi < 0) {
            hi = v;
        } else {
            if (n >= outlen) {
                return -1;
            }
            out[n++] = (uint8_t) ((hi << 4) | v);
            hi = -1;
        }
    }
    if (hi >= 0) {
        return -1; /* dangling nibble — odd number of hex digits */
    }
    return (int) n;
}

int main(int argc, char **argv)
{
    if (argc != 2 || strcmp(argv[1], "nd-encrypt") != 0) {
        fprintf(stderr,
                "usage: ipcrypt nd-encrypt  "
                "(one IP per line on stdin; 16-byte hex key in $IPCRYPT_KEY)\n");
        return 2;
    }

    const char *key_hex = getenv("IPCRYPT_KEY");
    if (key_hex == NULL || key_hex[0] == '\0') {
        fprintf(stderr, "ipcrypt: IPCRYPT_KEY environment variable is not set\n");
        return 1;
    }

    uint8_t key[IPCRYPT_KEYBYTES];
    if (hex_decode(key_hex, key, sizeof key) != (int) sizeof key) {
        fprintf(stderr,
                "ipcrypt: IPCRYPT_KEY must decode to exactly %u bytes (%u hex digits)\n",
                IPCRYPT_KEYBYTES, IPCRYPT_KEYBYTES * 2U);
        return 1;
    }

    FILE *rnd = fopen("/dev/urandom", "rb");
    if (rnd == NULL) {
        fprintf(stderr, "ipcrypt: cannot open /dev/urandom\n");
        return 1;
    }

    IPCrypt ctx;
    ipcrypt_init(&ctx, key);

    int  rc = 0;
    char line[IPCRYPT_MAX_IP_STR_BYTES + 2U];

    while (fgets(line, (int) sizeof line, stdin) != NULL) {
        /* Strip trailing newline / CR / blanks. */
        size_t len = strlen(line);
        while (len > 0 &&
               (line[len - 1] == '\n' || line[len - 1] == '\r' ||
                line[len - 1] == ' '  || line[len - 1] == '\t')) {
            line[--len] = '\0';
        }
        if (len == 0) {
            continue;
        }

        uint8_t tweak[IPCRYPT_TWEAKBYTES];
        if (fread(tweak, 1U, sizeof tweak, rnd) != sizeof tweak) {
            fprintf(stderr, "ipcrypt: failed to read random tweak\n");
            rc = 1;
            break;
        }

        char   encrypted[IPCRYPT_NDIP_STR_BYTES];
        size_t n = ipcrypt_nd_encrypt_ip_str(&ctx, encrypted, line, tweak);
        if (n == 0) {
            fprintf(stderr, "ipcrypt: not a valid IP address: '%s'\n", line);
            rc = 1;
            break;
        }
        puts(encrypted);
    }

    ipcrypt_deinit(&ctx);
    fclose(rnd);
    return rc;
}
