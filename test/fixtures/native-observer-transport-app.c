#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

/* Fixed static Linux application, not an observer or a descriptor custodian.
 * Enumerate the real entry descriptors, excluding only our inventory directory.
 * No candidate code, startup file, network or external command is loaded. */
int main(void) {
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
    static const char marker[] = "flow-observer-fixed-application-exit-7\n";
    if (write(STDOUT_FILENO, marker, sizeof(marker) - 1) != (ssize_t)(sizeof(marker) - 1))
        return 98;
    return 7;
}
