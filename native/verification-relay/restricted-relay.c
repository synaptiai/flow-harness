/* SPDX-License-Identifier: Apache-2.0 OR MIT
 * Copyright 2026 Synapti.ai
 * See restricted-relay.LICENSE for the wrapper-only license grant.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <netdb.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "host-bridge-ipv4-loopback-v1 requires Linux x64"
#endif

extern char **environ;
extern int __real_main(int argc, const char *argv[]);
extern int __real_getaddrinfo(const char *, const char *, const struct addrinfo *,
                              struct addrinfo **);

/* Each invocation and its forked connection children retain the admitted port. */
static char admitted_port[6];

static int reject(const char *message) {
    size_t remaining = strlen(message);
    while (remaining != 0) {
        ssize_t written = write(STDERR_FILENO, message, remaining);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return 74;
        message += written;
        remaining -= (size_t)written;
    }
    return 64;
}

static int valid_listener(const char *argument) {
    static const char prefix[] = "UNIX-LISTEN:";
    static const char suffix[] = ",fork,reuseaddr";
    const size_t prefix_size = sizeof(prefix) - 1;
    const size_t suffix_size = sizeof(suffix) - 1;
    const size_t length = strnlen(argument, 256);
    if (length >= 256 || length <= prefix_size + suffix_size ||
        memcmp(argument, prefix, prefix_size) != 0 ||
        memcmp(argument + length - suffix_size, suffix, suffix_size) != 0) return 0;
    const size_t path_size = length - prefix_size - suffix_size;
    const char *path = argument + prefix_size;
    if (path[0] != '/' || path_size >= sizeof(((struct sockaddr_un *)0)->sun_path)) return 0;
    /* Do not interpret socat quoting, escaping, dual addresses, or extra options.
       This lexical gate is separate from future directory/socket custody. */
    for (size_t i = 0; i < path_size; ++i) {
        const unsigned char c = (unsigned char)path[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '/' || c == '.' || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static int admit_destination(const char *argument) {
    static const char prefix[] = "TCP:localhost:";
    static const char suffix[] = ",keepalive,keepidle=10,keepintvl=5,keepcnt=3";
    if (strnlen(argument, 128) >= 128 ||
        strncmp(argument, prefix, sizeof(prefix) - 1) != 0) return 0;
    const char *port = argument + sizeof(prefix) - 1;
    if (*port < '1' || *port > '9') return 0;
    size_t length = 0;
    unsigned int value = 0;
    while (port[length] >= '0' && port[length] <= '9') {
        if (length == sizeof(admitted_port) - 1) return 0;
        value = value * 10 + (unsigned int)(port[length] - '0');
        ++length;
    }
    if (value > 65535 || strcmp(port + length, suffix) != 0) return 0;
    memcpy(admitted_port, port, length);
    admitted_port[length] = '\0';
    return 1;
}

static int valid_environment(void) {
    static const char *const required[] = {
        "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "TZ=UTC"
    };
    unsigned int seen = 0;
    if (environ == NULL) return 0;
    for (size_t i = 0; environ[i] != NULL; ++i) {
        if (i == 4 || strnlen(environ[i], 32) >= 32) return 0;
        unsigned int bit = 0;
        for (size_t key = 0; key < 4; ++key)
            if (strcmp(environ[i], required[key]) == 0) bit = 1U << key;
        if (bit == 0 || (seen & bit) != 0) return 0;
        seen |= bit;
    }
    return seen == 15;
}

int __wrap_main(int argc, const char *argv[]) {
    if (argc != 3 || argv == NULL || argv[0] == NULL || argv[0][0] == '\0' ||
        strnlen(argv[0], PATH_MAX) >= PATH_MAX || argv[1] == NULL || argv[2] == NULL ||
        !valid_listener(argv[1]) || !admit_destination(argv[2]))
        return reject("FLOW_RELAY_PROFILE_V1 invalid_arguments\n");
    if (!valid_environment()) return reject("FLOW_RELAY_PROFILE_V1 invalid_environment\n");
    return __real_main(argc, argv);
}

int __wrap_getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                       struct addrinfo **result) {
    if (result == NULL) return EAI_FAIL;
    *result = NULL;
    /* Match the actual fixed-command call, not a broader libc API surface.
       EAI_FAIL avoids socat's EAI_SOCKTYPE/EAI_SERVICE fallback branches. */
    if (admitted_port[0] == '\0' || node == NULL || strcmp(node, "localhost") != 0 ||
        service == NULL || strcmp(service, admitted_port) != 0 || hints == NULL ||
        hints->ai_flags != AI_ADDRCONFIG || hints->ai_family != AF_UNSPEC ||
        hints->ai_socktype != SOCK_STREAM || hints->ai_protocol != IPPROTO_TCP ||
        hints->ai_addrlen != 0 || hints->ai_addr != NULL || hints->ai_canonname != NULL ||
        hints->ai_next != NULL) return EAI_FAIL;
    const struct addrinfo numeric = {
        .ai_flags = AI_NUMERICHOST | AI_NUMERICSERV,
        .ai_family = AF_INET,
        .ai_socktype = SOCK_STREAM,
        .ai_protocol = IPPROTO_TCP,
    };
    return __real_getaddrinfo("127.0.0.1", admitted_port, &numeric, result);
}
