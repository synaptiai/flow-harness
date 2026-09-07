#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

/* Fixed test processes, not a proxy, application or observer implementation.
 * Only the helper role waits for the two relay controls it inherits across
 * Bash exec. Relays cannot finish before that exec: they await a bounded,
 * synthetic helper-ready handshake in the test-owned current directory. */
int main(int argc, char **argv) {
    pid_t parent = getppid();
    if (parent <= 1) return 90;
#ifdef __linux__
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) return 91;
#endif
    alarm(4);
    int fd3 = fcntl(3, F_GETFD) >= 0;
    int fd4 = fcntl(4, F_GETFD) >= 0;
    int other = 0;
    DIR *inventory = opendir("/dev/fd");
    if (inventory == NULL) return 92;
    int inventory_fd = dirfd(inventory);
    struct dirent *entry;
    int entries = 0;
    for (;;) {
        errno = 0;
        entry = readdir(inventory);
        if (entry == NULL) { if (errno != 0) return 93; break; }
        if (++entries > 4096) return 93;
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        char *end;
        long fd = strtol(entry->d_name, &end, 10);
        if (errno != 0 || *end != '\0' || end == entry->d_name || fd < 0 || fd > INT_MAX) return 93;
        if (fd <= 4 || fd == inventory_fd) continue;
        if (fcntl((int)fd, F_GETFD) < 0) return 93;
        other++;
    }
    if (closedir(inventory) != 0) return 93;
    struct stat third = {0}, fourth = {0};
    if ((fd3 && fstat(3, &third) != 0) || (fd4 && fstat(4, &fourth) != 0)) return 94;
    const char *role;
    int helper = 0;
    int argument_count = 0, argument_bytes = 0;
    if (argc == 3 && strcmp(argv[1], "TCP-LISTEN:3128,fork,reuseaddr") == 0 && strncmp(argv[2], "UNIX-CONNECT:/", 14) == 0) role = "relay3128";
    else if (argc == 3 && strcmp(argv[1], "TCP-LISTEN:1080,fork,reuseaddr") == 0 && strncmp(argv[2], "UNIX-CONNECT:/", 14) == 0) role = "relay1080";
    else if ((argc == 6 || argc == 69) && strcmp(argv[1], "--flow-observer-v1") == 0 && strlen(argv[2]) == 64 && strcmp(argv[3], "--") == 0 && strcmp(argv[4], "/observer-test/application-not-executed") == 0) {
        if (argc == 6 && strcmp(argv[5], "2") != 0) return 95;
        for (int argument = 5; argument < argc; argument++) {
            size_t length = strlen(argv[argument]);
            if (argc == 69) {
                if (length != 512) return 95;
                for (size_t byte = 0; byte < length; byte++) if (argv[argument][byte] != '\'') return 95;
            }
            argument_count++;
            argument_bytes += (int)length;
        }
        role = "helper";
        helper = 1;
    } else return 95;

    int reaped = 0;
    if (helper) {
        int ready = open("helper-ready", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
        if (ready < 0 || close(ready) != 0) return 96;
        for (;;) {
            int status;
            pid_t child = waitpid(-1, &status, 0);
            if (child < 0 && errno == EINTR) continue;
            if (child < 0 && errno == ECHILD) break;
            if (child < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 97;
            if (++reaped > 2) return 98;
        }
        if (reaped != 2) return 99;
    }

    char path[32];
    char report[512];
    int path_length = snprintf(path, sizeof(path), "%s.json", role);
    int length = snprintf(report, sizeof(report), "{\"role\":\"%s\",\"fd3\":%s,\"fd4\":%s,\"other\":%d,\"dev3\":\"%ju\",\"ino3\":\"%ju\",\"dev4\":\"%ju\",\"ino4\":\"%ju\",\"reaped\":%d,\"argumentCount\":%d,\"argumentBytes\":%d}\n", role, fd3 ? "true" : "false", fd4 ? "true" : "false", other, (uintmax_t)third.st_dev, (uintmax_t)third.st_ino, (uintmax_t)fourth.st_dev, (uintmax_t)fourth.st_ino, reaped, argument_count, argument_bytes);
    if (path_length < 0 || (size_t)path_length >= sizeof(path) || length < 0 || (size_t)length >= sizeof(report)) return 100;
    int output = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (output < 0) return 101;
    ssize_t written = write(output, report, (size_t)length);
    int closed = close(output);
    if (written != length || closed != 0) return 102;
    if (!helper) {
        struct stat ready;
        const struct timespec pause = { .tv_sec = 0, .tv_nsec = 1000000 };
        while (lstat("helper-ready", &ready) != 0) {
            if (errno != ENOENT || getppid() != parent) return 103;
            if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return 104;
        }
        if (!S_ISREG(ready.st_mode) || getppid() != parent) return 105;
    }
    return 0;
}
