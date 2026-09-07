#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#if defined(__linux__) && defined(__x86_64__) && !defined(__ILP32__)
#include <sys/syscall.h>
#endif
#include <unistd.h>

/* Fixed static Linux application, not an observer or a descriptor custodian.
 * Enumerate the real entry descriptors, excluding only our inventory directory.
 * No candidate code, startup file, network or external command is loaded. */
static int clean_signal_state(void) {
#if defined(__linux__) && defined(__x86_64__) && !defined(__ILP32__)
    const int signals[] = {SIGTERM, SIGPIPE, SIGILL};
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i) {
        struct sigaction action;
        if (sigaction(signals[i], NULL, &action) != 0 || action.sa_handler != SIG_DFL) return -1;
    }
    uint64_t mask = 0;
    return syscall(SYS_rt_sigprocmask, SIG_SETMASK, NULL, &mask, sizeof(mask)) == 0 &&
        mask == 0 ? 0 : -1;
#else
    return -1; // Only Linux x64 can qualify the raw 64-bit kernel mask.
#endif
}

int main(int argc, char **argv) {
    alarm(2);
    for (int fd = 3; fd <= 4; ++fd) {
        errno = 0;
        if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 90;
    }
    DIR *directory = opendir("/proc/self/fd");
    if (directory == NULL) return 91;
    const int inventory_fd = dirfd(directory);
    if (inventory_fd < 0) return 92;
    unsigned int entries = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) {
            if (errno != 0) return 93;
            break;
        }
        if (++entries > 4096) return 94;
        if (entry->d_name[0] == '.') continue;
        char *end = NULL;
        errno = 0;
        const long fd = strtol(entry->d_name, &end, 10);
        if (errno != 0 || end == entry->d_name || *end != '\0' || fd < 0 || fd > INT_MAX)
            return 95;
        if (fd > 2 && fd != inventory_fd) {
            errno = 0;
            const int descriptor_flags = fcntl((int)fd, F_GETFD);
            const int descriptor_errno = errno;
            struct stat metadata;
            errno = 0;
            const int stat_result = fstat((int)fd, &metadata);
            const int stat_errno = errno;
            const char *kind = stat_result != 0 ? "unavailable"
                : S_ISREG(metadata.st_mode) ? "regular"
                : S_ISDIR(metadata.st_mode) ? "directory"
                : S_ISFIFO(metadata.st_mode) ? "fifo"
                : S_ISSOCK(metadata.st_mode) ? "socket"
                : S_ISCHR(metadata.st_mode) ? "character" : "other";
            char diagnostic[256];
            const int length = snprintf(diagnostic, sizeof(diagnostic),
                "unexpected-fd=%ld inventory-fd=%d flags=%d fd-errno=%d kind=%s stat-errno=%d\n",
                fd, inventory_fd, descriptor_flags, descriptor_errno, kind, stat_errno);
            if (length > 0 && (size_t)length < sizeof(diagnostic))
                (void)!write(STDERR_FILENO, diagnostic, (size_t)length);
            return 96;
        }
    }
    if (closedir(directory) != 0) return 97;
    int exit_code = 7;
    int terminate = 0;
    if (argc == 3 && strcmp(argv[1], "--exit") == 0) {
        if (argv[2][0] == '\0' || (argv[2][0] == '0' && argv[2][1] != '\0')) return 99;
        unsigned int value = 0;
        for (const char *p = argv[2]; *p != '\0'; ++p) {
            if (*p < '0' || *p > '9' || value > 25) return 99;
            value = value * 10 + (unsigned int)(*p - '0');
        }
        if (value > 255) return 99;
        exit_code = (int)value;
    } else if (argc == 2 && strcmp(argv[1], "--signal-term") == 0) {
        terminate = 1;
    } else if (argc == 2 && strcmp(argv[1], "--signal-clean") == 0) {
        if (clean_signal_state() != 0) return 99;
    } else if (argc != 1) return 99;
    static const char marker[] = "flow-observer-fixed-application-exit-7\n";
    static const char parameterized_marker[] = "flow-observer-fixed-application-result\n";
    const char *output = argc == 1 ? marker : parameterized_marker;
    const size_t output_length = argc == 1 ? sizeof(marker) - 1 : sizeof(parameterized_marker) - 1;
    if (write(STDOUT_FILENO, output, output_length) != (ssize_t)output_length)
        return 98;
    if (terminate) {
        /* Actual signal delivery, not exit(128 + SIGTERM). */
        if (kill(getpid(), SIGTERM) != 0) return 99;
        return 99; /* Ignored/blocked signals must fail the signal qualification. */
    }
    return exit_code;
}
